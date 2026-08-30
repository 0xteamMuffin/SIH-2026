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
- PDF vision currently uses extraction text only. Page rendering is not implemented, and run result metadata records `mode: extraction-text-only`, an empty `renderedPages` list, and the limitation rather than claiming visual page analysis.
- Vision is used when task routing explicitly selects the vision capability and the source is a supported original image.
- Vision output is model analysis, not source evidence. Citations must resolve back to the source page or image.
- Remote vision is restricted to public or synthetic data. Sovereign mode uses only local vision profiles.

## Routing policy

1. Validate the source signature and classification.
2. Reuse a completed canonical extraction when available.
3. Run deterministic extraction for searchable text, layout, and tables.
4. Select the original image when visual semantics are required; rendered PDF page selection remains future work.
5. Send only a bounded original image to eligible vision models, while keeping image data out of durable messages, tool outputs, logs, and invocation telemetry.
6. Combine deterministic extraction evidence and clearly-labelled model observations.
7. Persist non-payload visual-input descriptors and model invocation metadata.

This keeps OCR/layout processing replaceable while allowing stronger vision models to improve interpretation without coupling the backend to one parser or model vendor.
