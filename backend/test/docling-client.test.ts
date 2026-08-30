import { afterEach, describe, expect, it, vi } from "vitest";
import { extractWithDocling } from "../src/infrastructure/docling/docling-client.js";

describe("Docling client", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends one PDF as authenticated multipart with OCR enabled", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      document: { md_content: "# Inspection\n\nPump is operational.", text_content: "Inspection\nPump is operational." },
      status: "success",
      processing_time: 1.25,
      timings: {},
      errors: [],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(extractWithDocling({ filename: "inspection.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.7") })).resolves.toMatchObject({
      markdown: "# Inspection\n\nPump is operational.",
      status: "success",
      processingTimeSeconds: 1.25,
    });

    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:5001/v1/convert/file");
    expect(request?.headers).toMatchObject({ "x-api-key": "test-docling-api-key" });
    const form = request?.body as FormData;
    expect(form.getAll("files")).toHaveLength(1);
    expect(form.getAll("from_formats")).toEqual(["pdf"]);
    expect(form.getAll("to_formats")).toEqual(["md", "text"]);
    expect(form.get("do_ocr")).toBe("true");
    expect(form.get("document_timeout")).toBe("300");
  });

  it("disables OCR for Office documents", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ document: { md_content: "Slides" }, status: "success", processing_time: 0.5, errors: [] }), { status: 200 }));

    await extractWithDocling({ filename: "brief.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", bytes: Buffer.from("zip") });

    const form = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(form.get("from_formats")).toBe("pptx");
    expect(form.get("do_ocr")).toBe("false");
  });

  it("rejects malformed successful responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ status: "success" }), { status: 200 }));

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
