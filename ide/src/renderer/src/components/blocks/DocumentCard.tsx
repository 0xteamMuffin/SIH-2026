import { useState } from "react";

import type { DocumentKind, DocumentRef, PreviewCapabilities } from "@shared/types.js";

import { viewerFor } from "../preview/registry.js";
import { Icon, type IconName } from "../ui/Icon.js";
import { IconButton } from "../ui/IconButton.js";

const KIND_LABELS: Record<DocumentKind, string> = {
  pdf: "PDF",
  spreadsheet: "Spreadsheet",
  wordprocessing: "Document",
  image: "Image",
  text: "Text",
  unknown: "File",
};

const KIND_ICONS: Record<DocumentKind, IconName> = {
  pdf: "file-text",
  spreadsheet: "table",
  wordprocessing: "file-text",
  image: "image",
  text: "code",
  unknown: "file",
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
        <span className="document-card__icon">
          <Icon name={KIND_ICONS[document.kind]} size={16} />
        </span>

        <span className="document-card__meta">
          <span className="document-card__name" title={document.filename}>
            {document.filename}
          </span>
          <span className="document-card__sub">
            <span>{KIND_LABELS[document.kind]}</span>
            <span aria-hidden="true">·</span>
            <span className="mono">{formatBytes(document.byteSize)}</span>
          </span>
        </span>

        <span className="document-card__actions">
          {canPreview && (
            <IconButton
              icon={isExpanded ? "chevron-up" : "eye"}
              label={isExpanded ? "Hide preview" : "Preview"}
              onClick={() => setIsExpanded((expanded) => !expanded)}
              tooltipSide="top"
            />
          )}
          <IconButton
            icon={saveState === "saved" ? "check" : "download"}
            label={
              saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : "Save a copy"
            }
            onClick={save}
            disabled={saveState === "saving"}
            tooltipSide="top"
            tooltipAlign="end"
          />
        </span>
      </div>

      {canPreview && isExpanded && Viewer && (
        <div className="document-card__viewer selectable">
          <Viewer document={document} />
        </div>
      )}

      {saveError && (
        <p className="document-card__note document-card__note--error" role="alert">
          <Icon name="alert-circle" size={12} />
          {saveError}
        </p>
      )}

      {!canPreview && (
        <p className="document-card__note">
          <Icon name="alert-circle" size={12} />
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
