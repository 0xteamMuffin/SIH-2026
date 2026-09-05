import type { PreviewCapabilities } from "@shared/types.js";

/**
 * Which document families this build can render.
 *
 * The renderer asks main rather than assuming, so an unimplemented viewer
 * shows an honest reason instead of a blank frame. The remaining gaps are
 * recorded in `ide/docs/DOCUMENT_PREVIEW.md`.
 */
export function previewCapabilities(): PreviewCapabilities {
  return {
    pdf: { kind: "pdf", supported: true },
    spreadsheet: { kind: "spreadsheet", supported: true },
    wordprocessing: { kind: "wordprocessing", supported: true },
    image: { kind: "image", supported: true },
    text: { kind: "text", supported: true },
    unknown: {
      kind: "unknown",
      supported: false,
      reason: "No preview for this file type.",
    },
  };
}
