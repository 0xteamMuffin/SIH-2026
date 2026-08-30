import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { generatePptx, HUMAN_REVIEW_NOTICE } from "../src/modules/deliverables/pptx-generator.js";
import { pptxDeliverableInputSchema, type PptxDeliverableInput } from "../src/modules/deliverables/deliverable-schemas.js";

const input: PptxDeliverableInput = {
  title: "Compressor & Reliability Review",
  subtitle: "Train C-201 operating evidence",
  sections: [{
    title: "Condition assessment",
    summary: "The train remains available, with vibration requiring a controlled follow-up inspection.",
    findings: [{
      title: "Drive-end vibration is elevated",
      detail: "The latest route reading is above the internal alert threshold but remains below the trip threshold.",
      severity: "medium",
      citationIds: ["SRC-01"],
    }],
  }],
  citations: [{ id: "SRC-01", title: "C-201 route report", source: "artifact://route-report-2026-08.pdf", locator: "Page 14, reading VR-882" }],
};

async function xml(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path);
  expect(file, `Missing OOXML part: ${path}`).not.toBeNull();
  return file!.async("string");
}

describe("PPTX deliverable generator", () => {
  it("creates a cited, editable presentation with valid core OOXML parts", async () => {
    const zip = await JSZip.loadAsync(await generatePptx(input));
    const requiredParts = [
      "[Content_Types].xml",
      "_rels/.rels",
      "docProps/core.xml",
      "ppt/presentation.xml",
      "ppt/_rels/presentation.xml.rels",
      "ppt/slides/slide1.xml",
    ];
    requiredParts.forEach((part) => expect(zip.file(part), `Missing OOXML part: ${part}`).not.toBeNull());

    const contentTypes = await xml(zip, "[Content_Types].xml");
    const rootRelationships = await xml(zip, "_rels/.rels");
    const presentation = await xml(zip, "ppt/presentation.xml");
    const presentationRelationships = await xml(zip, "ppt/_rels/presentation.xml.rels");
    const core = await xml(zip, "docProps/core.xml");
    const slideParts = Object.keys(zip.files).filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path));
    const slideXml = (await Promise.all(slideParts.map((path) => xml(zip, path)))).join("\n");

    expect(contentTypes).toContain("application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml");
    expect(rootRelationships).toContain('Target="ppt/presentation.xml"');
    expect(presentationRelationships).toContain("/relationships/slide");
    expect((presentation.match(/<p:sldId /g) ?? [])).toHaveLength(5);
    expect(slideParts).toHaveLength(5);
    expect(slideXml).toContain("Compressor &amp; Reliability Review");
    expect(slideXml).toContain("[SRC-01]");
    expect(slideXml).toContain("artifact://route-report-2026-08.pdf");
    expect(slideXml).toContain(HUMAN_REVIEW_NOTICE);
    expect(core).toContain("SIH Deliverable Generator");
    expect(core).toContain("Compressor &amp; Reliability Review");
    expect(Object.keys(zip.files).some((path) => /vbaProject|externalLinks/i.test(path))).toBe(false);
  });

  it("rejects overlong text and unresolved source references", () => {
    expect(pptxDeliverableInputSchema.safeParse({ ...input, title: "x".repeat(161) }).success).toBe(false);
    expect(pptxDeliverableInputSchema.safeParse({
      ...input,
      sections: [{ ...input.sections[0], findings: [{ ...input.sections[0].findings[0], citationIds: ["MISSING"] }] }],
    }).success).toBe(false);
  });
});
