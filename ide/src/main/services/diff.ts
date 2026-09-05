import { structuredPatch } from "diff";

import type { DiffHunk, DiffLine, FileChangeType, FilePatch } from "@shared/types.js";

/** Marker `diff` emits for a file whose final line lacks a trailing newline. */
const NO_NEWLINE_MARKER = "\\";

export interface BuildPatchInput {
  path: string;
  /** `null` for a newly added file. */
  before: string | null;
  /** `null` for a deleted file. */
  after: string | null;
  /** Set to record a rename alongside the content change. */
  previousPath?: string;
  /** Lines of unchanged context to keep around each change. */
  contextLines?: number;
}

/**
 * Turns before/after file contents into a fully resolved `FilePatch`.
 *
 * Diffing lives in the main process on purpose: the renderer is a pure view of
 * a patch, so when the backend starts sending real patches the renderer needs
 * no change at all — only this function is replaced.
 */
export function buildFilePatch(input: BuildPatchInput): FilePatch {
  const { path, before, after, previousPath } = input;
  const contextLines = input.contextLines ?? 3;

  if (before === null && after === null) {
    throw new Error(`Cannot build a patch for "${path}": both sides are null`);
  }

  const changeType = resolveChangeType(before, after, previousPath);
  const patch = structuredPatch(
    previousPath ?? path,
    path,
    before ?? "",
    after ?? "",
    undefined,
    undefined,
    { context: contextLines },
  );

  const hunks = patch.hunks.map(toDiffHunk);
  return {
    path,
    previousPath: previousPath ?? null,
    changeType,
    hunks,
    additions: countLines(hunks, "add"),
    deletions: countLines(hunks, "del"),
    binary: false,
  };
}

/**
 * Builds a patch for a file whose contents cannot be rendered as text. Kept
 * separate so callers must decide explicitly rather than accidentally diffing
 * binary bytes into unreadable noise.
 */
export function buildBinaryPatch(path: string, changeType: FileChangeType): FilePatch {
  return {
    path,
    previousPath: null,
    changeType,
    hunks: [],
    additions: 0,
    deletions: 0,
    binary: true,
  };
}

function resolveChangeType(
  before: string | null,
  after: string | null,
  previousPath: string | undefined,
): FileChangeType {
  if (before === null) return "added";
  if (after === null) return "deleted";
  return previousPath ? "renamed" : "modified";
}

/**
 * Converts one `diff` hunk into numbered rows.
 *
 * `diff` yields lines as strings prefixed with ` `, `-`, or `+`. Walking the
 * two cursors in step is what produces the paired gutter numbers, with `null`
 * on whichever side the line is absent from.
 */
function toDiffHunk(hunk: {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}): DiffHunk {
  let oldCursor = hunk.oldStart;
  let newCursor = hunk.newStart;
  const lines: DiffLine[] = [];

  for (const raw of hunk.lines) {
    const marker = raw.charAt(0);
    const content = raw.slice(1);

    // "\ No newline at end of file" annotates the previous line rather than
    // being a line of its own, so it never becomes a rendered row.
    if (marker === NO_NEWLINE_MARKER) continue;

    if (marker === "+") {
      lines.push({ type: "add", content, oldNumber: null, newNumber: newCursor++ });
    } else if (marker === "-") {
      lines.push({ type: "del", content, oldNumber: oldCursor++, newNumber: null });
    } else {
      lines.push({ type: "context", content, oldNumber: oldCursor++, newNumber: newCursor++ });
    }
  }

  return {
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines,
  };
}

function countLines(hunks: DiffHunk[], type: DiffLine["type"]): number {
  let total = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === type) total += 1;
    }
  }
  return total;
}
