import { extname } from "node:path";
import { z } from "zod";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";

const responseSchema = z.object({
  document: z.object({
    md_content: z.string().optional(),
    text_content: z.string().optional(),
  }),
  status: z.enum(["success", "partial_success", "skipped", "failure"]),
  processing_time: z.number().nonnegative(),
  timings: z.record(z.unknown()).optional(),
  errors: z.array(z.unknown()).default([]),
});

const formatByExtension: Record<string, "pdf" | "image" | "docx" | "pptx" | "xlsx"> = {
  pdf: "pdf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  tif: "image",
  tiff: "image",
  webp: "image",
  docx: "docx",
  pptx: "pptx",
  xlsx: "xlsx",
};

export type DoclingExtraction = {
  markdown: string;
  text?: string;
  processingTimeSeconds: number;
  status: "success" | "partial_success";
  errorCount: number;
};

export async function extractWithDocling(input: { filename: string; mimeType: string; bytes: Buffer }, signal?: AbortSignal): Promise<DoclingExtraction> {
  const extension = extname(input.filename).slice(1).toLowerCase();
  const format = formatByExtension[extension];
  if (!format) throw new AppError(415, "Docling does not support this artifact format", "EXTRACTION_FORMAT_UNSUPPORTED");

  const form = new FormData();
  const uploadBytes = Uint8Array.from(input.bytes);
  form.append("files", new Blob([uploadBytes], { type: input.mimeType }), input.filename);
  form.append("from_formats", format);
  form.append("to_formats", "md");
  form.append("to_formats", "text");
  form.append("do_ocr", String(format === "pdf" || format === "image"));
  form.append("force_ocr", "false");
  form.append("abort_on_error", "true");
  form.append("include_images", "false");
  form.append("image_export_mode", "placeholder");
  form.append("document_timeout", "300");

  const timeoutSignal = AbortSignal.timeout(env.DOCLING_REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetch(`${env.DOCLING_BASE_URL}/v1/convert/file`, {
      method: "POST",
      headers: { accept: "application/json", "x-api-key": env.DOCLING_API_KEY },
      body: form,
      signal: requestSignal,
    });
  } catch (error) {
    if (signal?.aborted) throw new AppError(503, "Document extraction was cancelled", "EXTRACTION_CANCELLED");
    if (requestSignal.aborted || (error instanceof Error && error.name === "TimeoutError")) throw new AppError(504, "Document extraction timed out", "EXTRACTION_TIMEOUT");
    throw new AppError(502, "Document extraction service is unavailable", "EXTRACTION_UNAVAILABLE");
  }
  if (!response.ok) throw new AppError(502, `Document extraction service failed with status ${response.status}`, "EXTRACTION_SERVICE_ERROR");

  let data: z.infer<typeof responseSchema>;
  try {
    data = responseSchema.parse(await response.json());
  } catch {
    throw new AppError(502, "Document extraction service returned an invalid response", "EXTRACTION_RESPONSE_INVALID");
  }
  if (data.status !== "success" && data.status !== "partial_success") throw new AppError(422, "Document extraction failed", "EXTRACTION_FAILED");
  const markdown = data.document.md_content?.trim();
  const text = data.document.text_content?.trim();
  if (!markdown && !text) throw new AppError(422, "Document extraction returned no content", "EXTRACTION_EMPTY");
  return { markdown: markdown ?? text!, text, processingTimeSeconds: data.processing_time, status: data.status, errorCount: data.errors.length };
}
