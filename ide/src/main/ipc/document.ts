import { writeFile } from "node:fs/promises";

import { BrowserWindow, dialog } from "electron";

import type { DocumentLibrary } from "../services/document-library.js";
import type { SessionManager } from "../services/session.js";
import { parseSpreadsheet } from "../services/spreadsheet.js";
import { handle } from "./typed-handle.js";

/**
 * Reads a document's bytes.
 *
 * A locally-picked file comes from the library; an artifact the agent produced
 * is fetched from the backend, so a generated approval note previews in the
 * thread exactly like an attached one.
 */
async function readDocumentBytes(
  library: DocumentLibrary,
  session: SessionManager,
  documentId: string,
): Promise<Buffer> {
  if (library.has(documentId)) return library.read(documentId);
  return session.requireClient().downloadArtifact(documentId);
}

export function registerDocumentHandlers(library: DocumentLibrary, session: SessionManager): void {
  handle("document:pick", (_request, event) =>
    library.pick(BrowserWindow.fromWebContents(event.sender)),
  );

  handle("document:read", async (documentId) => {
    const bytes = await readDocumentBytes(library, session, documentId);
    // Hand over a standalone ArrayBuffer. `bytes.buffer` may be a slice of a
    // larger pooled allocation, so sending it directly would leak unrelated
    // memory across the IPC boundary.
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  });

  handle("document:save", async ({ documentId, filename }, event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = window
      ? await dialog.showSaveDialog(window, { defaultPath: filename })
      : await dialog.showSaveDialog({ defaultPath: filename });
    if (result.canceled || !result.filePath) return null;

    // Bytes are fetched only after a destination is chosen, so cancelling
    // costs nothing and never downloads a large artifact needlessly.
    await writeFile(result.filePath, await readDocumentBytes(library, session, documentId));
    return result.filePath;
  });

  handle("document:read-spreadsheet", async (documentId) => {
    const bytes = await readDocumentBytes(library, session, documentId);
    // Backend artifacts have no local path; the filename drives the parser
    // choice, and generated workbooks are always xlsx.
    const name = library.has(documentId) ? library.pathFor(documentId) : "artifact.xlsx";
    return parseSpreadsheet(name, bytes);
  });
}
