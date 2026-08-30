# Hybrid document understanding

Document understanding uses complementary extraction and vision paths. Neither path is treated as universally authoritative.

## Deterministic extraction

- UTF-8 text, Markdown, and CSV are decoded locally.
- Docling extracts reusable text, layout, tables, and OCR from PDF, image, DOCX, PPTX, and XLSX inputs.
- Extracted content, checksums, status, timing, and errors are persisted for retrieval and auditing.
- Worker startup and unrelated tasks do not depend on Docling availability.

## Vision interpretation

- Vision-capable model profiles receive bounded PNG, JPEG, or WEBP originals alongside deterministic OCR/extraction text for visual analysis.
- TIFF remains a valid extraction source but vision inference fails explicitly until a trusted conversion path is implemented.
- Vision-routed PDFs are rendered to bounded PNGs by the internal PDF renderer. The default deterministic selection is every page when the document has at most three pages, otherwise the first, middle, and last pages. The adapter also supports explicit one-based page numbers for future task-level selection.
- Vision is used when task routing explicitly selects the vision capability and the source is a supported image or PDF.
- Vision output is model analysis, not source evidence. Citations must resolve back to the source page or image.
- Remote vision is restricted to public or synthetic data. Sovereign mode uses only local vision profiles.

## Routing policy

1. Validate the source signature and classification.
2. Reuse a completed canonical extraction when available.
3. Run deterministic extraction for searchable text, layout, and tables.
4. Select the original image or deterministic bounded PDF pages when visual semantics are required.
5. Send bounded in-memory images to eligible vision models, while keeping image data and provider-request base64 out of durable messages, tool outputs, logs, and invocation telemetry.
6. Combine deterministic extraction evidence and clearly-labelled model observations.
7. Persist non-payload visual-input descriptors and model invocation metadata.

This keeps OCR/layout processing replaceable while allowing stronger vision models to improve interpretation without coupling the backend to one parser or model vendor.

## PDF renderer limits

PDF rendering is isolated from the worker in an authenticated, internal-only Node 22 Alpine sidecar. It uses Mozilla PDF.js and its supported `@napi-rs/canvas` backend; the latter publishes prebuilt x64 and arm64 musl binaries and requires no Alpine build toolchain. Each request runs in a terminable worker thread and the container has no egress network, capabilities, or writable root filesystem.

The backend and sidecar both validate the `%PDF-` signature and source-byte limit. The sidecar enforces document and selected-page counts, DPI, pixels per page, combined PNG bytes, and its own timeout; the backend validates the bounded response and applies an end-to-end timeout. The provider layer independently rechecks image count and combined bytes. Cancellation closes the sidecar request and terminates its render worker. Rendered PNGs use a binary internal response and exist only in memory.

Limitations:

- Representative sampling can omit relevant interior pages; explicit page selection exists at the adapter boundary but task-driven selection is not yet exposed by the run API.
- Encrypted PDFs, malformed PDFs, and PDFs over the configured document-page limit fail closed.
- PDF.js is compatible with Node 22 but documents partial Node support. Complex PDF features may render differently from native viewers.
- The pixel cap may reduce the effective DPI for unusually large page dimensions.
