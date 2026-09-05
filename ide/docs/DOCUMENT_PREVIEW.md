# Document preview

Previews render inline in the chat thread, collapsed by default. Constraints
that drove every choice: fully offline (no CDN, no font or worker fetch at
runtime), permissive licence (MIT / Apache-2.0 / BSD), and a clean `npm audit`
— this ships into a government security review.

## What is implemented

| Format | Library | Licence | Parsed in | Notes |
| --- | --- | --- | --- | --- |
| PDF | `pdfjs-dist` 6.3.289 | Apache-2.0 | Renderer | Canvas render, first 50 pages |
| XLSX | `exceljs` 4.4.0 | MIT | **Main** | Multi-sheet tabs, first 2 000 rows |
| CSV / TSV | `papaparse` 5.7.0 | MIT | **Main** | Same viewer as XLSX |
| DOCX | `docx-preview` 0.4.0 | Apache-2.0 | Renderer | Pages, headers, footnotes |
| Images | none | — | Renderer | Chromium decodes natively |
| Text / code | none | — | Renderer | First 200 000 characters |

Everything renders from an `ArrayBuffer` the main process supplies. Parsing
lives in the renderer by default, so a malformed document crashes a renderer
frame rather than the privileged process. Spreadsheets are the exception:
`exceljs` depends on Node streams and the filesystem, and dragging that into a
sandboxed renderer would mean polyfilling `Buffer` and `process`. CSV is parsed
in main too, so the viewer has exactly one code path for both.

Capabilities are reported by `preview:capabilities` rather than assumed, so an
unsupported family shows a reason instead of a blank frame.

## Getting bytes safely

The renderer asks for documents **by id, never by path**. `DocumentLibrary`
issues an id only for a file the user picked through the native dialog, so a
compromised renderer cannot read arbitrary files — only re-read something the
user already chose to open. Ids are per-session and not persisted. Reads are
capped at 25 MB.

## Still open

- **TIFF.** Chromium cannot decode it, and scanned records are frequently
  CCITT G4 TIFFs. `utif2` (MIT) is the only viable decoder — `tiff` from
  image-js is maintained but supports only LZW/Deflate greyscale and RGB, so
  it cannot read fax-encoded scans. The image viewer says so explicitly rather
  than showing a broken image.
- **Legacy `.xls`.** exceljs reads only XLSX, not the old BIFF format.
- **Artifact sources.** `DocumentRef` supports an `artifact` source for files
  held in the backend's object storage, but there is no route to fetch those
  yet, so those cards report that plainly.
- **Text extraction for search.** `mammoth` (BSD-2-Clause) produces semantic
  HTML that suits indexing better than `docx-preview`'s visual output. Worth
  adding alongside, not instead.

## Do not use

- **`xlsx` / SheetJS.** The npm package is frozen at 0.18.5 (2022) — SheetJS
  publishes only to its own CDN now. That frozen version carries two unfixed
  advisories, GHSA-4r6h-8v6p-xvw6 (prototype pollution) and
  GHSA-5pgg-2g8v-p4x9 (ReDoS), whose fixes exist only off-npm. `npm audit`
  would never come back clean. This is the most important finding here.
- **`handsontable`** — commercial licence required.
- **`@embedpdf/*`** — promising PDFium/WASM viewer, but currently prerelease
  and its server component needs a licence key even self-hosted.

`exceljs` itself pins a `uuid` carrying GHSA-w5hq-g745-h8pq. The `overrides`
block in `package.json` forces `uuid@11.1.1`, matching what the backend
already does. Audit is clean with that in place.

## Build-time details worth knowing

1. **pdf.js needs four asset directories**, all copied into the renderer
   output by a small plugin in `electron.vite.config.ts`: `cmaps/` (169 files,
   CJK), `standard_fonts/` (16), `wasm/` (JPEG 2000, JBIG2, colour), `iccs/`
   (CMYK). Missing `wasm/` throws on any PDF with JPEG 2000 imagery; missing
   `cmaps/` renders CJK as blank glyphs.
2. **`quickjs-eval.*` is deliberately excluded.** It is the engine pdf.js uses
   to run JavaScript embedded in AcroForms. Scripting is opt-in at the viewer
   layer and we only call `page.render`, so it is never requested — excluding
   it makes that structural rather than a setting someone can flip later.
   (Note `isEvalSupported` no longer exists in pdf.js v6.)
3. **Asset URLs are resolved from `window.location.href`,** not written as
   `/cmaps/`. In a packaged build the renderer runs from `file://`, where a
   root-absolute path points at the filesystem root.
4. **`assetsInlineLimit: 0`** — otherwise small `.wasm` files get inlined as
   base64 data URIs, breaking the runtime fetch.
5. **A copy plugin was hand-rolled** rather than using `vite-plugin-static-copy`,
   which resolves paths relative to the Vite root. `node_modules` sits outside
   the renderer root, and it silently produced a nested
   `node_modules/pdfjs-dist/cmaps/` tree instead of the flat layout the runtime
   URLs expect.
6. **The CSP needed widening** for `'wasm-unsafe-eval'` and `worker-src blob:`.
   Each allowance is annotated in `src/renderer/index.html`. No remote origin
   appears anywhere in it.

## Tests

`npm test` covers the main-process parsing: formula cells show their computed
result, dates format as ISO, quoted commas survive CSV parsing, row caps report
the true total, and the document library refuses ids it never issued.

`npm run test:e2e` drives the **real built renderer** in Electron, attaches
generated fixtures, expands every preview, and asserts on the resulting DOM —
including reading canvas pixels to prove the PDF is not a blank page. That is
the only test that can catch a broken asset path, a missing worker, or a CSP
regression, because none of those exist outside a real renderer.
