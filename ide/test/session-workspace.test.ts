import { describe, expect, it } from "vitest";

import type { WorkspaceSummary } from "@shared/types.js";

import { orderByDefaultFirst } from "../src/main/services/session.js";

/**
 * The default workspace has to survive other people's activity.
 *
 * The backend lists workspaces newest first. Taking the head meant the IDE's
 * default silently moved to whatever had been created most recently — by
 * another client, another user, or a test script — which filed a chat's later
 * turns into a different workspace from its earlier ones. Because the backend
 * scopes a thread's history by workspace, the chat then could not see its own
 * past and answered as though it had none.
 */
describe("orderByDefaultFirst", () => {
  const workspace = (id: string, name: string, createdAt: string): WorkspaceSummary => ({ id, name, createdAt });

  it("prefers the app's own workspace however recently others appeared", () => {
    const ordered = orderByDefaultFirst([
      workspace("noise", "loop-1788624074711", "2026-09-05T16:00:00.000Z"),
      workspace("home", "Workbench", "2026-01-01T00:00:00.000Z"),
    ]);

    expect(ordered[0]?.id).toBe("home");
  });

  it("falls back to the oldest, which nothing created later can displace", () => {
    const ordered = orderByDefaultFirst([
      workspace("newest", "Acceptance 999", "2026-09-05T16:30:00.000Z"),
      workspace("original", "Inspection Review Workspace", "2026-02-01T00:00:00.000Z"),
      workspace("middle", "test", "2026-06-01T00:00:00.000Z"),
    ]);

    expect(ordered[0]?.id).toBe("original");
  });

  it("gives the same answer no matter how the backend happened to order them", () => {
    // This is the actual property that was missing: the result must not depend
    // on list position, because that is what kept changing.
    const all = [
      workspace("a", "Alpha", "2026-03-01T00:00:00.000Z"),
      workspace("b", "Beta", "2026-04-01T00:00:00.000Z"),
      workspace("c", "Gamma", "2026-05-01T00:00:00.000Z"),
    ];
    const permutations = [all, [...all].reverse(), [all[1]!, all[2]!, all[0]!]];

    for (const permutation of permutations) {
      expect(orderByDefaultFirst(permutation)[0]?.id).toBe("a");
    }
  });

  it("keeps every workspace on offer, just reordered", () => {
    const all = [
      workspace("newest", "loop-2", "2026-09-05T16:30:00.000Z"),
      workspace("oldest", "Workbench", "2026-01-01T00:00:00.000Z"),
      workspace("middle", "loop-1", "2026-06-01T00:00:00.000Z"),
    ];

    expect(orderByDefaultFirst(all).map((item) => item.id).sort()).toEqual(["middle", "newest", "oldest"]);
  });
});
