import type { SessionManager } from "../services/session.js";
import { handle } from "./typed-handle.js";

export function registerSessionHandlers(session: SessionManager): void {
  handle("session:state", () => session.state());
  handle("session:connect", ({ baseUrl, email, password }) => session.connect(baseUrl, email, password));
  handle("session:disconnect", () => session.disconnect());
  handle("session:select-workspace", (workspaceId) => session.selectWorkspace(workspaceId));

  handle("approval:decide", async ({ approvalId, decision }) => {
    await session.requireClient().decideApproval(approvalId, decision);
  });
}
