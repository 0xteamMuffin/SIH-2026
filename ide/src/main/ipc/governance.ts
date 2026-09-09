import { writeFile } from "node:fs/promises";

import { BrowserWindow, dialog } from "electron";

import type { SessionManager } from "../services/session.js";
import { handle } from "./typed-handle.js";

/**
 * Sovereignty, administration, and audit handlers.
 *
 * All of these are thin: the backend owns the records and the authorisation,
 * so main's only job is to attach the session's credential and pass the
 * payload through. In particular the renderer is never told whether it *may*
 * call something — a 403 from the backend is the authoritative answer, and
 * duplicating the role check here would create a second, driftable copy of
 * the policy.
 */
export function registerGovernanceHandlers(session: SessionManager): void {
  // ─── Sovereignty ───────────────────────────────────────────────────────────

  handle("sovereignty:posture", () => session.requireClient().getSovereigntyPosture());

  handle("sovereignty:egress", ({ limit, sinceHours }) =>
    session.requireClient().getEgressLedger({
      ...(limit !== undefined ? { limit } : {}),
      ...(sinceHours !== undefined ? { sinceHours } : {}),
    }),
  );

  handle("sovereignty:probe", ({ workspaceId }) =>
    session.requireClient().probeEgress(workspaceId),
  );

  // ─── Administration ────────────────────────────────────────────────────────

  handle("admin:model-providers", () => session.requireClient().getModelProviderStatus());
  handle("admin:users", () => session.requireClient().listUsers());
  handle("admin:create-user", ({ email, password, role }) =>
    session.requireClient().createUser(email, password, role),
  );
  handle("admin:disable-user", (userId) => session.requireClient().disableUser(userId));

  handle("admin:create-workspace", async (name) => {
    const workspace = await session.requireClient().createWorkspace(name);
    // The session's workspace list is now stale, and the title bar reads from
    // it — refreshing here is what makes a new workspace immediately
    // selectable rather than appearing on the next sign-in.
    await session.refreshWorkspaces();
    return workspace;
  });

  handle("admin:workspace-members", (workspaceId) =>
    session.requireClient().listWorkspaceMembers(workspaceId),
  );
  handle("admin:add-member", ({ workspaceId, userId, role }) =>
    session.requireClient().addWorkspaceMember(workspaceId, userId, role),
  );
  handle("admin:update-member-role", ({ workspaceId, userId, role }) =>
    session.requireClient().updateWorkspaceMemberRole(workspaceId, userId, role),
  );
  handle("admin:remove-member", ({ workspaceId, userId }) =>
    session.requireClient().removeWorkspaceMember(workspaceId, userId),
  );

  // ─── Audit ─────────────────────────────────────────────────────────────────

  handle("audit:list", (query) => session.requireClient().listAuditEvents(query));

  handle("audit:export", async ({ workspaceId, format, filters }, event) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const defaultPath = `audit-${stamp}.${format}`;

    const window = BrowserWindow.fromWebContents(event.sender);
    const result = window
      ? await dialog.showSaveDialog(window, { defaultPath })
      : await dialog.showSaveDialog({ defaultPath });
    if (result.canceled || !result.filePath) return null;

    // Fetched only after a destination is chosen, so cancelling never pulls a
    // large export needlessly.
    const body = await session.requireClient().exportAuditEvents(workspaceId, format, filters);
    await writeFile(result.filePath, body, "utf8");
    return result.filePath;
  });
}
