import crypto from "node:crypto";
import { ApprovalStatus, ArtifactExtractionStatus, ArtifactKind, ArtifactLifecycleStatus, DataClassification, EvidenceKind, Prisma, RunStatus, RunToolCallStatus, ToolRiskLevel, UserRole } from "@prisma/client";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { mostRestrictiveClassification } from "../../lib/data-classification.js";
import { invokeModelWithFallbacks } from "../../infrastructure/models/model-orchestrator.js";
import type { ChatMessage, ModelImageInput, VisionImageMimeType } from "../../infrastructure/models/model-provider.js";
import { renderPdfPages } from "../../infrastructure/pdf-renderer/pdf-renderer-client.js";
import { eligibleRoutingDecision, requiredCapability, routeForTurn, selectModel, visionRequiredForSource, type ModelRequirements, type RoutingDecision } from "../../infrastructure/models/model-router.js";
import { AGENT_RUN_CANCELLED_TOPIC, AGENT_RUN_REQUESTED_TOPIC } from "../../infrastructure/queue/agent-run-message.js";
import { findArtifact, getArtifactBounded } from "../artifacts/artifacts.service.js";
import { extractArtifact } from "../artifacts/artifact-extraction.service.js";
import { loadConversationHistory } from "./conversation-history.js";
import type { EvidenceItem, ToolResult } from "./agent.types.js";
import type { AuthUser } from "../../middleware/auth.js";
import { isAgentToolName, registeredTool, toolRequiresApproval, validateToolInput, validateToolOutput, type AgentToolName } from "./agent-tool-registry.js";
import { assertWithinDeadline, progressEvent, runtimeState, type ModelTokenBudget } from "./agent-runtime.js";
import { pauseForToolApproval, RunWaitingForApproval } from "./agent-approval.service.js";
import { runAgentLoop } from "./agent-loop.js";
import { loopOpeningMessage, loopSystemPrompt, priorTurnMessages } from "./agent-loop-prompt.js";
import { createToolDispatcher } from "./agent-tool-handlers.js";

