import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chunkCanonicalText, DEFAULT_TEXT_CHUNKER_OPTIONS } from "../src/modules/knowledge/text-chunker.js";

describe("citation-ready text chunker", () => {
  it("returns stable citation metadata for structured canonical text", () => {
    const text = "# Plant Manual\n\nIntroductory paragraph.\n\n## Pumps\n\n- P-101\n- P-102\n\n| Tag | State |\n| --- | --- |\n| P-101 | Ready |";

    const first = chunkCanonicalText({ text, sourceId: "artifact-7" });
    const second = chunkCanonicalText({ text, sourceId: "artifact-7" });

    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
    expect(first[0]).toMatchObject({
      index: 0,
      headingPath: ["Plant Manual"],
      lineRange: { start: 1, end: 3 },
      elementTypes: ["heading", "paragraph"],
    });
    expect(first[1]).toMatchObject({
      index: 1,
      headingPath: ["Plant Manual", "Pumps"],
      lineRange: { start: 5, end: 12 },
      elementTypes: ["heading", "list", "table"],
    });
    for (const chunk of first) {
      expect(chunk.text).toBe(text.slice(chunk.charRange.start, chunk.charRange.end));
      expect(chunk.contentHash).toBe(createHash("sha256").update(chunk.text).digest("hex"));
      expect(chunk.pointId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it("tracks nested and replacement heading paths without crossing sections", () => {
    const text = "# A\n\nA body.\n\n### C\n\nC body.\n\n## B\n\nB body.";
    expect(chunkCanonicalText({ text }).map((chunk) => chunk.headingPath)).toEqual([["A"], ["A", "C"], ["A", "B"]]);
  });

  it("keeps ordinary paragraphs whole while approaching the target", () => {
    const paragraphs = Array.from({ length: 8 }, (_, index) => `${index}: ${"x".repeat(92)}`);
    const text = paragraphs.join("\n\n");
    const chunks = chunkCanonicalText({ text }, { targetChars: 300, maxChars: 360, overlapChars: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.length <= 360)).toBe(true);
    for (const paragraph of paragraphs) expect(chunks.some((chunk) => chunk.text.includes(paragraph))).toBe(true);
  });

  it("uses only whole trailing elements for bounded overlap", () => {
    const paragraphs = Array.from({ length: 7 }, (_, index) => `Paragraph ${index} ${"p".repeat(47)}`);
    const text = paragraphs.join("\n\n");
    const chunks = chunkCanonicalText({ text }, { targetChars: 180, maxChars: 240, overlapChars: 70 });

    expect(chunks.length).toBeGreaterThan(1);
    for (let index = 1; index < chunks.length; index += 1) {
      const overlap = Math.max(0, chunks[index - 1].charRange.end - chunks[index].charRange.start);
      expect(overlap).toBeLessThanOrEqual(70);
      expect(overlap).toBeGreaterThan(0);
      expect(chunks[index].text.slice(0, overlap)).toBe(chunks[index - 1].text.slice(-overlap));
    }
  });

  it("splits only oversized elements and never exceeds the configured maximum", () => {
    const text = `# Long\n\n${Array.from({ length: 300 }, (_, index) => `word${index}`).join(" ")}`;
    const chunks = chunkCanonicalText({ text }, { targetChars: 100, maxChars: 120, overlapChars: 20 });

    expect(chunks.length).toBeGreaterThan(10);
    expect(chunks.every((chunk) => chunk.text.length <= 120)).toBe(true);
    expect(chunks.every((chunk) => chunk.headingPath.join("/") === "Long")).toBe(true);
  });

  it("handles an unbroken token and does not split a surrogate pair", () => {
    const text = `${"a".repeat(49)}😀${"b".repeat(80)}`;
    const chunks = chunkCanonicalText({ text }, { targetChars: 50, maxChars: 60, overlapChars: 0 });

    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
    expect(chunks.every((chunk) => !chunk.text.includes("�") && chunk.text.length <= 60)).toBe(true);
  });

  it("maps source-block provenance and clips it to chunk-relative ranges", () => {
    const text = "First paragraph.\n\nSecond paragraph.";
    const secondStart = text.indexOf("Second");
    const chunks = chunkCanonicalText({
      text,
      sourceId: "source-1",
      provenance: { filename: "manual.pdf" },
      sourceBlocks: [{
        id: "page-2-block-4",
        startChar: secondStart,
        endChar: text.length,
        elementType: "quote",
        provenance: { page: 2, bbox: [1, 2, 3, 4] },
      }],
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].provenance).toEqual({ filename: "manual.pdf" });
    expect(chunks[0].elementTypes).toEqual(["paragraph", "quote"]);
    expect(chunks[0].sourceBlocks).toEqual([{
      id: "page-2-block-4",
      elementType: "quote",
      charRange: { start: secondStart, end: text.length },
      chunkCharRange: { start: secondStart, end: text.length },
      provenance: { page: 2, bbox: [1, 2, 3, 4] },
    }]);
  });

  it("reports line ranges correctly for CRLF, LF, and CR", () => {
    const text = "# H\r\n\r\nOne.\n\nTwo.\r\rThree.";
    const chunks = chunkCanonicalText({ text });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].lineRange).toEqual({ start: 1, end: 7 });
  });

  it("changes point identity by source but not the content hash", () => {
    const text = "Same canonical content.";
    const left = chunkCanonicalText({ text, sourceId: "left" })[0];
    const right = chunkCanonicalText({ text, sourceId: "right" })[0];
    expect(left.contentHash).toBe(right.contentHash);
    expect(left.pointId).not.toBe(right.pointId);
  });

  it("returns no chunks for empty or whitespace-only input", () => {
    expect(chunkCanonicalText({ text: "" })).toEqual([]);
    expect(chunkCanonicalText({ text: " \r\n\t" })).toEqual([]);
  });

  it("enforces hard limits, source ranges, and the maximum chunk count", () => {
    expect(DEFAULT_TEXT_CHUNKER_OPTIONS).toEqual({ targetChars: 1_800, maxChars: 2_400, overlapChars: 240, maxChunks: 10_000 });
    expect(() => chunkCanonicalText({ text: "value" }, { maxChars: 2_401 })).toThrow(/maxChars/);
    expect(() => chunkCanonicalText({ text: "value" }, { overlapChars: 241 })).toThrow(/overlapChars/);
    expect(() => chunkCanonicalText({ text: "value", sourceBlocks: [{ startChar: 0, endChar: 10 }] })).toThrow(/sourceBlocks\[0]/);

    const text = Array.from({ length: 5 }, (_, index) => `Paragraph ${index}.`).join("\n\n");
    expect(() => chunkCanonicalText({ text }, { targetChars: 12, maxChars: 15, overlapChars: 0, maxChunks: 2 })).toThrow(/maxChunks \(2\)/);
  });
});
