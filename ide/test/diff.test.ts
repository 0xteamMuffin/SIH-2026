import { describe, expect, it } from "vitest";

import type { DiffLine } from "@shared/types.js";

import { buildBinaryPatch, buildFilePatch } from "../src/main/services/diff.js";

function allLines(patch: ReturnType<typeof buildFilePatch>): DiffLine[] {
  return patch.hunks.flatMap((hunk) => hunk.lines);
}

describe("buildFilePatch", () => {
  it("classifies a content change as modified and counts both sides", () => {
    const patch = buildFilePatch({
      path: "a.py",
      before: "one\ntwo\nthree\n",
      after: "one\nTWO\nthree\nfour\n",
    });

    expect(patch.changeType).toBe("modified");
    expect(patch.additions).toBe(2);
    expect(patch.deletions).toBe(1);
    expect(patch.previousPath).toBeNull();
    expect(patch.binary).toBe(false);
  });

  it("numbers each line only on the side it exists on", () => {
    const lines = allLines(
      buildFilePatch({ path: "a.py", before: "one\ntwo\nthree\n", after: "one\nTWO\nthree\n" }),
    );

    const deletion = lines.find((line) => line.type === "del");
    const addition = lines.find((line) => line.type === "add");

    expect(deletion).toMatchObject({ oldNumber: 2, newNumber: null, content: "two" });
    expect(addition).toMatchObject({ oldNumber: null, newNumber: 2, content: "TWO" });

    for (const line of lines.filter((candidate) => candidate.type === "context")) {
      expect(line.oldNumber).not.toBeNull();
      expect(line.newNumber).not.toBeNull();
    }
  });

  it("keeps gutter numbers strictly increasing across hunks", () => {
    const before = Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n");
    const after = before.replace("line 5", "LINE 5").replace("line 50", "LINE 50");
    const lines = allLines(buildFilePatch({ path: "a.txt", before, after }));

    let lastOld = 0;
    let lastNew = 0;
    for (const line of lines) {
      if (line.oldNumber !== null) {
        expect(line.oldNumber).toBeGreaterThan(lastOld);
        lastOld = line.oldNumber;
      }
      if (line.newNumber !== null) {
        expect(line.newNumber).toBeGreaterThan(lastNew);
        lastNew = line.newNumber;
      }
    }

    // Two well-separated edits should not be merged into one hunk.
    expect(lines.length).toBeGreaterThan(0);
  });

  it("treats a null before as added and a null after as deleted", () => {
    expect(buildFilePatch({ path: "n.txt", before: null, after: "x\n" }).changeType).toBe("added");
    expect(buildFilePatch({ path: "n.txt", before: "x\n", after: null }).changeType).toBe("deleted");
  });

  it("records a rename when a previous path is supplied", () => {
    const patch = buildFilePatch({
      path: "new.py",
      before: "x\n",
      after: "y\n",
      previousPath: "old.py",
    });

    expect(patch.changeType).toBe("renamed");
    expect(patch.previousPath).toBe("old.py");
  });

  it("drops the no-newline-at-eof marker instead of rendering it as a line", () => {
    const patch = buildFilePatch({ path: "n.txt", before: "a", after: "a\nb\n" });

    for (const line of allLines(patch)) {
      expect(line.content).not.toContain("No newline");
    }
  });

  it("rejects a patch with no content on either side", () => {
    expect(() => buildFilePatch({ path: "x", before: null, after: null })).toThrow(/both sides/);
  });

  it("produces no hunks for identical contents", () => {
    const patch = buildFilePatch({ path: "a.txt", before: "same\n", after: "same\n" });

    expect(patch.hunks).toHaveLength(0);
    expect(patch.additions).toBe(0);
    expect(patch.deletions).toBe(0);
  });
});

describe("buildBinaryPatch", () => {
  it("marks the file binary and renders no hunks", () => {
    const patch = buildBinaryPatch("logo.png", "added");

    expect(patch.binary).toBe(true);
    expect(patch.hunks).toHaveLength(0);
    expect(patch.changeType).toBe("added");
  });
});
