import { extname } from "node:path";
import { fileTypeFromBuffer } from "file-type";
import { AppError } from "../../lib/errors.js";

const binaryFormats = new Map([
  ["pdf", "application/pdf"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["tif", "image/tiff"],
  ["webp", "image/webp"],
  ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
]);
const textFormats = new Map([
  ["txt", "text/plain"],
  ["md", "text/markdown"],
  ["csv", "text/csv"],
]);
const extensionAliases: Record<string, string> = { jpeg: "jpg", tiff: "tif" };

export type ValidatedArtifact = { extension: string; mimeType: string };

export async function validateSourceArtifact(filename: string, bytes: Buffer): Promise<ValidatedArtifact> {
  const rawExtension = extname(filename).slice(1).toLowerCase();
  const extension = extensionAliases[rawExtension] ?? rawExtension;
  if (!binaryFormats.has(extension) && !textFormats.has(extension)) {
    throw new AppError(415, "Unsupported file format", "UNSUPPORTED_FILE_TYPE");
  }

  const detected = await fileTypeFromBuffer(bytes);
  if (binaryFormats.has(extension)) {
    const detectedExtension = detected ? (extensionAliases[detected.ext] ?? detected.ext) : undefined;
    if (!detected || detectedExtension !== extension) {
      throw new AppError(415, "File content does not match its extension", "FILE_TYPE_MISMATCH");
    }
    return { extension, mimeType: binaryFormats.get(extension)! };
  }

  if (detected || bytes.includes(0)) throw new AppError(415, "Text file contains binary content", "FILE_TYPE_MISMATCH");
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AppError(415, "Text file must use UTF-8 encoding", "INVALID_TEXT_ENCODING");
  }
  return { extension, mimeType: textFormats.get(extension)! };
}
