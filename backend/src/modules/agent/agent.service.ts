import crypto from "node:crypto";
import { DataClassification, Prisma, RunStatus } from "@prisma/client";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { mostRestrictiveClassification } from "../../lib/data-classification.js";
import { invokeModelWithFallbacks } from "../../infrastructure/models/model-orchestrator.js";
import { eligibleRoutingDecision, routingDecisionForPersistedRun, selectModel } from "../../infrastructure/models/model-router.js";
import { runCode } from "../../infrastructure/sandbox/sandbox-client.js";
import { AGENT_RUN_CANCELLED_TOPIC, AGENT_RUN_REQUESTED_TOPIC } from "../../infrastructure/queue/agent-run-message.js";
import { createArtifact, findArtifact } from "../artifacts/artifacts.service.js";
import { extractArtifact } from "../artifacts/artifact-extraction.service.js";
import { approvalNoteDocx } from "./approval-note.js";
import { modelMessages } from "./agent-prompts.js";
import type { EvidenceItem, ToolResult } from "./agent.types.js";
import type { AuthUser } from "../../middleware/auth.js";

const MAX_TURNS = 4;
const MAX_TOOL_CALLS = 5;
const MAX_SOURCE_CHARS = 12_000;
const EXTRACTION_VERSION = "canonical-v1";
const toJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
async function appendMessage(runId: string, turn: number, role: string, content: object) { await prisma.runMessage.create({ data: { runId, turn, role, content: toJson(content) } }); }
export async function executeRunTool(runId: string, name: string, input: object, work: () => Promise<ToolResult>, signal?: AbortSignal) {
  const idempotencyKey = crypto.createHash("sha256").update(`${name}:${JSON.stringify(input)}`).digest("hex");
  const existing = await prisma.runToolCall.findUnique({ where: { runId_idempotencyKey: { runId, idempotencyKey } } });
  if (existing?.status === "COMPLETED" && existing.output) return existing.output as unknown as ToolResult;
  const modelToolCallId = existing?.modelToolCallId ?? crypto.randomUUID();
  if (existing) {
    const restarted = await prisma.runToolCall.updateMany({ where: { runId, modelToolCallId, status: { not: "COMPLETED" } }, data: { status: "RUNNING", startedAt: new Date(), completedAt: null } });
    if (restarted.count === 0) {
      const completed = await prisma.runToolCall.findUnique({ where: { runId_idempotencyKey: { runId, idempotencyKey } } });
      if (completed?.status === "COMPLETED" && completed.output) return completed.output as unknown as ToolResult;
      throw new Error(`Completed tool result '${name}' is unavailable`);
    }
  } else await prisma.runToolCall.create({ data: { runId, modelToolCallId, toolName: name, input: toJson(input), idempotencyKey, status: "RUNNING" } });
  try {
    signal?.throwIfAborted();
    const result = await work();
    await prisma.runToolCall.update({ where: { runId_modelToolCallId: { runId, modelToolCallId } }, data: { status: result.ok ? "COMPLETED" : "FAILED", output: toJson(result), completedAt: new Date() } });
    return result;
  } catch (error) {
    const result: ToolResult = { ok: false, summary: error instanceof Error ? error.message : "Tool failed", errorCode: "TOOL_FAILED" };
    await prisma.runToolCall.updateMany({ where: { runId, modelToolCallId, status: { not: "COMPLETED" } }, data: { status: "FAILED", output: toJson(result), completedAt: new Date() } });
    if (signal?.aborted) throw error;
    return result;
  }
}

