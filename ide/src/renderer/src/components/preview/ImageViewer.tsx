import { useEffect, useState } from "react";

import { useDocumentBytes } from "../../hooks/useDocumentBytes.js";
import { PreviewError, PreviewLoading } from "./PreviewState.js";
import type { DocumentViewerProps } from "./registry.js";

/**
 * Chromium cannot decode TIFF. Scanned records are frequently CCITT G4 TIFFs,
 * so this is called out explicitly rather than left as a broken image icon —
 * see `docs/DOCUMENT_PREVIEW.md` for the decoder that would fix it.
 */
const UNDECODABLE = new Set(["image/tiff"]);

export function ImageViewer({ document }: DocumentViewerProps): React.JSX.Element {
  const { data: bytes, isLoading, error } = useDocumentBytes(document);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!bytes || UNDECODABLE.has(document.mimeType)) return;

    const url = URL.createObjectURL(new Blob([bytes], { type: document.mimeType }));
    setObjectUrl(url);
    // Object URLs pin their blob in memory until explicitly revoked.
    return () => {
      URL.revokeObjectURL(url);
      setObjectUrl(null);
    };
  }, [bytes, document.mimeType]);

  if (UNDECODABLE.has(document.mimeType)) {
    return <PreviewError message="TIFF images need a decoder that is not bundled yet." />;
  }
  if (isLoading) return <PreviewLoading label="Loading image…" />;
  if (error) return <PreviewError message={error} />;
  if (!objectUrl) return <PreviewLoading label="Loading image…" />;

  return <img className="image-preview" src={objectUrl} alt={document.filename} />;
}
