import { useEffect, useRef, useState } from "react";
import { renderAsync } from "docx-preview";

import { useDocumentBytes } from "../../hooks/useDocumentBytes.js";
import { PreviewError, PreviewLoading } from "./PreviewState.js";
import type { DocumentViewerProps } from "./registry.js";

/**
 * Renders a Word document.
 *
 * `docx-preview` writes directly into a container element rather than
 * returning HTML, so there is no seam at which to run a sanitizer. Two
 * mitigations: `renderAltChunks: false` refuses embedded HTML fragments, and
 * the container is write-only — nothing reads back out of it. The renderer's
 * CSP is the backstop, since inline scripts cannot execute regardless.
 */
export function DocxViewer({ document }: DocumentViewerProps): React.JSX.Element {
  const { data: bytes, isLoading, error } = useDocumentBytes(document);
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!bytes || !container) return;

    let cancelled = false;
    container.replaceChildren();

    renderAsync(bytes, container, undefined, {
      className: "docx",
      inWrapper: true,
      ignoreWidth: true,
      ignoreHeight: true,
      breakPages: true,
      // Do not render externally referenced HTML fragments.
      renderAltChunks: false,
      // Uses object URLs for images instead of inlining base64; the CSP
      // allows `blob:` in `img-src` for exactly this.
      useBase64URL: false,
    }).catch((cause: unknown) => {
      if (!cancelled) setRenderError(cause instanceof Error ? cause.message : String(cause));
    });

    return () => {
      cancelled = true;
    };
  }, [bytes]);

  if (isLoading) return <PreviewLoading label="Reading document…" />;
  if (error) return <PreviewError message={error} />;
  if (renderError) {
    return <PreviewError message={`Could not render this document — ${renderError}`} />;
  }

  return <div ref={containerRef} className="docx-host" />;
}
