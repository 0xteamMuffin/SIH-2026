import { describe, expect, it } from "vitest";
import {
  createExtractionProvenanceSidecar,
  localTextProvenance,
  parseExtractionProvenanceSidecar,
} from "../src/infrastructure/extraction/extraction-provenance.js";

describe("extraction provenance sidecar", () => {
  it("maps local CRLF, LF, and CR lines to exact character ranges", () => {
    const text = "Alpha\r\nBeta\nGamma\rDelta";

    expect(localTextProvenance(text)).toEqual([
      expect.objectContaining({ startChar: 0, endChar: 7, provenance: expect.objectContaining({ lineStart: 1, lineEnd: 1, charStart: 0, charEnd: 7 }) }),
      expect.objectContaining({ startChar: 7, endChar: 12, provenance: expect.objectContaining({ lineStart: 2, lineEnd: 2, charStart: 7, charEnd: 12 }) }),
      expect.objectContaining({ startChar: 12, endChar: 18, provenance: expect.objectContaining({ lineStart: 3, lineEnd: 3, charStart: 12, charEnd: 18 }) }),
      expect.objectContaining({ startChar: 18, endChar: 23, provenance: expect.objectContaining({ lineStart: 4, lineEnd: 4, charStart: 18, charEnd: 23 }) }),
    ]);
  });

  it("rejects a sidecar when canonical text no longer matches", () => {
    const text = "Original text";
    const sidecar = createExtractionProvenanceSidecar({
      sourceSha256: "a".repeat(64),
      canonicalText: text,
      blocks: localTextProvenance(text),
    });

    expect(() => parseExtractionProvenanceSidecar(Buffer.from(JSON.stringify(sidecar)), "Changed text!")).toThrow(/checksum/);
  });
});