const MAX_SOURCE_CHARS = 12_000;
const EXTRACTION_VERSION = "canonical-v1";
const DIRECT_VISION_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
const CREATE_ADMISSION_LOCK_ID = 1_397_311_489;
const EXECUTION_ADMISSION_LOCK_ID = 1_397_311_490;
const runSummarySelect = {
  id: true,
  workspaceId: true,
  requestedBy: true,
  task: true,
  taskCapability: true,
  modelProfile: true,
  modelReason: true,
  sourceArtifactId: true,
  dataClassification: true,
  status: true,
  result: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AgentRunSelect;
export type RunCursor = { createdAt: Date; id: string };
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
export async function createRun(input: { workspaceId: string; userId: string; task: string; dataClassification: DataClassification; artifactId?: string; conversationId?: string }) {
  let classification = input.dataClassification;
  let sourceMimeType: string | undefined;
  if (input.artifactId) {
    const source = await findArtifact(input.artifactId);
    if (!source || source.workspaceId !== input.workspaceId || source.lifecycleStatus !== ArtifactLifecycleStatus.ACTIVE) throw new AppError(400, "Source artifact is unavailable in this workspace", "INVALID_ARTIFACT");
    classification = mostRestrictiveClassification(classification, source.classification);
    sourceMimeType = source.detectedMimeType ?? undefined;
  }
  // What the work needs is read off the input, not off the request text. Only
  // an attachment's media type is knowable this early; extraction can reveal a
  // scan later, and the run re-routes when it does.
  const requirements: ModelRequirements = {
    vision: sourceMimeType !== undefined && visionRequiredForSource({ mimeType: sourceMimeType }),
    tools: true,
  };
  const configuredDecision = selectModel(requirements);
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
    const created = await transaction.agentRun.create({ data: { id: runId, workspaceId: input.workspaceId, requestedBy: input.userId, task: input.task, dataClassification: classification, taskCapability: decision.capability, modelProfile: decision.profile.id, modelReason: decision.reason, sourceArtifactId: input.artifactId, conversationId: input.conversationId ?? null, activeWorkspaceId: input.workspaceId, maxTurns: env.AGENT_MAX_TURNS, maxToolCalls: env.AGENT_MAX_TOOL_CALLS, deadlineAt: new Date(Date.now() + env.AGENT_RUN_DEADLINE_MS), state: { version: 2, iteration: 0, tokenBudget } } });
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
  // Requirements start from what admission knew and are refined once the run
  // can see its own input. Routing is then redone per turn, so a need
  // discovered mid-run takes effect on the next call.
  let requirements: ModelRequirements = { vision: persistedRun.taskCapability === "vision", tools: true };
  let decision = routeForTurn({
    requirements,
    classification: persistedRun.dataClassification,
    preferredProfileId: persistedRun.modelProfile,
  });
  const leaseId = crypto.randomUUID();
  const startedAt = new Date();
  const claimed = await prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT pg_advisory_xact_lock(${EXECUTION_ADMISSION_LOCK_ID})::text`;
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
  try {
    signal.throwIfAborted();
    if (state.iteration === 0) {
      await appendMessage(run.id, 0, "system", { event: "RUN_STARTED", model: decision.profile.id, capability: decision.capability, maxTurns, maxToolCalls, tokenBudget: state.tokenBudget, deadlineAt: deadlineAt.toISOString() });
      await audit({ actorId: run.requestedBy, workspaceId: run.workspaceId, runId: run.id, eventType: "MODEL_ROUTED", metadata: { profile: decision.profile.id, capability: decision.capability, sovereign: decision.profile.sovereign } });
    }

    const evidence: EvidenceItem[] = [];
    let modelImages: ModelImageInput[] = [];
    let visionInput: Record<string, unknown> | undefined;
    let sourceLimitation: string | undefined;
    let sourceFilename: string | undefined;

    let source: Awaited<ReturnType<typeof findArtifact>> | undefined;
    if (sourceArtifactId) {
      source = await findArtifact(sourceArtifactId);
      if (!source || source.workspaceId !== run.workspaceId) throw new AppError(400, "Source artifact is unavailable in this workspace", "INVALID_ARTIFACT");
      if (!source.detectedMimeType) throw new AppError(422, "Source artifact has no validated MIME type", "SOURCE_MIME_UNVALIDATED");
      sourceFilename = source.filename;
    }

    // Rendering visual input is deterministic policy: which pages, at what
    // size, under what limits. *Whether* it is needed is discovered rather
    // than guessed — an image has no text to read, a document that extracts
    // to nothing is a scan, and the agent can ask to look at a document whose
    // text turned out to be useless. This runs at most once per run.
    const prepareVisualInput = async (): Promise<number> => {
      if (modelImages.length > 0) return modelImages.length;
      if (!source?.detectedMimeType) throw new AppError(422, "This run has no source document to look at", "NO_SOURCE_ARTIFACT");
      const sourceMimeType = source.detectedMimeType;
      {
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

        // This records only what the *visual* input was and how it was
        // bounded; the document's words come from extraction.
        sourceLimitation = limitations.length > 0 ? limitations.join(" ") : undefined;
        visionInput = { ...visionInput, limitations };

        // The rendered pages are evidence in their own right, so a deliverable
        // can cite the visual source even when no text was extracted.
        evidence.push(await saveEvidence(
          run.id,
          EvidenceKind.SOURCE,
          source.id,
          `artifact:${source.id}`,
          source.filename,
          `${evidenceSummary} ${sourceLimitation ?? ""}`.trim(),
          [evidenceSummary],
        ));
      }
      return modelImages.length;
    };

    // Extraction runs before the loop for anything with a text layer.
    // It is cached and idempotent, so `artifact.read` still returns the same
    // text and still records the evidence — warming it here removes the case
    // where a run never touches its own attachment because inference failed
    // before the model could ask for it, and it is what reveals a scan.
    //
    // A failure is deliberately not fatal: `artifact.read` will surface it as
    // a tool error the agent can react to, and the agent can still ask to
    // look at the document instead.
    let extractedCharacters: number | undefined;
    if (sourceArtifactId && source?.detectedMimeType && !source.detectedMimeType.startsWith("image/")) {
      try {
        const extraction = await extractArtifact(sourceArtifactId, signal);
        extractedCharacters = extraction.text.length;
      } catch (error) {
        if (signal.aborted) throw error;
        logger.warn({ error, runId: run.id, artifactId: sourceArtifactId }, "Source extraction failed before the loop");
      }
    }

    if (source?.detectedMimeType && visionRequiredForSource({
      mimeType: source.detectedMimeType,
      ...(extractedCharacters !== undefined ? { extractedCharacters } : {}),
    })) {
      requirements = { ...requirements, vision: true };
    }

    // Images known to be needed from the start ride on the opening turn.
    // A need discovered later arrives as its own message instead.
    const visualInputFromStart = requirements.vision;
    if (visualInputFromStart) await prepareVisualInput();

    const history = await loadConversationHistory({
      workspaceId: run.workspaceId,
      conversationId: run.conversationId,
      excludeRunId: run.id,
    });

    let produced: { id: string; filename: string } | undefined;
    const dispatcher = createToolDispatcher({
      run: { id: run.id, workspaceId: run.workspaceId, requestedBy: run.requestedBy, dataClassification: run.dataClassification },
      task: run.task,
      ...(sourceFilename ? { sourceFilename } : {}),
      extractionVersion: EXTRACTION_VERSION,
      signal,
      evidence,
      execute: (name, input, work) => executeRunTool(run.id, name, input, work, signal, toolOptions),
      saveEvidence: async (kind, artifactId, sourceRef, title, summary, facts) => {
        const item = await saveEvidence(run.id, kind, artifactId, sourceRef, title, summary, facts);
        evidence.push(item);
        return item;
      },
      onArtifact: (artifact) => { produced = artifact; },
      // The agent states a need; code decides what that need is allowed to
      // route to. It never names a profile.
      requestVisualInspection: async () => {
        const pages = await prepareVisualInput();
        requirements = { ...requirements, vision: true };
        return { pages };
      },
    });

    // A run that needed visual input from the start attaches the rendered
    // pages to its opening message; everything else opens with the task alone.
    const opening = loopOpeningMessage({ task: run.task, ...(sourceFilename ? { sourceFilename } : {}), ...(sourceLimitation ? { limitation: sourceLimitation } : {}) });
    const openingContent = visualInputFromStart && modelImages.length > 0
      ? [{ type: "text" as const, text: opening }, ...modelImages.map((image) => ({ type: "image" as const, mimeType: image.mimeType, bytes: image.bytes }))]
      : opening;

    /**
     * Attaches pages the agent asked to see.
     *
     * They arrive as their own turn rather than being spliced into the opening
     * message, so the request and the images stay adjacent in the
     * conversation. Derived on every call and never persisted, because image
     * bytes must not reach durable run messages.
     */
    const withVisualInput = (messages: ChatMessage[]): ChatMessage[] => {
      if (visualInputFromStart || modelImages.length === 0) return messages;
      return [...messages, {
        role: "user",
        content: [
          { type: "text" as const, text: `The pages of ${sourceFilename ?? "the source document"} you asked to see are attached.${sourceLimitation ? ` ${sourceLimitation}` : ""}` },
          ...modelImages.map((image) => ({ type: "image" as const, mimeType: image.mimeType, bytes: image.bytes })),
        ],
      }];
    };

    let selectedProfile = decision.profile;
    const outcome = await runAgentLoop({
      runId: run.id,
      classification: run.dataClassification,
      openingMessage: openingContent,
      priorTurns: priorTurnMessages(history),
      budget: { maxTurns, maxToolCalls },
      dispatch: dispatcher,
      signal,
      systemPrompt: ({ turnsRemaining, toolCallsRemaining, mustFinish }) => loopSystemPrompt({
        task: run.task,
        classification: run.dataClassification,
        ...(sourceArtifactId && sourceFilename
          ? { sourceArtifact: { id: sourceArtifactId, filename: sourceFilename, extractionVersion: EXTRACTION_VERSION } }
          : {}),
        evidence,
        turnsRemaining,
        toolCallsRemaining,
        mustFinish,
        ...(sourceLimitation ? { sourceLimitation } : {}),
      }),
      invoke: async ({ system, messages, tools, toolChoice }) => {
        // Routed per turn, not once per run: the requirements may have changed
        // since the last call. The profile in hand is kept while it still
        // meets them, so an ordinary turn does not move between providers.
        decision = routeForTurn({
          requirements,
          classification: run.dataClassification,
          preferredProfileId: selectedProfile.id,
        });
        const selected = await invokeModelWithFallbacks({
          runId: run.id,
          decision,
          classification: run.dataClassification,
          system,
          messages: withVisualInput(messages),
          tools,
          toolChoice,
          signal,
          tokenBudget: state.tokenBudget,
        });
        selectedProfile = selected.profile;
        return { text: selected.response.text, toolCalls: selected.response.toolCalls, profileId: selected.profile.id };
      },
      onIteration: async (iteration) => {
        state = { ...state, iteration };
        const saved = await prisma.agentRun.updateMany({
          where: { id: run.id, status: RunStatus.RUNNING, leaseId },
          data: { state: toJson(state) },
        });
        if (saved.count === 0) throw new Error("Agent run lease was lost");
        await appendMessage(run.id, iteration, "system", progressEvent(state, `Iteration ${iteration}`));
      },
    });

    if (selectedProfile.id !== run.modelProfile) {
      await prisma.agentRun.updateMany({
        where: { id: run.id, status: RunStatus.RUNNING, leaseId },
        data: { modelProfile: selectedProfile.id, modelReason: `${decision.reason} Profile '${selectedProfile.id}' completed the run.` },
      });
    }

    evidence.push(await saveEvidence(run.id, EvidenceKind.MODEL_OUTPUT, undefined, "model-analysis", "Model output", outcome.answer.answer, [outcome.answer.answer]));
    const sourceEvidence = evidence.filter((item) => item.sourceRef.startsWith("artifact:"));
    const result: Record<string, unknown> = {
      analysis: outcome.answer.answer,
      confidence: outcome.answer.confidence,
      iterations: outcome.iterations,
      budgetExhausted: outcome.exhausted,
      sourceEvidenceIds: sourceEvidence.map((item) => item.id),
      modelOutputEvidenceIds: evidence.filter((item) => item.sourceRef === "model-analysis").map((item) => item.id),
      model: selectedProfile.id,
      capability: requiredCapability(requirements),
    };
    if (outcome.answer.unresolved && outcome.answer.unresolved.length > 0) result.unresolved = outcome.answer.unresolved;
    if (visionInput) result.visionInput = visionInput;
    if (produced) {
      const artifact = await findArtifact(produced.id);
      if (artifact) result.artifact = { ...artifact, sizeBytes: Number(artifact.sizeBytes) };
    }

    signal.throwIfAborted();
    await appendMessage(run.id, state.iteration, "assistant", result);
    const completed = await prisma.agentRun.updateMany({ where: { id: run.id, status: RunStatus.RUNNING, leaseId }, data: { status: RunStatus.COMPLETED, result: toJson(result), activeWorkspaceId: null, leaseId: null, heartbeatAt: null, leaseExpiresAt: null, completedAt: new Date() } });
    if (completed.count > 0) await audit({ actorId: run.requestedBy, workspaceId: run.workspaceId, runId: run.id, eventType: "AGENT_RUN_COMPLETED", metadata: { sovereign: selectedProfile.sovereign, iterations: outcome.iterations } });
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
export async function listRuns(input: { workspaceId: string; limit: number; cursor?: RunCursor }) {
  const runs = await prisma.agentRun.findMany({
    where: {
      workspaceId: input.workspaceId,
      ...(input.cursor ? {
        OR: [
          { createdAt: { lt: input.cursor.createdAt } },
          { createdAt: input.cursor.createdAt, id: { lt: input.cursor.id } },
        ],
      } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.limit + 1,
    select: runSummarySelect,
  });
  const page = runs.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    runs: page,
    nextCursor: runs.length > input.limit && last
      ? Buffer.from(JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id })).toString("base64url")
      : null,
  };
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
