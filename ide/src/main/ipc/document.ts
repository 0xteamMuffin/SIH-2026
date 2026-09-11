import { writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import { BrowserWindow, dialog } from "electron";

import type { DocumentReadRequest } from "@shared/types.js";

import type { DocumentLibrary } from "../services/document-library.js";
import type { SessionManager } from "../services/session.js";
import { parseSpreadsheet } from "../services/spreadsheet.js";
import { handle } from "./typed-handle.js";

/** Extensions `parseSpreadsheet` knows how to read. */
const SPREADSHEET_EXTENSIONS = new Set([".xlsx", ".csv", ".tsv"]);

interface ReadDocument {
  bytes: Buffer;
  /** The document's own name, used to pick a parser. `null` if unknown. */
  filename: string | null;
}

/**
 * Reads a document's bytes.
 *
 * A locally-picked file comes from the library; an artifact the agent produced
 * is fetched from the backend, so a generated approval note previews in the
 * thread exactly like an attached one.
 *
 * Which of the two applies is decided by the caller's `sourceType`, never by
 * probing. Library registrations are per-session, so a local id that has aged
 * out must fail as a stale local document — inferring "absent from the library
 * therefore it is an artifact" would send a local id to the backend, where it
 * surfaces as an unrelated 404 rather than the truth.
 */
async function readDocument(
  library: DocumentLibrary,
  session: SessionManager,
  request: DocumentReadRequest,
): Promise<ReadDocument> {
  if (request.sourceType === "file") {
    if (!library.has(request.documentId)) {
      throw new Error("This document is no longer registered. Open it again to preview it.");
    }
    return {
      bytes: await library.read(request.documentId),
      filename: basename(library.pathFor(request.documentId)),
    };
  }

  const artifact = await session.requireClient().downloadArtifact(request.documentId);
  return { bytes: artifact.bytes, filename: artifact.filename };
}

export function registerDocumentHandlers(library: DocumentLibrary, session: SessionManager): void {
  handle("document:pick", (_request, event) =>
    library.pick(BrowserWindow.fromWebContents(event.sender)),
  );

  handle("document:read", async (request) => {
    const { bytes } = await readDocument(library, session, request);
    // Hand over a standalone ArrayBuffer. `bytes.buffer` may be a slice of a
    // larger pooled allocation, so sending it directly would leak unrelated
    // memory across the IPC boundary.
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  });

  handle("document:save", async ({ filename, ...request }, event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = window
      ? await dialog.showSaveDialog(window, { defaultPath: filename })
      : await dialog.showSaveDialog({ defaultPath: filename });
    if (result.canceled || !result.filePath) return null;

    // Bytes are fetched only after a destination is chosen, so cancelling
    // costs nothing and never downloads a large artifact needlessly.
    const { bytes } = await readDocument(library, session, request);
    await writeFile(result.filePath, bytes);
    return result.filePath;
  });

  handle("document:read-spreadsheet", async (request) => {
    const { bytes, filename } = await readDocument(library, session, request);
    // The parser is chosen by extension, and for an artifact that name now
    // comes from the server rather than an assumption that every generated
    // file is a workbook. A name we positively recognise as something else is
    // rejected here, so a .docx reaching this handler says so instead of
    // failing somewhere inside the workbook parser.
    const extension = filename ? extname(filename).toLowerCase() : "";
    if (extension && !SPREADSHEET_EXTENSIONS.has(extension)) {
      throw new Error(`${filename} is not a spreadsheet — expected .xlsx, .csv or .tsv.`);
    }
    return parseSpreadsheet(filename ?? "workbook.xlsx", bytes);
  });
}
