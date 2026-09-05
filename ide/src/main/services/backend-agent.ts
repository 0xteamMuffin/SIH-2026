import type {
  DataClassification,
  DocumentKind,
  DocumentRef,
  MessageBlock,
  RunState,
  RunTrace,
  ToolCallState,
} from "@shared/types.js";

import type { AgentGateway, AgentTurnRequest } from "./agent-gateway.js";
import type { BackendArtifact, BackendClient, BackendRun, BackendToolCall } from "./backend-client.js";
import type { DocumentLibrary } from "./document-library.js";
import { classifyFile } from "./document-library.js";
import type { SessionManager } from "./session.js";

/** How often to re-read a running run. */
const POLL_INTERVAL_MS = 1_200;

const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/**
 * Friendly labels for the backend's tool names.
 *
 * The raw identifiers are correct but not what a plant engineer should have to
 * read, and an unmapped tool falls back to its own name rather than being
 * hidden — a new backend tool should still show up in the thread.
 */
const TOOL_LABELS: Record<string, string> = {
  "artifact.read": "Reading document",
  "knowledge.search": "Searching knowledge base",
  "model.analyze": "Analysing",
  "code.persistOutput": "Saving code",
  "sandbox.execute": "Running code in sandbox",
  "deliverable.createApprovalNote": "Writing approval note",
  "deliverable.createPresentation": "Building presentation",
  "deliverable.createSpreadsheet": "Building workbook",
};

