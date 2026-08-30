import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPdfPages } from "../src/infrastructure/pdf-renderer/pdf-renderer-client.js";

function responseBody(metadata: object, images: Buffer[]) {
  const manifest = Buffer.from(JSON.stringify(metadata));
  const manifestLength = Buffer.alloc(4);
  manifestLength.writeUInt32BE(manifest.byteLength);
  const parts = [Buffer.from("SIHPDF01"), manifestLength, manifest];
  for (const image of images) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(image.byteLength);
    parts.push(length, image);
  }
  return Buffer.concat(parts);
}

function png(width: number, height: number) {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe("PDF renderer client", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects a missing PDF signature without contacting the sidecar", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(renderPdfPages(Buffer.from("not-pdf"))).rejects.toMatchObject({ status: 415, code: "PDF_SIGNATURE_INVALID" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("decodes bounded PNG pages", async () => {
    const image = png(100, 200);
    const metadata = { renderer: "pdfjs-dist", rendererVersion: "6.3.289", sourcePageCount: 4, selectionPolicy: "representative", dpi: 144, totalBytes: image.byteLength, pages: [{ pageNumber: 4, width: 100, height: 200, sizeBytes: image.byteLength }] };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(responseBody(metadata, [image]), { status: 200, headers: { "content-type": "application/vnd.sih.pdf-pages" } }));

    const result = await renderPdfPages(Buffer.from("%PDF-1.7"));

    expect(result.pages[0]).toEqual({ ...metadata.pages[0], bytes: image });
    expect(fetch).toHaveBeenCalledWith("http://localhost:4200/v1/render", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ authorization: expect.stringMatching(/^Bearer /), "x-pdf-pages": "auto" }),
      signal: expect.any(AbortSignal),
    }));
  });

  it("rejects response metadata that does not match the binary payload", async () => {
    const image = png(10, 10);
    const metadata = { renderer: "pdfjs-dist", rendererVersion: "6.3.289", sourcePageCount: 1, selectionPolicy: "all-within-limit", dpi: 144, totalBytes: 999, pages: [{ pageNumber: 1, width: 10, height: 10, sizeBytes: image.byteLength }] };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(responseBody(metadata, [image]), { status: 200, headers: { "content-type": "application/vnd.sih.pdf-pages" } }));

    await expect(renderPdfPages(Buffer.from("%PDF-1.7"))).rejects.toMatchObject({ status: 502, code: "PDF_RENDER_RESPONSE_INVALID" });
  });
});
