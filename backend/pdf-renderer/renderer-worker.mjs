import { parentPort, workerData } from "node:worker_threads";
import { getDocument, version as rendererVersion } from "pdfjs-dist/legacy/build/pdf.mjs";

export function selectPages(pageCount, maximum, requestedPages) {
  if (requestedPages?.length) {
    const selected = [...new Set(requestedPages)].sort((a, b) => a - b);
    if (selected.length > maximum || selected.some((page) => !Number.isInteger(page) || page < 1 || page > pageCount)) {
      throw Object.assign(new Error("Requested PDF pages are outside the allowed range"), { code: "PDF_PAGE_SELECTION_INVALID" });
    }
    return { pages: selected, policy: "explicit" };
  }
  if (pageCount <= maximum) return { pages: Array.from({ length: pageCount }, (_, index) => index + 1), policy: "all-within-limit" };
  if (maximum === 1) return { pages: [1], policy: "representative" };
  const pages = Array.from({ length: maximum }, (_, index) => 1 + Math.round(index * (pageCount - 1) / (maximum - 1)));
  return { pages: [...new Set(pages)], policy: "representative" };
}

export async function renderPdf(data, options) {
  const loadingTask = getDocument({
    data: new Uint8Array(data),
    isEvalSupported: false,
    useSystemFonts: false,
    stopEvent: true,
  });
  let document;
  try {
    document = await loadingTask.promise;
    if (document.numPages < 1 || document.numPages > options.maxDocumentPages) {
      throw Object.assign(new Error("PDF page count is outside the allowed range"), { code: "PDF_PAGE_COUNT_INVALID" });
    }
    const selection = selectPages(document.numPages, options.maxPages, options.requestedPages);
    const images = [];
    const pages = [];
    let totalBytes = 0;
    for (const pageNumber of selection.pages) {
      const page = await document.getPage(pageNumber);
      const requestedScale = options.dpi / 72;
      const requestedViewport = page.getViewport({ scale: requestedScale });
      const pixelScale = Math.min(1, Math.sqrt(options.maxPixels / (requestedViewport.width * requestedViewport.height)));
      const viewport = page.getViewport({ scale: requestedScale * pixelScale });
      const width = Math.max(1, Math.floor(viewport.width));
      const height = Math.max(1, Math.floor(viewport.height));
      if (width * height > options.maxPixels) throw Object.assign(new Error("Rendered PDF page exceeds the pixel limit"), { code: "PDF_RENDER_PIXELS_EXCEEDED" });
      const canvasAndContext = document.canvasFactory.create(width, height);
      try {
        await page.render({ canvasContext: canvasAndContext.context, viewport, background: "#ffffff" }).promise;
        const encoded = await canvasAndContext.canvas.encode("png");
        totalBytes += encoded.byteLength;
        if (totalBytes > options.maxTotalBytes) throw Object.assign(new Error("Rendered PDF pages exceed the byte limit"), { code: "PDF_RENDER_BYTES_EXCEEDED" });
        images.push(Uint8Array.from(encoded));
        pages.push({ pageNumber, width, height, sizeBytes: encoded.byteLength });
      } finally {
        document.canvasFactory.destroy(canvasAndContext);
        page.cleanup();
      }
    }
    return {
      metadata: {
        renderer: "pdfjs-dist",
        rendererVersion,
        sourcePageCount: document.numPages,
        selectionPolicy: selection.policy,
        dpi: options.dpi,
        totalBytes,
        pages,
      },
      images,
    };
  } finally {
    await loadingTask.destroy();
  }
}

if (parentPort && workerData) {
  renderPdf(workerData.data, workerData.options).then(
    (result) => parentPort.postMessage(result, result.images.map((image) => image.buffer)),
    (error) => parentPort.postMessage({ error: { code: error?.code ?? "PDF_RENDER_FAILED", message: "PDF rendering failed" } }),
  );
}
