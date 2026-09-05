import { useEffect, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument, type PDFDocumentLoadingTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { MAX_PDF_PAGES } from "@shared/types.js";

import { useDocumentBytes } from "../../hooks/useDocumentBytes.js";
import { PreviewError, PreviewLoading, PreviewNote } from "./PreviewState.js";
import type { DocumentViewerProps } from "./registry.js";

// Set in the same module that calls `getDocument`. Doing it anywhere else
// risks module evaluation order letting the default clobber it.
GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Where pdf.js fetches its runtime assets from.
 *
 * Resolved against the document URL rather than written as `/cmaps/`: in a
 * packaged build the renderer runs from `file://`, where a root-absolute path
 * points at the filesystem root and CJK text would silently render blank.
 */
function assetBase(): string {
  return new URL(".", window.location.href).href;
}

/** Render scale. Fixed rather than fit-to-width to keep text crisp. */
const RENDER_SCALE = 1.4;

export function PdfViewer({ document }: DocumentViewerProps): React.JSX.Element {
  const { data: bytes, isLoading, error } = useDocumentBytes(document);
  const containerRef = useRef<HTMLDivElement>(null);
  const [pageCount, setPageCount] = useState(0);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    if (!bytes) return;

    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;

    void (async () => {
      try {
        const base = assetBase();
        loadingTask = getDocument({
          // pdf.js takes ownership of the buffer it is given, and the same
          // ArrayBuffer would be detached on a re-run, so hand it a copy.
          data: bytes.slice(0),
          cMapUrl: `${base}cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${base}standard_fonts/`,
          wasmUrl: `${base}wasm/`,
          iccUrl: `${base}iccs/`,
        });
        const pdf = await loadingTask.promise;

        if (cancelled) return;
        setPageCount(pdf.numPages);

        const container = containerRef.current;
        if (!container) return;
        container.replaceChildren();

        const renderLimit = Math.min(pdf.numPages, MAX_PDF_PAGES);
        for (let pageNumber = 1; pageNumber <= renderLimit; pageNumber += 1) {
          const page = await pdf.getPage(pageNumber);
          if (cancelled) return;

          const viewport = page.getViewport({ scale: RENDER_SCALE });
          const canvas = window.document.createElement("canvas");
          canvas.className = "pdf__page";
          // Bitmap size is device pixels; CSS size keeps layout in CSS pixels.
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = "100%";
          canvas.style.height = "auto";
          canvas.setAttribute("aria-label", `Page ${pageNumber}`);
          container.append(canvas);

          await page.render({ canvas, viewport }).promise;
          page.cleanup();
          if (cancelled) return;
        }
      } catch (cause) {
        if (!cancelled) {
          setRenderError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();

    return () => {
      cancelled = true;
      // Tears down the worker's copy of the document; without this each
      // reopen leaks a parsed PDF.
      void loadingTask?.destroy();
    };
  }, [bytes]);

  if (isLoading) return <PreviewLoading label="Loading PDF…" />;
  if (error) return <PreviewError message={error} />;
  if (renderError) return <PreviewError message={`Could not render this PDF — ${renderError}`} />;

  return (
    <div className="pdf">
      {pageCount > MAX_PDF_PAGES && (
        <PreviewNote>
          Showing the first {MAX_PDF_PAGES} of {pageCount} pages.
        </PreviewNote>
      )}
      <div ref={containerRef} className="pdf__pages" />
    </div>
  );
}
