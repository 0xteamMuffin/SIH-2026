import type { ComponentType } from "react";

import type { DocumentKind, DocumentRef } from "@shared/types.js";

import { DocxViewer } from "./DocxViewer.js";
import { ImageViewer } from "./ImageViewer.js";
import { PdfViewer } from "./PdfViewer.js";
import { SpreadsheetViewer } from "./SpreadsheetViewer.js";
import { TextViewer } from "./TextViewer.js";

export interface DocumentViewerProps {
  document: DocumentRef;
}

export type DocumentViewer = ComponentType<DocumentViewerProps>;

/**
 * Viewers, keyed by document family.
 *
 * This map plus `preview:capabilities` in main are the whole extension point:
 * a family with no entry falls back to an honest "no preview" card. Parsing
 * strategy differs per family — see `ide/docs/DOCUMENT_PREVIEW.md` — but that
 * is each viewer's business, not this table's.
 */
export const DOCUMENT_VIEWERS: Partial<Record<DocumentKind, DocumentViewer>> = {
  pdf: PdfViewer,
  spreadsheet: SpreadsheetViewer,
  wordprocessing: DocxViewer,
  image: ImageViewer,
  text: TextViewer,
};

export function viewerFor(kind: DocumentKind): DocumentViewer | null {
  return DOCUMENT_VIEWERS[kind] ?? null;
}
