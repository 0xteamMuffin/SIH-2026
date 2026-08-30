import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractWithDocling } from "../src/infrastructure/docling/docling-client.js";

describe("Docling client", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends one PDF as authenticated multipart with OCR enabled", async () => {
    const fixture = await readFile(new URL("./fixtures/docling-structured-response.json", import.meta.url), "utf8");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(fixture, { status: 200, headers: { "content-type": "application/json" } }));

    const extracted = await extractWithDocling({ filename: "inspection.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.7") });
    expect(extracted).toMatchObject({
      markdown: expect.stringContaining("# Inspection\n\nPump is operational."),
      status: "success",
      processingTimeSeconds: 1.25,
    });

    expect(extracted.sourceBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ elementType: "heading", provenance: expect.objectContaining({ page: 1, bbox: [10, 20, 200, 40], pageNumbers: [1], heading: { level: 1, title: "Inspection" } }) }),
      expect.objectContaining({ elementType: "table", provenance: expect.objectContaining({ pageNumbers: [2], tableIndex: 0 }) }),
      expect.objectContaining({ elementType: "picture", provenance: expect.objectContaining({ pageNumbers: [2], pictureIndex: 0 }) }),
    ]));
    expect(extracted.sourceBlocks[0].provenance).toMatchObject({ boundingBoxes: [{ pageNumber: 1, left: 10, top: 20, right: 200, bottom: 40, coordinateOrigin: "TOPLEFT" }] });

    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:5001/v1/convert/file");
    expect(request?.headers).toMatchObject({ "x-api-key": "test-docling-api-key" });
    const form = request?.body as FormData;
    expect(form.getAll("files")).toHaveLength(1);
    expect(form.getAll("from_formats")).toEqual(["pdf"]);
    expect(form.getAll("to_formats")).toEqual(["md", "text", "json"]);
    expect(form.get("do_ocr")).toBe("true");
    expect(form.get("document_timeout")).toBe("300");
  });

  it("disables OCR for Office documents", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ document: { md_content: "Slides", json_content: { texts: [], tables: [], pictures: [], groups: [] } }, status: "success", processing_time: 0.5, errors: [] }), { status: 200 }));

    await extractWithDocling({ filename: "brief.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", bytes: Buffer.from("zip") });

    const form = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(form.get("from_formats")).toBe("pptx");
    expect(form.get("do_ocr")).toBe("false");
  });

  it("rejects malformed successful responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      document: { md_content: "Invalid structure", json_content: { texts: "not-an-array" } },
      status: "success",
      processing_time: 0.1,
      errors: [],
    }), { status: 200 }));

    await expect(extractWithDocling({ filename: "drawing.png", mimeType: "image/png", bytes: Buffer.from("png") })).rejects.toMatchObject({ code: "EXTRACTION_RESPONSE_INVALID", status: 502 });
  });

  it("normalizes caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("aborted", "AbortError"));

    await expect(extractWithDocling({ filename: "drawing.png", mimeType: "image/png", bytes: Buffer.from("png") }, controller.signal)).rejects.toMatchObject({ code: "EXTRACTION_CANCELLED" });
  });

  it("normalizes request timeouts", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("timed out", "TimeoutError"));

    await expect(extractWithDocling({ filename: "drawing.png", mimeType: "image/png", bytes: Buffer.from("png") })).rejects.toMatchObject({ code: "EXTRACTION_TIMEOUT", status: 504 });
  });
});
