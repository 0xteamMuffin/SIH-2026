# Hybrid document understanding

Document understanding uses complementary extraction and vision paths. Neither path is treated as universally authoritative.

## Deterministic extraction

- UTF-8 text, Markdown, and CSV are decoded locally.
- Docling extracts reusable text, layout, tables, and OCR from PDF, image, DOCX, PPTX, and XLSX inputs.
- Extracted content, checksums, status, timing, and errors are persisted for retrieval and auditing.
- Worker startup and unrelated tasks do not depend on Docling availability.

## Vision interpretation

- Vision-capable model profiles analyze photographs, handwriting, diagrams, engineering drawings, and selected scanned pages.
- Vision is used when the task explicitly requires visual interpretation or deterministic extraction is empty, partial, or low-confidence.
- Vision output is model analysis, not source evidence. Citations must resolve back to the source page or image.
- Remote vision is restricted to public or synthetic data. Sovereign mode uses only local vision profiles.

## Routing policy

1. Validate the source signature and classification.
2. Reuse a completed canonical extraction when available.
3. Run deterministic extraction for searchable text, layout, and tables.
4. Select visual pages or the original image when visual semantics are required.
5. Send only those bounded visual inputs to an eligible vision model.
6. Combine deterministic facts and clearly-labelled model observations.
7. Persist source locations, confidence, model invocation metadata, and uncertainties.

This keeps OCR/layout processing replaceable while allowing stronger vision models to improve interpretation without coupling the backend to one parser or model vendor.
