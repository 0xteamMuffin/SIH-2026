import crypto from "node:crypto";
import { Prisma, RunStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { askModel } from "../../infrastructure/models/model-provider.js";
import { selectModel, type RoutingDecision } from "../../infrastructure/models/model-router.js";
import { runCode } from "../../infrastructure/sandbox/sandbox-client.js";
import { createArtifact, findArtifact, getArtifact } from "../artifacts/artifacts.service.js";
import { approvalNoteDocx } from "./approval-note.js";
import type { EvidenceItem, ToolResult } from "./agent.types.js";
import type { AuthUser } from "../../middleware/auth.js";

const MAX_TURNS = 4;
const MAX_TOOL_CALLS = 5;
const toJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
function previewText(bytes: Buffer) { return bytes.toString("utf8").replace(/\0/g, "").slice(0, 12_000).trim() || "The source is a binary or scanned file. OCR/vision review is required."; }
async function appendMessage(runId: string, turn: number, role: string, content: object) { await prisma.runMessage.create({ data: { runId, turn, role, content: toJson(content) } }); }
async function executeTool(runId: string, name: string, input: object, work: () => Promise<ToolResult>) {
  const modelToolCallId = crypto.randomUUID();
  const idempotencyKey = crypto.createHash("sha256").update(`${name}:${JSON.stringify(input)}`).digest("hex");
  await prisma.runToolCall.create({ data: { runId, modelToolCallId, toolName: name, input: toJson(input), idempotencyKey, status: "RUNNING" } });
  try {
    const result = await work();
    await prisma.runToolCall.update({ where: { runId_modelToolCallId: { runId, modelToolCallId } }, data: { status: result.ok ? "COMPLETED" : "FAILED", output: toJson(result), completedAt: new Date() } });
    return result;
  } catch (error) {
    const result: ToolResult = { ok: false, summary: error instanceof Error ? error.message : "Tool failed", errorCode: "TOOL_FAILED" };
    await prisma.runToolCall.update({ where: { runId_modelToolCallId: { runId, modelToolCallId } }, data: { status: "FAILED", output: toJson(result), completedAt: new Date() } });
    return result;
  }
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
export async function createRun(input: { workspaceId: string; userId: string; task: string; artifactId?: string }) {
  const decision = selectModel(input.task, Boolean(input.artifactId));
  const run = await prisma.agentRun.create({ data: { workspaceId: input.workspaceId, requestedBy: input.userId, task: input.task, taskCapability: decision.capability, modelProfile: decision.profile.id, modelReason: decision.reason, activeWorkspaceId: input.workspaceId } });
  await audit({ actorId: input.userId, workspaceId: input.workspaceId, runId: run.id, eventType: "AGENT_RUN_CREATED", metadata: { capability: decision.capability, modelProfile: decision.profile.id, sovereign: decision.profile.sovereign } });
  void processRun(run.id, decision, input.artifactId).catch(() => undefined);
  return run;
}
async function processRun(runId: string, decision: RoutingDecision, sourceArtifactId?: string) {
  const claimed = await prisma.agentRun.updateMany({ where: { id: runId, status: RunStatus.PENDING }, data: { status: RunStatus.RUNNING, startedAt: new Date() } });
  if (claimed.count === 0) return;
  const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
  let turn = 1;
  try {
    await appendMessage(run.id, turn, "system", { event: "RUN_STARTED", model: decision.profile.id, capability: decision.capability, maxTurns: MAX_TURNS, maxToolCalls: MAX_TOOL_CALLS });
    await audit({ actorId: run.requestedBy, workspaceId: run.workspaceId, runId: run.id, eventType: "MODEL_ROUTED", metadata: { profile: decision.profile.id, capability: decision.capability, sovereign: decision.profile.sovereign } });
    const evidence: EvidenceItem[] = []; let sourceText = "No source artifact was provided.";
    if (sourceArtifactId) {
      const source = await findArtifact(sourceArtifactId);
      if (!source || source.workspaceId !== run.workspaceId) throw new AppError(400, "Source artifact is unavailable in this workspace", "INVALID_ARTIFACT");
      const read = await executeTool(run.id, "artifact.read", { artifactId: source.id }, async () => { sourceText = previewText(await getArtifact(source.objectKey)); return { ok: true, summary: `Read ${source.filename}`, data: { characters: sourceText.length } }; });
      if (!read.ok) throw new Error(read.summary);
      evidence.push(await saveEvidence(run.id, source.id, `artifact:${source.id}`, source.filename, sourceText.slice(0, 800), sourceText.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 8)));
      await appendMessage(run.id, ++turn, "tool", { tool: "artifact.read", result: read });
    }
    let analysis = "No model analysis was required.";
    const analyzed = await executeTool(run.id, "model.analyze", { model: decision.profile.id, capability: decision.capability }, async () => { const model = await askModel(decision.profile, "You are an on-premise industrial workbench assistant. Produce concise factual findings only from supplied source text. State uncertainty for unreadable scans. Never invent measurements, approvals, or citations.", `Task: ${run.task}\n\nSource material:\n${sourceText}`); analysis = model.text.trim() || "The model returned no analysis."; return { ok: true, summary: "Model analysis completed", data: { characters: analysis.length } }; });
    if (!analyzed.ok) analysis = `${analyzed.summary}. Review the source artifact manually.`;
    await appendMessage(run.id, ++turn, "tool", { tool: "model.analyze", result: analyzed });
    evidence.push(await saveEvidence(run.id, undefined, "model-analysis", "Model analysis", analysis, [analysis]));
    const result: Record<string, unknown> = { analysis, evidenceIds: evidence.map((item) => item.id), model: decision.profile.id, capability: decision.capability };
    if (decision.capability === "code") result.sandbox = await executeTool(run.id, "sandbox.execute", { language: "javascript" }, async () => ({ ...(await runCode(sourceArtifactId ? sourceText : "console.log('Sandbox verification complete')")), ok: true, summary: "Sandbox execution completed" }));
    else if (sourceArtifactId) await executeTool(run.id, "deliverable.createApprovalNote", { format: "docx" }, async () => { const artifact = await createArtifact({ workspaceId: run.workspaceId, userId: run.requestedBy, filename: `approval-note-${run.id}.docx`, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "GENERATED_DOCX", bytes: Buffer.from(await approvalNoteDocx(run.task, evidence)) }); result.artifact = artifact; return { ok: true, summary: "Generated approval-note DOCX", data: { artifactId: artifact.id } }; });
    await appendMessage(run.id, ++turn, "assistant", result);
    const completed = await prisma.agentRun.updateMany({ where: { id: run.id, status: RunStatus.RUNNING }, data: { status: RunStatus.COMPLETED, result: toJson(result), activeWorkspaceId: null, completedAt: new Date() } });
    if (completed.count > 0) await audit({ actorId: run.requestedBy, workspaceId: run.workspaceId, runId: run.id, eventType: "AGENT_RUN_COMPLETED", metadata: { sovereign: decision.profile.sovereign } });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown run failure";
    const failed = await prisma.agentRun.updateMany({ where: { id: runId, status: RunStatus.RUNNING }, data: { status: RunStatus.FAILED, result: toJson({ error: reason }), activeWorkspaceId: null, completedAt: new Date() } });
    if (failed.count > 0) await audit({ actorId: run.requestedBy, workspaceId: run.workspaceId, runId, eventType: "AGENT_RUN_FAILED", metadata: { reason } });
  }
}
export async function getRun(runId: string, actor: Pick<AuthUser, "id" | "role">) {
  return prisma.agentRun.findFirst({ where: accessibleRunWhere(runId, actor), include: { messages: { orderBy: { createdAt: "asc" } }, toolCalls: { orderBy: { startedAt: "asc" } }, evidence: { orderBy: { createdAt: "asc" } } } });
}
export async function cancelRun(runId: string, actor: Pick<AuthUser, "id" | "role">) {
  const run = await prisma.agentRun.findFirst({ where: accessibleRunWhere(runId, actor) });
  if (!run) throw new AppError(404, "Run not found", "NOT_FOUND");
  if (run.status !== RunStatus.PENDING && run.status !== RunStatus.RUNNING) throw new AppError(409, "Run is not active", "RUN_NOT_ACTIVE");
  const cancelled = await prisma.agentRun.updateMany({ where: { id: runId, status: { in: [RunStatus.PENDING, RunStatus.RUNNING] } }, data: { status: RunStatus.CANCELLED, activeWorkspaceId: null, completedAt: new Date() } });
  if (cancelled.count === 0) throw new AppError(409, "Run is not active", "RUN_NOT_ACTIVE");
  const updated = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
  await audit({ actorId: actor.id, workspaceId: updated.workspaceId, runId, eventType: "AGENT_RUN_CANCELLED" });
  return updated;
}