const RUN_STATE_BY_STATUS: Record<BackendRun["status"], RunState> = {
  PENDING: "queued",
  RUNNING: "running",
  WAITING_APPROVAL: "awaiting-approval",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

const TOOL_STATE_BY_STATUS: Record<BackendToolCall["status"], ToolCallState> = {
  PENDING: "running",
  RUNNING: "running",
  WAITING_APPROVAL: "awaiting-approval",
  COMPLETED: "completed",
  FAILED: "failed",
  REJECTED: "rejected",
  CANCELLED: "failed",
};

export interface BackendAgentOptions {
  session: SessionManager;
  documents: DocumentLibrary;
}

/**
 * Runs a turn against the on-premise backend.
 *
 * Attachments are uploaded as workspace artifacts first, then a run is created
 * and polled to completion, with the run's evolving state projected into
 * message blocks after every poll. The renderer therefore sees tool calls and
 * approvals as they happen rather than only a final answer.
 */
export class BackendAgentGateway implements AgentGateway {
  readonly #session: SessionManager;
  readonly #documents: DocumentLibrary;

  /** Run ids by chat, so a cancel can reach the backend run. */
  readonly #activeRuns = new Map<string, string>();

  constructor(options: BackendAgentOptions) {
    this.#session = options.session;
    this.#documents = options.documents;
  }

  async runTurn({ chatId, prompt, signal, publish, attachments, classification }: AgentTurnRequest): Promise<void> {
    const client = this.#session.requireClient();
    const workspaceId = this.#session.requireWorkspaceId();

    // Publish a trace before anything is uploaded or created, so the graph is
    // on screen the moment the message is sent rather than a second later.
    // Uploads and run creation both take time, and watching the run build is
    // the point of the panel.
    publish([{ kind: "status", state: "queued", label: "Preparing" }], pendingTrace(chatId, prompt));

    let artifactId: string | undefined;
    try {
      artifactId = await this.#uploadAttachments(client, workspaceId, attachments, classification, (label) => {
        publish([{ kind: "status", state: "running", label }], pendingTrace(chatId, prompt, label));
      });
    } catch (error) {
      publish(
        [{ kind: "status", state: "failed", label: "Upload failed", detail: describe(error) }],
        { ...pendingTrace(chatId, prompt), status: "failed", result: { error: describe(error) } },
      );
      return;
    }

    let run: BackendRun;
    try {
      // The chat id doubles as the conversation id, so the backend can load
      // this thread's earlier turns and a follow-up like "make it shorter"
      // has something to refer to.
      run = await client.createRun({
        workspaceId,
        task: prompt,
        conversationId: chatId,
        dataClassification: classification,
        ...(artifactId ? { artifactId } : {}),
      });
    } catch (error) {
      publish(
        [{ kind: "status", state: "failed", label: "Could not start the run", detail: describe(error) }],
        { ...pendingTrace(chatId, prompt), status: "failed", result: { error: describe(error) } },
      );
      return;
    }

    this.#activeRuns.set(chatId, run.id);
    try {
      await this.#pollUntilDone(client, run, signal, publish);
    } finally {
      this.#activeRuns.delete(chatId);
    }
  }

  /** Asks the backend to cancel the run behind a chat, if one is live. */
  async cancel(chatId: string): Promise<void> {
    const runId = this.#activeRuns.get(chatId);
    const client = this.#session.client();
    if (!runId || !client) return;

    try {
      await client.cancelRun(runId);
    } catch {
      // The run may already have finished; the poll loop reports the truth.
    }
  }

  async #uploadAttachments(
    client: BackendClient,
    workspaceId: string,
    attachments: DocumentRef[],
    classification: DataClassification,
    onProgress: (label: string) => void,
  ): Promise<string | undefined> {
    let firstArtifactId: string | undefined;

    for (const [index, attachment] of attachments.entries()) {
      if (attachment.source.type !== "file") continue;
      onProgress(`Uploading ${attachment.filename} (${index + 1}/${attachments.length})`);

      const bytes = await this.#documents.read(attachment.id);
      const uploaded = await client.uploadArtifact(
        workspaceId,
        attachment.source.path,
        bytes,
        attachment.mimeType,
        classification,
      );
      // The run API accepts one source artifact; the rest are still uploaded
      // so they are available to the workspace and to later turns.
      firstArtifactId ??= uploaded.id;
    }

    return firstArtifactId;
  }


  async #pollUntilDone(
    client: BackendClient,
    initial: BackendRun,
    signal: AbortSignal,
    publish: (blocks: MessageBlock[], trace?: RunTrace) => void,
  ): Promise<void> {
    let current = initial;
    publish(toBlocks(current), toTrace(current));

    while (!TERMINAL_STATUSES.has(current.status)) {
      if (signal.aborted) {
        publish([...toBlocks(current), { kind: "status", state: "cancelled", label: "Stopped" }], toTrace(current));
        return;
      }
      await delay(POLL_INTERVAL_MS, signal);
      if (signal.aborted) continue;

      try {
        current = await client.getRun(current.id);
      } catch (error) {
        publish(
          [...toBlocks(current), { kind: "status", state: "failed", label: "Lost contact with the backend", detail: describe(error) }],
          toTrace(current),
        );
        return;
      }
      publish(toBlocks(current), toTrace(current));
    }
  }
}

/**
 * Projects a backend run into the thread.
 *
 * Called on every poll and always rebuilt from scratch, so the rendered turn
 * is a pure function of the run's current state — no incremental patching to
 * get out of step with the server.
 */
export function toBlocks(run: BackendRun): MessageBlock[] {
  const blocks: MessageBlock[] = [];

  for (const call of run.toolCalls ?? []) {
    // `model.analyze` is the backend's own bookkeeping for the inference call,
    // not something the user asked for; its output is the answer itself.
    if (call.toolName === "model.analyze" && call.status === "COMPLETED") continue;

    blocks.push({
      kind: "tool",
      toolName: call.toolName,
      state: TOOL_STATE_BY_STATUS[call.status],
      summary: toolSummary(call),
    });
  }

  for (const approval of run.approvals ?? []) {
    if (approval.status !== "PENDING") continue;
    blocks.push({
      kind: "approval",
      approvalId: approval.id,
      toolName: approval.toolName,
      riskLevel: approval.riskLevel,
      input: approval.toolInput,
      status: approval.status,
    });
  }

  const analysis = run.result?.analysis?.trim();
  if (analysis) blocks.push({ kind: "text", text: analysis });

  if (run.result?.artifact) {
    blocks.push({ kind: "document", document: toDocumentRef(run.result.artifact) });
  }

  blocks.push(runStatusBlock(run));
  return blocks;
}

