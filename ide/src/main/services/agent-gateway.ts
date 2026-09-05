import type { ChatId, MessageBlock } from "@shared/types.js";

export interface AgentTurnRequest {
  chatId: ChatId;
  prompt: string;
  /** Aborted when the user stops the turn or the app quits. */
  signal: AbortSignal;
  /**
   * Publishes the agent reply's current blocks. Called repeatedly as the turn
   * progresses; each call supersedes the previous one, so implementations pass
   * the full block list rather than a delta.
   */
  publish: (blocks: MessageBlock[]) => void;
}

/**
 * The seam between the IDE and the on-prem agent backend.
 *
 * Everything the UI knows about running a turn is this one method. The real
 * implementation will POST to the backend's run API and translate its streamed
 * tool calls, patches, and artifacts into `MessageBlock`s; until then
 * `ScriptedAgentGateway` stands in. Nothing above this interface needs to
 * change when that swap happens.
 */
export interface AgentGateway {
  runTurn(request: AgentTurnRequest): Promise<void>;
}
