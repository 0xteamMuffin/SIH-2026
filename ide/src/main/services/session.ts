import { DISCONNECTED_SESSION, type SessionState, type WorkspaceSummary } from "@shared/types.js";

import type { EventBroadcaster } from "../events.js";
import { BackendClient } from "./backend-client.js";
import { signInDefaults } from "./dev-defaults.js";

/** Workspace created on first connect when the account has none. */
const DEFAULT_WORKSPACE_NAME = "Workbench";

/**
 * Owns the connection to the backend.
 *
 * Credentials and tokens stay here and are never persisted to disk or sent to
 * the renderer: the renderer only ever sees `SessionState`, which describes
 * who is connected and where, not how. A restart therefore requires signing in
 * again — the right default for a workstation that may be shared.
 */
export class SessionManager {
  readonly #events: EventBroadcaster;
  #client: BackendClient | null = null;
  #state: SessionState;

  constructor(events: EventBroadcaster) {
    this.#events = events;
    this.#state = this.#signedOutState();
  }

  /**
   * A signed-out state carrying the development prefill, if there is one, so
   * the form is populated on first launch and again after signing out.
   */
  #signedOutState(overrides: Partial<SessionState> = {}): SessionState {
    const prefill = signInDefaults();
    return {
      ...DISCONNECTED_SESSION,
      ...(prefill ? { prefill, baseUrl: prefill.baseUrl } : {}),
      ...overrides,
    };
  }

  state(): SessionState {
    return this.#state;
  }

  /** The connected client, or `null` when signed out. */
  client(): BackendClient | null {
    return this.#client?.isAuthenticated ? this.#client : null;
  }

  /** Throws a message worth showing the user when there is no connection. */
  requireClient(): BackendClient {
    const client = this.client();
    if (!client) throw new Error("Not connected to the backend. Sign in to run a task.");
    return client;
  }

  requireWorkspaceId(): string {
    const workspaceId = this.#state.workspace?.id;
    if (!workspaceId) throw new Error("No workspace selected.");
    return workspaceId;
  }

  async connect(baseUrl: string, email: string, password: string): Promise<SessionState> {
    this.#publish(this.#signedOutState({ status: "connecting", baseUrl }));

    const client = new BackendClient(baseUrl);
    try {
      const user = await client.login(email, password);
      const workspaces = await this.#resolveWorkspaces(client);

      this.#client = client;
      const workspace = workspaces[0];
      this.#publish({
        status: "connected",
        baseUrl: client.baseUrl,
        user,
        workspaces,
        ...(workspace ? { workspace } : {}),
      });
    } catch (error) {
      this.#client = null;
      this.#publish(this.#signedOutState({
        baseUrl,
        error: error instanceof Error ? error.message : String(error),
      }));
    }

    return this.#state;
  }

  disconnect(): SessionState {
    this.#client?.logout();
    this.#client = null;
    this.#publish(this.#signedOutState({ baseUrl: this.#state.baseUrl }));
    return this.#state;
  }

  selectWorkspace(workspaceId: string): SessionState {
    const workspace = this.#state.workspaces.find((candidate) => candidate.id === workspaceId);
    if (workspace) this.#publish({ ...this.#state, workspace });
    return this.#state;
  }

  /**
   * A fresh account has no workspace, and a run cannot be created without one,
   * so one is provisioned rather than leaving the user at a dead end.
   */
  async #resolveWorkspaces(client: BackendClient): Promise<WorkspaceSummary[]> {
    const existing = await client.listWorkspaces();
    if (existing.length > 0) return existing;
    return [await client.createWorkspace(DEFAULT_WORKSPACE_NAME)];
  }

  #publish(state: SessionState): void {
    this.#state = state;
    this.#events.emit({ type: "session/changed", state });
  }
}
