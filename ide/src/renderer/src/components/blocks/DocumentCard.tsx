import { useState } from "react";

import type { DocumentKind, DocumentRef, PreviewCapabilities } from "@shared/types.js";

import { viewerFor } from "../preview/registry.js";

const KIND_LABELS: Record<DocumentKind, string> = {
  pdf: "PDF",
  spreadsheet: "Spreadsheet",
  wordprocessing: "Document",
  image: "Image",
  text: "Text",
  unknown: "File",
};

const KIND_ICONS: Record<DocumentKind, string> = {
  pdf: "▤",
  spreadsheet: "▦",
  wordprocessing: "▤",
  image: "◲",
  text: "≡",
  unknown: "▤",
};

export interface DocumentCardProps {
  document: DocumentRef;
  capabilities: PreviewCapabilities | null;
}

/**
 * A file the agent produced or the user attached.
 *
 * Previews are collapsed by default and mounted only once expanded. A chat
 * thread can accumulate many documents, and rendering every PDF and workbook
 * eagerly would parse megabytes nobody asked to see.
 */
export function DocumentCard({ document, capabilities }: DocumentCardProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  function save(): void {
    setSaveState("saving");
    setSaveError(null);
    window.workbench.documents
      .save(document.id, document.filename)
      .then((path) => setSaveState(path ? "saved" : "idle"))
      .catch((cause: unknown) => {
        setSaveState("idle");
        setSaveError(cause instanceof Error ? cause.message : String(cause));
      });
  }

  const capability = capabilities?.[document.kind];
  const Viewer = viewerFor(document.kind);
  const canPreview = Boolean(Viewer) && capability?.supported === true;

  return (
    <figure className="document-card">
      <div className="document-card__header">
        <span className="document-card__icon" aria-hidden="true">
          {KIND_ICONS[document.kind]}
        </span>

        <span className="document-card__meta">
          <span className="document-card__name">{document.filename}</span>
          <span className="document-card__sub">
            {KIND_LABELS[document.kind]} · {formatBytes(document.byteSize)}
          </span>
        </span>

        <span className="document-card__actions">
          {canPreview && (
            <button
              type="button"
              className="document-card__toggle"
              onClick={() => setIsExpanded((expanded) => !expanded)}
              aria-expanded={isExpanded}
            >
              {isExpanded ? "Hide" : "Preview"}
            </button>
          )}
          <button
            type="button"
            className="document-card__toggle"
            onClick={save}
            disabled={saveState === "saving"}
          >
            {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : "Save"}
          </button>
        </span>
      </div>

      {canPreview && isExpanded && Viewer && (
        <div className="document-card__viewer">
          <Viewer document={document} />
        </div>
      )}

      {saveError && <p className="document-card__unavailable">{saveError}</p>}

      {!canPreview && (
        <p className="document-card__unavailable">
          {capability?.reason ?? "Preview not available for this file type."}
        </p>
      )}
    </figure>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;

  const units = ["kB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`;
}
