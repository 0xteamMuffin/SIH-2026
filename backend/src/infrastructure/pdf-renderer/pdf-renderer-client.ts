import { z } from "zod";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";

const MAGIC = Buffer.from("SIHPDF01", "ascii");
const metadataSchema = z.object({
  renderer: z.string().min(1).max(100),
  rendererVersion: z.string().min(1).max(100),
  sourcePageCount: z.number().int().positive(),
  selectionPolicy: z.enum(["explicit", "all-within-limit", "representative"]),
  dpi: z.number().int().positive(),
  totalBytes: z.number().int().nonnegative(),
  pages: z.array(z.object({ pageNumber: z.number().int().positive(), width: z.number().int().positive(), height: z.number().int().positive(), sizeBytes: z.number().int().positive() })),
}).strict();

export type RenderedPdfPage = { pageNumber: number; width: number; height: number; sizeBytes: number; bytes: Buffer };
export type RenderedPdf = Omit<z.infer<typeof metadataSchema>, "pages"> & { pages: RenderedPdfPage[] };

function assertPdfSignature(bytes: Buffer) {
  if (bytes.byteLength < 5 || !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new AppError(415, "PDF signature is invalid", "PDF_SIGNATURE_INVALID");
  }
}

async function readResponseBounded(response: Response, maximum: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new AppError(502, "PDF renderer response exceeded its byte limit", "PDF_RENDER_RESPONSE_TOO_LARGE");
  if (!response.body) throw new AppError(502, "PDF renderer returned an empty response", "PDF_RENDER_RESPONSE_INVALID");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maximum) throw new AppError(502, "PDF renderer response exceeded its byte limit", "PDF_RENDER_RESPONSE_TOO_LARGE");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function decodeResponse(body: Buffer): RenderedPdf {
  try {
    if (body.byteLength < 12 || !body.subarray(0, 8).equals(MAGIC)) throw new Error();
    const manifestLength = body.readUInt32BE(8);
    let offset = 12 + manifestLength;
    if (manifestLength > 64 * 1024 || offset > body.byteLength) throw new Error();
    const metadata = metadataSchema.parse(JSON.parse(body.subarray(12, offset).toString("utf8")));
    if (metadata.pages.length < 1 || metadata.pages.length > env.PDF_RENDER_MAX_PAGES || metadata.dpi > env.PDF_RENDER_DPI) throw new Error();
    const pages = metadata.pages.map((page) => {
      if (offset + 4 > body.byteLength) throw new Error();
      const length = body.readUInt32BE(offset);
      offset += 4;
      if (length !== page.sizeBytes || offset + length > body.byteLength || page.width * page.height > env.PDF_RENDER_MAX_PIXELS_PER_PAGE) throw new Error();
      const bytes = body.subarray(offset, offset + length);
      offset += length;
      if (bytes.byteLength < 24 || !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error();
      if (bytes.readUInt32BE(16) !== page.width || bytes.readUInt32BE(20) !== page.height) throw new Error();
      return { ...page, bytes };
    });
    const totalBytes = pages.reduce((sum, page) => sum + page.sizeBytes, 0);
    if (offset !== body.byteLength || totalBytes !== metadata.totalBytes || totalBytes > env.PDF_RENDER_MAX_TOTAL_BYTES) throw new Error();
    if (new Set(pages.map((page) => page.pageNumber)).size !== pages.length || pages.some((page) => page.pageNumber > metadata.sourcePageCount)) throw new Error();
    return { ...metadata, pages };
  } catch {
    throw new AppError(502, "PDF renderer returned an invalid response", "PDF_RENDER_RESPONSE_INVALID");
  }
}

export async function renderPdfPages(bytes: Buffer, signal?: AbortSignal, pages?: number[]): Promise<RenderedPdf> {
  if (bytes.byteLength < 1 || bytes.byteLength > env.PDF_RENDER_MAX_SOURCE_BYTES) {
    throw new AppError(413, `PDF must contain between 1 and ${env.PDF_RENDER_MAX_SOURCE_BYTES} bytes`, "PDF_SOURCE_TOO_LARGE");
  }
  assertPdfSignature(bytes);
  if (pages && (pages.length < 1 || pages.length > env.PDF_RENDER_MAX_PAGES || pages.some((page) => !Number.isInteger(page) || page < 1))) {
    throw new AppError(422, "PDF page selection is invalid", "PDF_PAGE_SELECTION_INVALID");
  }
  const timeoutSignal = AbortSignal.timeout(env.PDF_RENDER_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetch(`${env.PDF_RENDERER_URL}/v1/render`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.PDF_RENDERER_API_TOKEN}`, "content-type": "application/pdf", "x-pdf-pages": pages?.join(",") ?? "auto" },
      body: Uint8Array.from(bytes),
      signal: requestSignal,
    });
  } catch (error) {
    if (signal?.aborted) throw new AppError(503, "PDF rendering was cancelled", "PDF_RENDER_CANCELLED");
    if (requestSignal.aborted || (error instanceof Error && error.name === "TimeoutError")) throw new AppError(504, "PDF rendering timed out", "PDF_RENDER_TIMEOUT");
    throw new AppError(502, "PDF renderer is unavailable", "PDF_RENDER_UNAVAILABLE");
  }
  if (!response.ok) {
    if (response.status === 413) throw new AppError(413, "PDF renderer rejected the bounded input or output", "PDF_RENDER_LIMIT_EXCEEDED");
    if (response.status === 429) throw new AppError(503, "PDF renderer is busy", "PDF_RENDER_BUSY");
    if (response.status === 504) throw new AppError(504, "PDF rendering timed out", "PDF_RENDER_TIMEOUT");
    throw new AppError(422, `PDF rendering failed with status ${response.status}`, "PDF_RENDER_FAILED");
  }
  if (response.headers.get("content-type") !== "application/vnd.sih.pdf-pages") throw new AppError(502, "PDF renderer returned an invalid content type", "PDF_RENDER_RESPONSE_INVALID");
  return decodeResponse(await readResponseBounded(response, env.PDF_RENDER_MAX_TOTAL_BYTES + 64 * 1024));
}