function startRunHeartbeat(runId: string, leaseId: string, controller: AbortController) {
  let updating = false;
  const heartbeat = async () => {
    if (updating || controller.signal.aborted) return;
    updating = true;
    const now = new Date();
    try {
      const renewed = await prisma.agentRun.updateMany({
        where: { id: runId, status: RunStatus.RUNNING, leaseId },
        data: { heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + env.RUN_LEASE_DURATION_MS) },
      });
      if (renewed.count === 0) controller.abort(new Error("Agent run lease was lost"));
    } catch (error) {
      logger.warn({ error, runId }, "Agent run heartbeat failed");
    } finally {
      updating = false;
    }
  };
  const timer = setInterval(() => { void heartbeat(); }, env.RUN_HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
async function saveEvidence(runId: string, artifactId: string | undefined, sourceRef: string, title: string, summary: string, facts: string[]): Promise<EvidenceItem> {
  const item = await prisma.evidence.create({ data: { runId, artifactId, sourceRef, title, summary, facts: toJson(facts) } });
  return { id: item.id, sourceRef, title, summary, facts };
}
function accessibleRunWhere(runId: string, actor: Pick<AuthUser, "id" | "role">): Prisma.AgentRunWhereInput {
  return actor.role === "ADMIN"
    ? { id: runId }
    : { id: runId, workspace: { members: { some: { userId: actor.id } } } };
}
export async function createRun(input: { workspaceId: string; userId: string; task: string; dataClassification: DataClassification; artifactId?: string }) {
  let classification = input.dataClassification;
  if (input.artifactId) {
    const source = await findArtifact(input.artifactId);
    if (!source || source.workspaceId !== input.workspaceId) throw new AppError(400, "Source artifact is unavailable in this workspace", "INVALID_ARTIFACT");
    classification = mostRestrictiveClassification(classification, source.classification);
  }
  const configuredDecision = selectModel(input.task, Boolean(input.artifactId));
  let decision;
  try {
    decision = eligibleRoutingDecision(configuredDecision, classification);
  } catch (error) {
    if (configuredDecision.profile.location === "remote") {
      await audit({ actorId: input.userId, workspaceId: input.workspaceId, eventType: "EXTERNAL_INFERENCE_BLOCKED", metadata: { classification, modelProfile: configuredDecision.profile.id } });
      throw new AppError(422, "External inference is restricted to public or synthetic data", "EXTERNAL_INFERENCE_BLOCKED");
    }
    throw error;
  }
  const runId = crypto.randomUUID();
  const [run] = await prisma.$transaction([
    prisma.agentRun.create({ data: { id: runId, workspaceId: input.workspaceId, requestedBy: input.userId, task: input.task, dataClassification: classification, taskCapability: decision.capability, modelProfile: decision.profile.id, modelReason: decision.reason, sourceArtifactId: input.artifactId, activeWorkspaceId: input.workspaceId } }),
    prisma.outboxEvent.create({ data: { topic: AGENT_RUN_REQUESTED_TOPIC, aggregateId: runId, payload: toJson({ runId }) } }),
  ]);
  await audit({ actorId: input.userId, workspaceId: input.workspaceId, runId: run.id, eventType: "AGENT_RUN_CREATED", metadata: { capability: decision.capability, classification, modelProfile: decision.profile.id, sovereign: decision.profile.sovereign } });
  return run;
}
export async function processRun(runId: string, cancellationSignal?: AbortSignal) {
  const persistedRun = await prisma.agentRun.findUnique({ where: { id: runId } });
  if (!persistedRun || persistedRun.status !== RunStatus.PENDING) return;
  cancellationSignal?.throwIfAborted();
  const decision = routingDecisionForPersistedRun(persistedRun);
  const leaseId = crypto.randomUUID();
  const startedAt = new Date();
  const claimed = await prisma.agentRun.updateMany({
    where: { id: runId, status: RunStatus.PENDING },
    data: { status: RunStatus.RUNNING, startedAt, leaseId, heartbeatAt: startedAt, leaseExpiresAt: new Date(startedAt.getTime() + env.RUN_LEASE_DURATION_MS) },
  });
  if (claimed.count === 0) return;
  const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
  const leaseController = new AbortController();
  const signal = cancellationSignal ? AbortSignal.any([cancellationSignal, leaseController.signal]) : leaseController.signal;
  const stopHeartbeat = startRunHeartbeat(runId, leaseId, leaseController);
  const sourceArtifactId = run.sourceArtifactId ?? undefined;
  let turn = 1;
  try {
    signal.throwIfAborted();
    await appendMessage(run.id, turn, "system", { event: "RUN_STARTED", model: decision.profile.id, capability: decision.capability, maxTurns: MAX_TURNS, maxToolCalls: MAX_TOOL_CALLS });
    await audit({ actorId: run.requestedBy, workspaceId: run.workspaceId, runId: run.id, eventType: "MODEL_ROUTED", metadata: { profile: decision.profile.id, capability: decision.capability, sovereign: decision.profile.sovereign } });
    const evidence: EvidenceItem[] = []; let sourceText: string | undefined;
    if (sourceArtifactId) {
      const source = await findArtifact(sourceArtifactId);
      if (!source || source.workspaceId !== run.workspaceId) throw new AppError(400, "Source artifact is unavailable in this workspace", "INVALID_ARTIFACT");
      const read = await executeRunTool(run.id, "artifact.read", { artifactId: source.id, extractionVersion: EXTRACTION_VERSION }, async () => { const extraction = await extractArtifact(source.id, signal); sourceText = extraction.text.slice(0, MAX_SOURCE_CHARS); return { ok: true, summary: `Extracted ${source.filename}`, data: { characters: sourceText.length, text: sourceText } }; }, signal);
      if (!read.ok) throw new Error(read.summary);
      if (typeof read.data?.text === "string") sourceText = read.data.text;
      if (sourceText === undefined) throw new Error("Artifact read completed without source text");
      evidence.push(await saveEvidence(run.id, source.id, `artifact:${source.id}`, source.filename, sourceText.slice(0, 800), sourceText.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 8)));
      await appendMessage(run.id, ++turn, "tool", { tool: "artifact.read", result: read });
    }
    let analysis = "No model analysis was required.";
    let selectedProfile = decision.profile;
    const messages = modelMessages(run.task, decision.capability, sourceText);
    const analyzed = await executeRunTool(run.id, "model.analyze", { model: decision.profile.id, capability: decision.capability }, async () => {
      const selected = await invokeModelWithFallbacks({ runId: run.id, decision, classification: run.dataClassification, ...messages, signal });
      selectedProfile = selected.profile;
      analysis = selected.response.text.trim() || "The model returned no analysis.";
      return { ok: true, summary: "Model analysis completed", data: { characters: analysis.length, analysis, modelProfile: selectedProfile.id } };
    }, signal);
    if (!analyzed.ok) throw new Error(analyzed.summary);
    if (typeof analyzed.data?.analysis === "string") analysis = analyzed.data.analysis;
    if (typeof analyzed.data?.modelProfile === "string") {
      selectedProfile = [decision.profile, ...decision.fallbacks].find((profile) => profile.id === analyzed.data?.modelProfile) ?? selectedProfile;
    }
    if (selectedProfile.id !== run.modelProfile) {
      await prisma.agentRun.updateMany({
        where: { id: run.id, status: RunStatus.RUNNING, leaseId },
        data: { modelProfile: selectedProfile.id, modelReason: `${decision.reason} Profile '${selectedProfile.id}' completed the model invocation.` },
      });
    }
    await appendMessage(run.id, ++turn, "tool", { tool: "model.analyze", result: analyzed });
    evidence.push(await saveEvidence(run.id, undefined, "model-analysis", "Model analysis", analysis, [analysis]));
    const result: Record<string, unknown> = { analysis, evidenceIds: evidence.map((item) => item.id), model: selectedProfile.id, capability: decision.capability };
    if (decision.capability === "code") result.sandbox = await executeRunTool(run.id, "sandbox.execute", { language: "javascript" }, async () => ({ ...(await runCode(sourceArtifactId ? sourceText ?? "" : "console.log('Sandbox verification complete')", "javascript", signal)), ok: true, summary: "Sandbox execution completed" }), signal);
    else if (sourceArtifactId) {
      const delivered = await executeRunTool(run.id, "deliverable.createApprovalNote", { format: "docx" }, async () => { const artifact = await createArtifact({ workspaceId: run.workspaceId, userId: run.requestedBy, filename: `approval-note-${run.id}.docx`, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "GENERATED_DOCX", classification: run.dataClassification, bytes: Buffer.from(await approvalNoteDocx(run.task, evidence)), idempotencyKey: `run-${run.id}-approval-note` }); result.artifact = artifact; return { ok: true, summary: "Generated approval-note DOCX", data: { artifactId: artifact.id } }; }, signal);
      const artifactId = delivered.data?.artifactId;
      if (typeof artifactId === "string" && !result.artifact) {
        const artifact = await findArtifact(artifactId);
        if (artifact) result.artifact = { ...artifact, sizeBytes: Number(artifact.sizeBytes) };
      }
    }
    signal.throwIfAborted();
    await appendMessage(run.id, ++turn, "assistant", result);
    const completed = await prisma.agentRun.updateMany({ where: { id: run.id, status: RunStatus.RUNNING, leaseId }, data: { status: RunStatus.COMPLETED, result: toJson(result), activeWorkspaceId: null, leaseId: null, heartbeatAt: null, leaseExpiresAt: null, completedAt: new Date() } });
    if (completed.count > 0) await audit({ actorId: run.requestedBy, workspaceId: run.workspaceId, runId: run.id, eventType: "AGENT_RUN_COMPLETED", metadata: { sovereign: selectedProfile.sovereign } });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown run failure";
    const released = await prisma.agentRun.updateMany({ where: { id: runId, status: RunStatus.RUNNING, leaseId }, data: { status: RunStatus.PENDING, startedAt: null, leaseId: null, heartbeatAt: null, leaseExpiresAt: null } });
    if (released.count > 0) await audit({ actorId: run.requestedBy, workspaceId: run.workspaceId, runId, eventType: "AGENT_RUN_ATTEMPT_FAILED", metadata: { reason } });
    else if ((await prisma.agentRun.findUnique({ where: { id: runId }, select: { status: true } }))?.status === RunStatus.CANCELLED) return;
    throw error;
  } finally {
    stopHeartbeat();
  }
}
export async function failRun(runId: string, error: unknown) {
  const run = await prisma.agentRun.findUnique({ where: { id: runId } });
  if (!run || (run.status !== RunStatus.PENDING && run.status !== RunStatus.RUNNING)) return;
  const reason = error instanceof Error ? error.message : "Worker retries were exhausted";
  const failed = await prisma.agentRun.updateMany({ where: { id: runId, status: { in: [RunStatus.PENDING, RunStatus.RUNNING] } }, data: { status: RunStatus.FAILED, result: toJson({ error: reason }), activeWorkspaceId: null, leaseId: null, heartbeatAt: null, leaseExpiresAt: null, completedAt: new Date() } });
  if (failed.count > 0) await audit({ actorId: run.requestedBy, workspaceId: run.workspaceId, runId, eventType: "AGENT_RUN_FAILED", metadata: { reason, exhausted: true } });
}
export async function getRun(runId: string, actor: Pick<AuthUser, "id" | "role">) {
  return prisma.agentRun.findFirst({ where: accessibleRunWhere(runId, actor), include: { messages: { orderBy: { createdAt: "asc" } }, toolCalls: { orderBy: { startedAt: "asc" } }, modelInvocations: { orderBy: { attempt: "asc" } }, evidence: { orderBy: { createdAt: "asc" } } } });
}
export async function cancelRun(runId: string, actor: Pick<AuthUser, "id" | "role">) {
  const run = await prisma.agentRun.findFirst({ where: accessibleRunWhere(runId, actor) });
  if (!run) throw new AppError(404, "Run not found", "NOT_FOUND");
  if (run.status === RunStatus.CANCELLED) return run;
  if (run.status !== RunStatus.PENDING && run.status !== RunStatus.RUNNING) throw new AppError(409, "Run is not active", "RUN_NOT_ACTIVE");
  const cancelled = await prisma.$transaction(async (transaction) => {
    const transition = await transaction.agentRun.updateMany({ where: { id: runId, status: { in: [RunStatus.PENDING, RunStatus.RUNNING] } }, data: { status: RunStatus.CANCELLED, activeWorkspaceId: null, leaseId: null, heartbeatAt: null, leaseExpiresAt: null, completedAt: new Date() } });
    if (transition.count === 0) return false;
    await transaction.outboxEvent.create({ data: { topic: AGENT_RUN_CANCELLED_TOPIC, aggregateId: runId, payload: toJson({ runId }) } });
    return true;
  });
  if (!cancelled) {
    const current = await prisma.agentRun.findUnique({ where: { id: runId } });
    if (current?.status === RunStatus.CANCELLED) return current;
    throw new AppError(409, "Run is not active", "RUN_NOT_ACTIVE");
  }
  const updated = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
  await audit({ actorId: actor.id, workspaceId: updated.workspaceId, runId, eventType: "AGENT_RUN_CANCELLED" });
  return updated;
}
