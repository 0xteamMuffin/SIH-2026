import type { ChatId, DataClassification, DocumentRef, MessageBlock, RunTrace } from "@shared/types.js";

export interface AgentTurnRequest {
  chatId: ChatId;
  prompt: string;
  /** Files the user attached, already registered in the document library. */
  attachments: DocumentRef[];
  /** Handling policy for this turn. Restricted values force a local model. */
  classification: DataClassification;
  /** Aborted when the user stops the turn or the app quits. */
  signal: AbortSignal;
  /**
   * Workspace this chat is already bound to, if it has run a turn before.
   * Absent on a chat's first turn.
   */
  workspaceId?: string;
  /**
   * Records the workspace the turn actually ran in, so every later turn of
   * this chat lands in the same one and can see this turn's answer.
   */
  bindWorkspace: (workspaceId: string) => void;
  /**
   * Publishes the agent reply's current state. Called repeatedly as the turn
   * progresses; each call supersedes the previous one, so implementations pass
   * the full block list rather than a delta.
   *
   * `trace` carries the execution detail behind those blocks — routing, tool
   * arguments, results — for the trace panel.
   */
  publish: (blocks: MessageBlock[], trace?: RunTrace) => void;
}

/**
 * The seam between the IDE and the on-premise agent backend.
 *
 * Everything the UI knows about running a turn is this one method. The IDE
 * holds no model, no credentials in the renderer, and no execution of its own:
 * a turn is started here and its progress is published back as blocks.
 */
export interface AgentGateway {
  runTurn(request: AgentTurnRequest): Promise<void>;
  /** Asks the backend to stop the turn running for a chat, if any. */
  cancel?(chatId: ChatId): Promise<void>;
}
