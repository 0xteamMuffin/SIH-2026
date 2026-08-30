import crypto from "node:crypto";
import { ApprovalStatus, ArtifactExtractionStatus, ArtifactKind, ArtifactLifecycleStatus, DataClassification, EvidenceKind, Prisma, RunStatus, RunToolCallStatus, ToolRiskLevel, UserRole } from "@prisma/client";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { mostRestrictiveClassification } from "../../lib/data-classification.js";
import { invokeModelWithFallbacks } from "../../infrastructure/models/model-orchestrator.js";
import type { ModelImageInput, VisionImageMimeType } from "../../infrastructure/models/model-provider.js";
import { renderPdfPages } from "../../infrastructure/pdf-renderer/pdf-renderer-client.js";
import { eligibleRoutingDecision, routingDecisionForPersistedRun, selectModel } from "../../infrastructure/models/model-router.js";
import { runCode } from "../../infrastructure/sandbox/sandbox-client.js";
import { AGENT_RUN_CANCELLED_TOPIC, AGENT_RUN_REQUESTED_TOPIC } from "../../infrastructure/queue/agent-run-message.js";
import { createArtifact, findArtifact, getArtifactBounded } from "../artifacts/artifacts.service.js";
import { extractArtifact } from "../artifacts/artifact-extraction.service.js";
import { approvalNoteDocx } from "./approval-note.js";
import { codeRepairMessages, modelMessages } from "./agent-prompts.js";
import { parseGeneratedCode, sandboxToolResult, type EvidenceItem, type GeneratedCode, type ToolResult } from "./agent.types.js";
import { presentationInput, selectDeliverableFormat, spreadsheetInput } from "./agent-deliverables.js";
import { generatePptx, PPTX_MIME_TYPE } from "../deliverables/pptx-generator.js";
import { generateXlsx, XLSX_MIME_TYPE } from "../deliverables/xlsx-generator.js";
import type { AuthUser } from "../../middleware/auth.js";
import { isAgentToolName, registeredTool, toolRequiresApproval, validateToolInput, validateToolOutput, type AgentToolName } from "./agent-tool-registry.js";
import { beginTurn, nextPhase, progressEvent, runtimeState, type AgentRuntimeState, type ModelTokenBudget } from "./agent-runtime.js";
import { pauseForToolApproval, RunWaitingForApproval } from "./agent-approval.service.js";
import { searchAgentKnowledge, type KnowledgeSearchCitation } from "./agent-knowledge-search.js";

const MAX_SOURCE_CHARS = 12_000;
const EXTRACTION_VERSION = "canonical-v1";
const DIRECT_VISION_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
const CREATE_ADMISSION_LOCK_ID = 1_397_311_489;
const EXECUTION_ADMISSION_LOCK_ID = 1_397_311_490;
const toJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const configuredTokenBudget = (): ModelTokenBudget => ({
  maxInputTokens: env.AGENT_MAX_INPUT_TOKENS,
  maxOutputTokens: env.AGENT_MAX_OUTPUT_TOKENS,
  maxTotalTokens: env.AGENT_MAX_TOTAL_TOKENS,
});
const isTerminalModelError = (error: unknown): error is AppError => error instanceof AppError
  && ["RUN_TOKEN_BUDGET_EXCEEDED", "RUN_TOKEN_USAGE_UNAVAILABLE"].includes(error.code);
