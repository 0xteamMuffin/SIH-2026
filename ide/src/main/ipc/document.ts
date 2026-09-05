import { BrowserWindow } from "electron";

import type { DocumentLibrary } from "../services/document-library.js";
import { parseSpreadsheet } from "../services/spreadsheet.js";
import { handle } from "./typed-handle.js";

export function registerDocumentHandlers(library: DocumentLibrary): void {
  handle("document:pick", (_request, event) =>
    library.pick(BrowserWindow.fromWebContents(event.sender)),
  );

  handle("document:read", async (documentId) => {
    const bytes = await library.read(documentId);
    // Hand over a standalone ArrayBuffer. `bytes.buffer` may be a slice of a
    // larger pooled allocation, so sending it directly would leak unrelated
    // memory across the IPC boundary.
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  });

  handle("document:read-spreadsheet", async (documentId) => {
    const bytes = await library.read(documentId);
    return parseSpreadsheet(library.pathFor(documentId), bytes);
  });
}