/**
 * A trace for a turn that has no backend run yet.
 *
 * Keyed on the chat so the panel treats the whole turn as one subject: when
 * the real run id arrives the panel swaps to it without flickering closed.
 */
function pendingTrace(chatId: string, task: string, stage = "Preparing"): RunTrace {
  return {
    runId: `pending-${chatId}`,
    task,
    status: "queued",
    modelProfile: "",
    modelReason: stage,
    capability: "",
    toolCalls: [],
  };
}

/**
 * Projects a run into the inspection trace.
 *
 * Keeps what the thread deliberately leaves out — the router's reason, each
 * tool's arguments and raw result — so the graph can explain how an answer was
 * reached without cluttering the conversation with it.
 */
export function toTrace(run: BackendRun): RunTrace {
  const result: RunTrace["result"] = {};
  if (run.result?.analysis) result.analysis = run.result.analysis;
  if (run.result?.artifact) result.artifactFilename = run.result.artifact.filename;
  if (run.result?.error) result.error = run.result.error;

  return {
    runId: run.id,
    task: run.task,
    status: RUN_STATE_BY_STATUS[run.status],
    modelProfile: run.modelProfile,
    modelReason: run.modelReason,
    capability: run.taskCapability,
    toolCalls: (run.toolCalls ?? []).map((call) => ({
      toolName: call.toolName,
      state: TOOL_STATE_BY_STATUS[call.status],
      summary: toolSummary(call),
      input: call.input,
      output: call.output,
    })),
    ...(Object.keys(result).length > 0 ? { result } : {}),
  };
}

function runStatusBlock(run: BackendRun): MessageBlock {
  const state = RUN_STATE_BY_STATUS[run.status];

  if (state === "failed") {
    return {
      kind: "status",
      state,
      label: "Failed",
      detail: run.result?.error ?? run.result?.code ?? "The run did not complete.",
    };
  }
  if (state === "completed") {
    // Naming the model makes the routing decision visible, which is the point
    // of having a model registry at all.
    return { kind: "status", state, label: "Done", detail: run.modelProfile };
  }
  if (state === "awaiting-approval") {
    return { kind: "status", state, label: "Waiting for your approval" };
  }
  if (state === "cancelled") return { kind: "status", state, label: "Cancelled" };
  if (state === "queued") return { kind: "status", state, label: "Queued" };
  return { kind: "status", state, label: "Working" };
}

function toolSummary(call: BackendToolCall): string {
  const label = TOOL_LABELS[call.toolName] ?? call.toolName;
  const summary = call.output?.summary;

  if (call.status === "COMPLETED" && summary) return summary;
  if (call.status === "FAILED") return `${label} failed${summary ? `: ${summary}` : ""}`;
  if (call.status === "REJECTED") return `${label} was rejected`;
  if (call.status === "WAITING_APPROVAL") return `${label} needs approval`;
  return label;
}

function toDocumentRef(artifact: BackendArtifact): DocumentRef {
  const { kind } = classifyFile(artifact.filename);
  return {
    id: artifact.id,
    filename: artifact.filename,
    mimeType: artifact.mimeType,
    kind: kind === "unknown" ? kindFromMime(artifact.mimeType) : kind,
    byteSize: Number(artifact.sizeBytes ?? 0),
    source: { type: "artifact", artifactId: artifact.id },
  };
}

/** Fallback for generated files whose name lacks a recognised extension. */
function kindFromMime(mimeType: string): DocumentKind {
  if (mimeType.includes("pdf")) return "pdf";
  if (mimeType.includes("spreadsheet") || mimeType.includes("excel")) return "spreadsheet";
  if (mimeType.includes("wordprocessing") || mimeType.includes("msword")) return "wordprocessing";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("text/")) return "text";
  return "unknown";
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });

    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