async function appendMessage(runId: string, turn: number, role: string, content: object) { await prisma.runMessage.create({ data: { runId, turn, role, content: toJson(content) } }); }
type ToolExecutionOptions = { workspaceId: string; leaseId: string; maxToolCalls: number };
export async function executeRunTool(runId: string, name: string, input: object, work: (persistedInput: object) => Promise<ToolResult>, signal?: AbortSignal, options?: ToolExecutionOptions) {
  const validatedInput = isAgentToolName(name) ? validateToolInput(name, input) : input;
  const definition = isAgentToolName(name) ? registeredTool(name) : undefined;
  const riskLevel = definition?.risk ?? ToolRiskLevel.LOW;
  const idempotencyKey = crypto.createHash("sha256").update(`${name}:${JSON.stringify(validatedInput)}`).digest("hex");
  const existing = await prisma.runToolCall.findUnique({ where: { runId_idempotencyKey: { runId, idempotencyKey } } });
  if (existing?.status === RunToolCallStatus.COMPLETED && existing.output) {
    return (isAgentToolName(name) ? validateToolOutput(name, existing.output) : existing.output) as ToolResult;
  }
  let persistedInput = existing
    ? (isAgentToolName(name) ? validateToolInput(name, existing.input) as object : existing.input as object)
    : validatedInput as object;
  if (existing?.status === RunToolCallStatus.WAITING_APPROVAL) {
    const approval = await prisma.toolApproval.findUnique({ where: { toolCallId: existing.id } });
    if (!approval || approval.status === ApprovalStatus.PENDING) throw new RunWaitingForApproval(approval?.id ?? "unknown");
    if (approval.status !== ApprovalStatus.APPROVED) {
      const denied: ToolResult = { ok: false, summary: "Tool execution was rejected by a reviewer", errorCode: "TOOL_APPROVAL_REJECTED" };
      await prisma.runToolCall.updateMany({ where: { id: existing.id, status: RunToolCallStatus.WAITING_APPROVAL }, data: { status: RunToolCallStatus.REJECTED, output: toJson(denied), completedAt: new Date() } });
      return denied;
    }
  }
  const modelToolCallId = existing?.modelToolCallId ?? crypto.randomUUID();
  if (existing) {
    const restarted = await prisma.runToolCall.updateMany({ where: { runId, modelToolCallId, status: { in: [RunToolCallStatus.PENDING, RunToolCallStatus.RUNNING, RunToolCallStatus.FAILED, RunToolCallStatus.WAITING_APPROVAL] } }, data: { status: RunToolCallStatus.RUNNING, startedAt: new Date(), completedAt: null } });
    if (restarted.count === 0) {
      const completed = await prisma.runToolCall.findUnique({ where: { runId_idempotencyKey: { runId, idempotencyKey } } });
      if (completed?.status === RunToolCallStatus.COMPLETED && completed.output) {
        return (isAgentToolName(name) ? validateToolOutput(name, completed.output) : completed.output) as ToolResult;
      }
      throw new Error(`Completed tool result '${name}' is unavailable`);
    }
  } else {
    if (options) {
      const count = await prisma.runToolCall.count({ where: { runId } });
      if (count >= options.maxToolCalls) throw new AppError(422, "Agent run tool-call limit exceeded", "RUN_TOOL_CALL_LIMIT_EXCEEDED");
    }
    if (definition && toolRequiresApproval(name as AgentToolName)) {
      if (!options) throw new Error(`Tool '${name}' requires an approval-aware execution context`);
      const approval = await pauseForToolApproval({ runId, workspaceId: options.workspaceId, leaseId: options.leaseId, modelToolCallId, idempotencyKey, toolName: name, toolInput: validatedInput, riskLevel });
      throw new RunWaitingForApproval(approval.id);
    }
    await prisma.runToolCall.create({ data: { runId, modelToolCallId, toolName: name, input: toJson(validatedInput), idempotencyKey, riskLevel, status: RunToolCallStatus.RUNNING } });
  }
  try {
    signal?.throwIfAborted();
    const rawResult = await work(persistedInput);
    const result = (isAgentToolName(name) ? validateToolOutput(name, rawResult) : rawResult) as ToolResult;
    await prisma.runToolCall.update({ where: { runId_modelToolCallId: { runId, modelToolCallId } }, data: { status: result.ok ? RunToolCallStatus.COMPLETED : RunToolCallStatus.FAILED, output: toJson(result), completedAt: new Date() } });
    return result;
  } catch (error) {
    const result: ToolResult = { ok: false, summary: error instanceof Error ? error.message : "Tool failed", errorCode: error instanceof AppError ? error.code : "TOOL_FAILED" };
    await prisma.runToolCall.updateMany({ where: { runId, modelToolCallId, status: RunToolCallStatus.RUNNING }, data: { status: RunToolCallStatus.FAILED, output: toJson(result), completedAt: new Date() } });
    if (signal?.aborted || isTerminalModelError(error)) throw error;
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
async function saveEvidence(runId: string, kind: EvidenceKind, artifactId: string | undefined, sourceRef: string, title: string, summary: string, facts: string[]): Promise<EvidenceItem> {
  const existing = await prisma.evidence.findFirst({ where: { runId, sourceRef, kind } });
  const item = existing ?? await prisma.evidence.create({ data: { runId, kind, artifactId, sourceRef, title, summary, facts: toJson(facts) } });
  return { id: item.id, sourceRef, title, summary, facts };
}
function knowledgePrompt(citations: KnowledgeSearchCitation[]) {
  return citations.map((citation, index) => `[K${index + 1}] ${citation.title}\nSource: ${citation.sourceRef}\n${citation.text}`).join("\n\n");
}
function accessibleRunWhere(runId: string, actor: Pick<AuthUser, "id" | "role">): Prisma.AgentRunWhereInput {
  return actor.role === "ADMIN"
    ? { id: runId }
    : { id: runId, workspace: { members: { some: { userId: actor.id } } } };
}
function mutableRunWhere(runId: string, actor: Pick<AuthUser, "id" | "role">): Prisma.AgentRunWhereInput {
  return actor.role === "ADMIN"
    ? { id: runId }
    : { id: runId, workspace: { members: { some: { userId: actor.id, role: { in: [UserRole.ADMIN, UserRole.OPERATOR] } } } } };
}
export async function createRun(input: { workspaceId: string; userId: string; task: string; dataClassification: DataClassification; artifactId?: string }) {
  let classification = input.dataClassification;
  if (input.artifactId) {
    const source = await findArtifact(input.artifactId);
    if (!source || source.workspaceId !== input.workspaceId || source.lifecycleStatus !== ArtifactLifecycleStatus.ACTIVE) throw new AppError(400, "Source artifact is unavailable in this workspace", "INVALID_ARTIFACT");
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
  const tokenBudget = configuredTokenBudget();
  const run = await prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT pg_advisory_xact_lock(${CREATE_ADMISSION_LOCK_ID})::text`;
    if (input.artifactId) {
      const available = await transaction.artifact.findFirst({ where: { id: input.artifactId, workspaceId: input.workspaceId, lifecycleStatus: ArtifactLifecycleStatus.ACTIVE }, select: { id: true } });
      if (!available) throw new AppError(400, "Source artifact is unavailable in this workspace", "INVALID_ARTIFACT");
    }
    const workspaceActiveRuns = await transaction.agentRun.count({ where: { activeWorkspaceId: input.workspaceId } });
    if (workspaceActiveRuns >= 1) throw new AppError(409, "Workspace already has an active agent run", "WORKSPACE_RUN_CONCURRENCY_LIMIT_EXCEEDED");
    const userActiveRuns = await transaction.agentRun.count({ where: { requestedBy: input.userId, activeWorkspaceId: { not: null } } });
    if (userActiveRuns >= env.AGENT_MAX_CONCURRENT_RUNS_PER_USER) throw new AppError(429, "User concurrent agent-run limit exceeded", "USER_RUN_CONCURRENCY_LIMIT_EXCEEDED");
    const created = await transaction.agentRun.create({ data: { id: runId, workspaceId: input.workspaceId, requestedBy: input.userId, task: input.task, dataClassification: classification, taskCapability: decision.capability, modelProfile: decision.profile.id, modelReason: decision.reason, sourceArtifactId: input.artifactId, activeWorkspaceId: input.workspaceId, maxTurns: env.AGENT_MAX_TURNS, maxToolCalls: env.AGENT_MAX_TOOL_CALLS, deadlineAt: new Date(Date.now() + env.AGENT_RUN_DEADLINE_MS), state: { version: 1, phase: "SOURCE", turn: 0, phaseStarted: false, tokenBudget } } });
    await transaction.outboxEvent.create({ data: { topic: AGENT_RUN_REQUESTED_TOPIC, aggregateId: runId, payload: toJson({ runId }) } });
    return created;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  await audit({ actorId: input.userId, workspaceId: input.workspaceId, runId: run.id, eventType: "AGENT_RUN_CREATED", metadata: { capability: decision.capability, classification, modelProfile: decision.profile.id, sovereign: decision.profile.sovereign } });
  return run;
}
export async function processRun(runId: string, cancellationSignal?: AbortSignal) {
  const persistedRun = await prisma.agentRun.findUnique({ where: { id: runId } });
  if (!persistedRun || persistedRun.status !== RunStatus.PENDING) return;
  const persistedDeadline = persistedRun.deadlineAt ?? new Date(Date.now() + env.AGENT_RUN_DEADLINE_MS);
  if (persistedDeadline <= new Date()) {
    await prisma.agentRun.updateMany({
      where: { id: runId, status: RunStatus.PENDING },
      data: { status: RunStatus.FAILED, result: toJson({ error: "Agent run execution deadline exceeded", code: "RUN_DEADLINE_EXCEEDED" }), activeWorkspaceId: null, completedAt: new Date() },
    });
    return;
  }
  cancellationSignal?.throwIfAborted();
  const decision = routingDecisionForPersistedRun(persistedRun);
  const leaseId = crypto.randomUUID();
  const startedAt = new Date();
  const claimed = await prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT pg_advisory_xact_lock(${EXECUTION_ADMISSION_LOCK_ID})`;
    const activeRuns = await transaction.agentRun.count({ where: { status: RunStatus.RUNNING } });
    if (activeRuns >= env.QUEUE_PREFETCH) {
      await transaction.outboxEvent.create({
        data: { topic: AGENT_RUN_REQUESTED_TOPIC, aggregateId: runId, payload: toJson({ runId }), availableAt: new Date(Date.now() + env.QUEUE_RETRY_DELAY_MS) },
      });
      return false;
    }
    const transition = await transaction.agentRun.updateMany({
      where: { id: runId, status: RunStatus.PENDING },
      data: { status: RunStatus.RUNNING, startedAt, leaseId, heartbeatAt: startedAt, leaseExpiresAt: new Date(startedAt.getTime() + env.RUN_LEASE_DURATION_MS) },
    });
    return transition.count > 0;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  if (!claimed) return;
  const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
  const leaseController = new AbortController();
  const deadlineAt = run.deadlineAt ?? persistedDeadline;
  const deadlineSignal = AbortSignal.timeout(Math.max(1, deadlineAt.getTime() - Date.now()));
  const signal = AbortSignal.any([...(cancellationSignal ? [cancellationSignal] : []), leaseController.signal, deadlineSignal]);
  const stopHeartbeat = startRunHeartbeat(runId, leaseId, leaseController);
  const sourceArtifactId = run.sourceArtifactId ?? undefined;
  const maxTurns = run.maxTurns ?? env.AGENT_MAX_TURNS;
  const maxToolCalls = run.maxToolCalls ?? env.AGENT_MAX_TOOL_CALLS;
  const toolOptions = { workspaceId: run.workspaceId, leaseId, maxToolCalls };
  let state = runtimeState(run.state, configuredTokenBudget());
  const startPhase = async (phase: AgentRuntimeState["phase"], summary: string) => {
    if (state.phase !== phase) return false;
    const wasStarted = state.phaseStarted;
    state = beginTurn(state, maxTurns, deadlineAt);
    const saved = await prisma.agentRun.updateMany({ where: { id: run.id, status: RunStatus.RUNNING, leaseId }, data: { state: toJson(state) } });
    if (saved.count === 0) throw new Error("Agent run lease was lost");
    if (!wasStarted) await appendMessage(run.id, state.turn, "system", progressEvent(state, summary));
    return true;
  };
  const finishPhase = async () => {
    state = nextPhase(state);
    const saved = await prisma.agentRun.updateMany({ where: { id: run.id, status: RunStatus.RUNNING, leaseId }, data: { state: toJson(state) } });
    if (saved.count === 0) throw new Error("Agent run lease was lost");
  };
  try {
    signal.throwIfAborted();
    if (state.turn === 0) {
      await appendMessage(run.id, 0, "system", { event: "RUN_STARTED", model: decision.profile.id, capability: decision.capability, maxTurns, maxToolCalls, tokenBudget: state.tokenBudget, deadlineAt: deadlineAt.toISOString() });
      await audit({ actorId: run.requestedBy, workspaceId: run.workspaceId, runId: run.id, eventType: "MODEL_ROUTED", metadata: { profile: decision.profile.id, capability: decision.capability, sovereign: decision.profile.sovereign } });
    }
    const evidence: EvidenceItem[] = [];
    let sourceText: string | undefined;
    let modelImages: ModelImageInput[] = [];
    let visionInput: Record<string, unknown> | undefined;
    let sourceLimitation: string | undefined;
    const searchesKnowledge = decision.capability === "document" || decision.capability === "general";
    const sourcePhase = await startPhase("SOURCE", sourceArtifactId ? "Reading source artifact and searching knowledge" : searchesKnowledge ? "Searching workspace knowledge" : "No source artifact to read");
    if (sourceArtifactId) {
      const source = await findArtifact(sourceArtifactId);
      if (!source || source.workspaceId !== run.workspaceId) throw new AppError(400, "Source artifact is unavailable in this workspace", "INVALID_ARTIFACT");
      const sourceMimeType = source.detectedMimeType;
      if (!sourceMimeType) throw new AppError(422, "Source artifact has no validated MIME type", "SOURCE_MIME_UNVALIDATED");
      if (decision.capability === "vision") {
        const limitations: string[] = [];
        let evidenceSummary: string;
        if (DIRECT_VISION_IMAGE_MIME_TYPES.includes(sourceMimeType as typeof DIRECT_VISION_IMAGE_MIME_TYPES[number])) {
          const sizeBytes = Number(source.sizeBytes);
          if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > env.VISION_MAX_IMAGE_BYTES) {
            throw new AppError(413, `Image must contain between 1 and ${env.VISION_MAX_IMAGE_BYTES} bytes`, "VISION_IMAGE_TOO_LARGE");
          }
          const bytes = await getArtifactBounded(source.objectKey, env.VISION_MAX_IMAGE_BYTES, signal);
          modelImages = [{ mimeType: sourceMimeType as VisionImageMimeType, bytes }];
          visionInput = { mode: "original-image", sourceMimeType, sizeBytes: bytes.byteLength };
          evidenceSummary = `Original ${sourceMimeType} source supplied directly to the vision model.`;
        } else if (sourceMimeType === "application/pdf") {
          const sizeBytes = Number(source.sizeBytes);
          if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > env.PDF_RENDER_MAX_SOURCE_BYTES) {
            throw new AppError(413, `PDF must contain between 1 and ${env.PDF_RENDER_MAX_SOURCE_BYTES} bytes`, "PDF_SOURCE_TOO_LARGE");
          }
          const pdfBytes = await getArtifactBounded(source.objectKey, env.PDF_RENDER_MAX_SOURCE_BYTES, signal);
          const rendered = await renderPdfPages(pdfBytes, signal);
          modelImages = rendered.pages.map((page) => ({ mimeType: "image/png", bytes: page.bytes }));
          const renderedPageNumbers = rendered.pages.map((page) => page.pageNumber).join(", ");
          limitations.push(`Rendered PDF pages supplied in order: ${renderedPageNumbers} of ${rendered.sourcePageCount}. Do not claim visual inspection of pages that were not supplied.`);
          visionInput = {
            mode: "rendered-pdf-pages",
            sourceMimeType,
            sourcePageCount: rendered.sourcePageCount,
            selectionPolicy: rendered.selectionPolicy,
            renderer: rendered.renderer,
            rendererVersion: rendered.rendererVersion,
            dpi: rendered.dpi,
            totalBytes: rendered.totalBytes,
            renderedPages: rendered.pages.map(({ pageNumber, width, height, sizeBytes: renderedSizeBytes }) => ({ pageNumber, width, height, sizeBytes: renderedSizeBytes })),
          };
          evidenceSummary = `Rendered PDF pages ${renderedPageNumbers} of ${rendered.sourcePageCount} were supplied to the vision model.`;
        } else if (sourceMimeType === "image/tiff") {
          throw new AppError(415, "TIFF images require conversion before OpenAI-compatible vision inference; no conversion is currently implemented", "VISION_PROVIDER_MIME_UNSUPPORTED");
        } else {
          throw new AppError(415, `Validated source MIME type '${sourceMimeType}' is not supported for vision inference`, "VISION_SOURCE_MIME_UNSUPPORTED");
        }

        let extractionStatus = "unavailable";
        if (source.extractionStatus === ArtifactExtractionStatus.COMPLETED) {
          const read = await executeRunTool(run.id, "artifact.read", { artifactId: source.id, extractionVersion: EXTRACTION_VERSION }, async () => {
            const extraction = await extractArtifact(source.id, signal);
            sourceText = extraction.text.slice(0, MAX_SOURCE_CHARS);
            return { ok: true, summary: `Read completed extraction for ${source.filename}`, data: { characters: sourceText.length, text: sourceText } };
          }, signal, toolOptions);
          if (read.ok && typeof read.data?.text === "string") {
            sourceText = read.data.text;
            extractionStatus = "completed";
          } else {
            limitations.push(`Completed deterministic text extraction could not be read${read.errorCode ? ` (${read.errorCode})` : ""}.`);
          }
          if (sourcePhase) await appendMessage(run.id, state.turn, "tool", { tool: "artifact.read", status: read.ok ? "completed" : "failed", summary: read.summary });
        } else {
          limitations.push("No completed deterministic text extraction was available; visual findings are not OCR-grounded.");
        }
        sourceLimitation = limitations.join(" ");
        visionInput = { ...visionInput, textExtraction: { status: extractionStatus, artifactStatus: source.extractionStatus }, limitations };
        evidence.push(await saveEvidence(
          run.id,
          EvidenceKind.SOURCE,
          source.id,
          `artifact:${source.id}`,
          source.filename,
          sourceText?.slice(0, 800) ?? `${evidenceSummary} ${sourceLimitation}`.trim(),
          sourceText?.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 8) ?? [],
        ));
      } else {
        const read = await executeRunTool(run.id, "artifact.read", { artifactId: source.id, extractionVersion: EXTRACTION_VERSION }, async () => {
          const extraction = await extractArtifact(source.id, signal);
          sourceText = extraction.text.slice(0, MAX_SOURCE_CHARS);
          return { ok: true, summary: `Extracted ${source.filename}`, data: { characters: sourceText.length, text: sourceText } };
        }, signal, toolOptions);
        if (!read.ok) throw new AppError(502, read.summary, read.errorCode ?? "ARTIFACT_READ_FAILED");
        if (typeof read.data?.text === "string") sourceText = read.data.text;
        if (sourceText === undefined) throw new Error("Artifact read completed without source text");
        evidence.push(await saveEvidence(run.id, EvidenceKind.SOURCE, source.id, `artifact:${source.id}`, source.filename, sourceText.slice(0, 800), sourceText.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 8)));
        if (sourcePhase) await appendMessage(run.id, state.turn, "tool", { tool: "artifact.read", status: "completed", summary: read.summary });
      }
    }
    if (searchesKnowledge) {
      const searched = await executeRunTool(run.id, "knowledge.search", { query: run.task }, async (persistedToolInput) => {
        const searchInput = validateToolInput("knowledge.search", persistedToolInput);
        const citations = await searchAgentKnowledge({ workspaceId: run.workspaceId, classification: run.dataClassification, query: searchInput.query, signal });
        return { ok: true, summary: citations.length > 0 ? `Retrieved ${citations.length} knowledge citation(s)` : "No relevant knowledge citations found", data: { citations } };
      }, signal, toolOptions);
      if (!searched.ok) throw new Error(searched.summary);
      const citations = (searched.data?.citations ?? []) as KnowledgeSearchCitation[];
      for (const citation of citations) {
        evidence.push(await saveEvidence(run.id, EvidenceKind.SOURCE, citation.artifactId, citation.sourceRef, citation.title, citation.text.slice(0, 800), [citation.text]));
      }
      if (citations.length > 0) sourceText = [sourceText, knowledgePrompt(citations)].filter(Boolean).join("\n\nRetrieved knowledge citations:\n");
      if (sourcePhase) await appendMessage(run.id, state.turn, "tool", { tool: "knowledge.search", status: "completed", summary: searched.summary });
    }
    if (sourcePhase) await finishPhase();
    let analysis = "No model analysis was required.";
    let generatedCode: GeneratedCode | undefined;
    let selectedProfile = decision.profile;
    const messages = modelMessages(run.task, decision.capability, sourceText, sourceLimitation);
    const analyzePhase = await startPhase("ANALYZE", "Producing bounded model output");
    const analyzed = await executeRunTool(run.id, "model.analyze", { model: decision.profile.id, capability: decision.capability }, async () => {
      const selected = await invokeModelWithFallbacks({ runId: run.id, decision, classification: run.dataClassification, ...messages, images: modelImages, signal, tokenBudget: state.tokenBudget });
      selectedProfile = selected.profile;
      if (decision.capability === "code") {
        try {
          generatedCode = parseGeneratedCode(selected.response.text);
        } catch {
          const repaired = await invokeModelWithFallbacks({
            runId: run.id,
            decision: { ...decision, profile: selectedProfile },
            classification: run.dataClassification,
            ...codeRepairMessages(run.task, selected.response.text, sourceText, sourceLimitation),
            signal,
            tokenBudget: state.tokenBudget,
          });
          selectedProfile = repaired.profile;
          generatedCode = parseGeneratedCode(repaired.response.text);
        }
        analysis = generatedCode.explanation;
        return { ok: true, summary: "Generated code validated", data: { characters: generatedCode.code.length, analysis, generatedCode, modelProfile: selectedProfile.id } };
      }
      analysis = selected.response.text.trim() || "The model returned no analysis.";
      return { ok: true, summary: "Model analysis completed", data: { characters: analysis.length, analysis, modelProfile: selectedProfile.id } };
    }, signal, toolOptions);
    if (!analyzed.ok) throw new Error(analyzed.summary);
    if (typeof analyzed.data?.analysis === "string") analysis = analyzed.data.analysis;
    if (decision.capability === "code") generatedCode = parseGeneratedCode(JSON.stringify(analyzed.data?.generatedCode));
    if (typeof analyzed.data?.modelProfile === "string") {
      selectedProfile = [decision.profile, ...decision.fallbacks].find((profile) => profile.id === analyzed.data?.modelProfile) ?? selectedProfile;
    }
    if (selectedProfile.id !== run.modelProfile) {
      await prisma.agentRun.updateMany({
        where: { id: run.id, status: RunStatus.RUNNING, leaseId },
        data: { modelProfile: selectedProfile.id, modelReason: `${decision.reason} Profile '${selectedProfile.id}' completed the model invocation.` },
      });
    }
    if (analyzePhase) await appendMessage(run.id, state.turn, "tool", { tool: "model.analyze", status: "completed", summary: analyzed.summary });
    evidence.push(await saveEvidence(run.id, EvidenceKind.MODEL_OUTPUT, undefined, "model-analysis", "Model output", analysis, [analysis]));
    if (analyzePhase) await finishPhase();
    const sourceEvidence = evidence.filter((item) => item.sourceRef.startsWith("artifact:"));
    const result: Record<string, unknown> = {
      analysis,
      sourceEvidenceIds: sourceEvidence.map((item) => item.id),
      modelOutputEvidenceIds: evidence.filter((item) => item.sourceRef === "model-analysis").map((item) => item.id),
      model: selectedProfile.id,
      capability: decision.capability,
    };
    if (visionInput) result.visionInput = visionInput;
    const actionPhase = await startPhase("ACTION", decision.capability === "code" ? "Requesting or executing sandbox action" : "Creating requested deliverable");
    if (decision.capability === "code") {
      if (!generatedCode) throw new Error("Validated generated code is unavailable");
      const persisted = await executeRunTool(run.id, "code.persistOutput", generatedCode, async (persistedToolInput) => {
        const output = parseGeneratedCode(JSON.stringify(persistedToolInput));
        signal.throwIfAborted();
        const extension = output.language === "python" ? "py" : "js";
        const mimeType = output.language === "python" ? "text/x-python" : "text/javascript";
        const artifact = await createArtifact({
          workspaceId: run.workspaceId,
          userId: run.requestedBy,
          filename: `generated-code-${run.id}.${extension}`,
          mimeType,
          kind: "CODE_OUTPUT",
          classification: run.dataClassification,
          bytes: Buffer.from(output.code, "utf8"),
          idempotencyKey: `run-${run.id}-code-output`,
        });
        return { ok: true, summary: "Persisted generated code", data: { artifactId: artifact.id } };
      }, signal, toolOptions);
      if (!persisted.ok || typeof persisted.data?.artifactId !== "string") throw new Error(persisted.summary);
      result.codeArtifactId = persisted.data.artifactId;
      result.generatedCode = { language: generatedCode.language, explanation: generatedCode.explanation };
      const sandbox = await executeRunTool(run.id, "sandbox.execute", { language: generatedCode.language, code: generatedCode.code }, async (approvedInput) => {
        const approved = validateToolInput("sandbox.execute", approvedInput);
        const execution = await runCode(approved.code, approved.language, signal);
        return sandboxToolResult(execution);
      }, signal, toolOptions);
      result.sandbox = sandbox;
      if (sandbox.errorCode === "SANDBOX_NON_ZERO_EXIT") throw new AppError(422, sandbox.summary, sandbox.errorCode);
    } else if (sourceEvidence.length > 0 && (sourceArtifactId || decision.capability === "document")) {
      const evidenceIds = sourceEvidence.map((item) => item.id);
      const format = selectDeliverableFormat(run.task);
      const toolName = format === "pptx" ? "deliverable.createPresentation" : format === "xlsx" ? "deliverable.createSpreadsheet" : "deliverable.createApprovalNote";
      const toolInput = format === "docx" ? { format } : { format, evidenceIds };
      const delivered = await executeRunTool(run.id, toolName, toolInput, async () => {
        signal.throwIfAborted();
        const output = format === "pptx"
          ? { bytes: await generatePptx(presentationInput(run.task, analysis, sourceEvidence)), filename: `presentation-${run.id}.pptx`, mimeType: PPTX_MIME_TYPE, summary: "Generated cited PPTX" }
          : format === "xlsx"
            ? { bytes: await generateXlsx(spreadsheetInput(run.task, analysis, sourceEvidence)), filename: `workbook-${run.id}.xlsx`, mimeType: XLSX_MIME_TYPE, summary: "Generated cited XLSX" }
            : { bytes: Buffer.from(await approvalNoteDocx(run.task, sourceEvidence)), filename: `approval-note-${run.id}.docx`, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", summary: "Generated approval-note DOCX" };
        signal.throwIfAborted();
        const kind = format === "pptx" ? ArtifactKind.GENERATED_PPTX : format === "xlsx" ? ArtifactKind.GENERATED_XLSX : ArtifactKind.GENERATED_DOCX;
        const artifact = await createArtifact({ workspaceId: run.workspaceId, userId: run.requestedBy, filename: output.filename, mimeType: output.mimeType, kind, classification: run.dataClassification, bytes: output.bytes, idempotencyKey: `run-${run.id}-${format}` });
        result.artifact = artifact;
        return { ok: true, summary: output.summary, data: { artifactId: artifact.id } };
      }, signal, toolOptions);
      const artifactId = delivered.data?.artifactId;
      if (typeof artifactId === "string" && !result.artifact) {
        const artifact = await findArtifact(artifactId);
        if (artifact) result.artifact = { ...artifact, sizeBytes: Number(artifact.sizeBytes) };
      }
    }
    if (actionPhase) await finishPhase();
    await startPhase("FINALIZE", "Finalizing run result");
    signal.throwIfAborted();
    await appendMessage(run.id, state.turn, "assistant", result);
    const completed = await prisma.agentRun.updateMany({ where: { id: run.id, status: RunStatus.RUNNING, leaseId }, data: { status: RunStatus.COMPLETED, result: toJson(result), activeWorkspaceId: null, leaseId: null, heartbeatAt: null, leaseExpiresAt: null, completedAt: new Date() } });
    if (completed.count > 0) await audit({ actorId: run.requestedBy, workspaceId: run.workspaceId, runId: run.id, eventType: "AGENT_RUN_COMPLETED", metadata: { sovereign: selectedProfile.sovereign } });
  } catch (error) {
    if (error instanceof RunWaitingForApproval) {
      await audit({ actorId: run.requestedBy, workspaceId: run.workspaceId, runId, eventType: "TOOL_APPROVAL_REQUESTED", metadata: { approvalId: error.approvalId } });
      return;
    }
    const reason = error instanceof Error ? error.message : "Unknown run failure";
    if (isTerminalModelError(error)) {
      const failed = await prisma.agentRun.updateMany({
        where: { id: runId, status: RunStatus.RUNNING, leaseId },
        data: { status: RunStatus.FAILED, result: toJson({ error: reason, code: error.code }), activeWorkspaceId: null, leaseId: null, heartbeatAt: null, leaseExpiresAt: null, completedAt: new Date() },
      });
      if (failed.count > 0) await audit({ actorId: run.requestedBy, workspaceId: run.workspaceId, runId, eventType: "AGENT_RUN_FAILED", metadata: { reason, code: error.code, exhausted: false } });
      return;
    }
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
  return prisma.agentRun.findFirst({ where: accessibleRunWhere(runId, actor), include: { messages: { orderBy: { createdAt: "asc" } }, toolCalls: { orderBy: { startedAt: "asc" } }, approvals: { orderBy: { requestedAt: "asc" } }, modelInvocations: { orderBy: { attempt: "asc" } }, evidence: { orderBy: { createdAt: "asc" } } } });
}
export async function cancelRun(runId: string, actor: Pick<AuthUser, "id" | "role">) {
  const run = await prisma.agentRun.findFirst({ where: mutableRunWhere(runId, actor) });
  if (!run) throw new AppError(404, "Run not found", "NOT_FOUND");
  if (run.status === RunStatus.CANCELLED) return run;
  if (run.status !== RunStatus.PENDING && run.status !== RunStatus.RUNNING && run.status !== RunStatus.WAITING_APPROVAL) throw new AppError(409, "Run is not active", "RUN_NOT_ACTIVE");
  const cancelled = await prisma.$transaction(async (transaction) => {
    const transition = await transaction.agentRun.updateMany({ where: { id: runId, status: { in: [RunStatus.PENDING, RunStatus.RUNNING, RunStatus.WAITING_APPROVAL] } }, data: { status: RunStatus.CANCELLED, activeWorkspaceId: null, leaseId: null, heartbeatAt: null, leaseExpiresAt: null, completedAt: new Date() } });
    if (transition.count === 0) return false;
    await transaction.toolApproval.updateMany({ where: { runId, status: ApprovalStatus.PENDING }, data: { status: ApprovalStatus.CANCELLED } });
    await transaction.runToolCall.updateMany({ where: { runId, status: { in: [RunToolCallStatus.PENDING, RunToolCallStatus.RUNNING, RunToolCallStatus.WAITING_APPROVAL] } }, data: { status: RunToolCallStatus.CANCELLED, completedAt: new Date() } });
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
