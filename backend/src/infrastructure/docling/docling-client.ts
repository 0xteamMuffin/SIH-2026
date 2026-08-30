import { extname } from "node:path";
import { z } from "zod";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";
import { MAX_EXTRACTION_PROVENANCE_BLOCKS } from "../extraction/extraction-provenance.js";
import type { KnowledgeElementType, SourceTextBlock } from "../../modules/knowledge/text-chunker.types.js";

const referenceSchema = z.object({ $ref: z.string().min(1).max(512) }).passthrough();
const coordinateSchema = z.number().finite().min(-1_000_000_000).max(1_000_000_000);
const boundingBoxSchema = z.object({
  l: coordinateSchema,
  t: coordinateSchema,
  r: coordinateSchema,
  b: coordinateSchema,
  coord_origin: z.string().max(64).optional(),
}).passthrough();
const itemSchema = z.object({
  self_ref: z.string().min(1).max(512).optional(),
  label: z.string().max(128).optional(),
  text: z.string().max(2_000_000).optional(),
  orig: z.string().max(2_000_000).optional(),
  children: z.array(referenceSchema).max(MAX_EXTRACTION_PROVENANCE_BLOCKS).optional(),
  captions: z.array(referenceSchema).max(32).optional(),
  prov: z.array(z.object({
    page_no: z.number().int().min(1).max(1_000_000),
    bbox: boundingBoxSchema.optional(),
    charspan: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
  }).passthrough()).max(32).default([]),
  data: z.object({
    table_cells: z.array(z.object({ text: z.string().max(100_000).optional() }).passthrough()).max(100_000).optional(),
  }).passthrough().optional(),
}).passthrough();
const doclingDocumentSchema = z.object({
  body: itemSchema.optional(),
  furniture: itemSchema.optional(),
  texts: z.array(itemSchema).max(MAX_EXTRACTION_PROVENANCE_BLOCKS).default([]),
  tables: z.array(itemSchema).max(MAX_EXTRACTION_PROVENANCE_BLOCKS).default([]),
  pictures: z.array(itemSchema).max(MAX_EXTRACTION_PROVENANCE_BLOCKS).default([]),
  groups: z.array(itemSchema).max(MAX_EXTRACTION_PROVENANCE_BLOCKS).default([]),
}).passthrough();

const responseSchema = z.object({
  document: z.object({
    md_content: z.string().optional(),
    text_content: z.string().optional(),
    json_content: z.union([z.record(z.unknown()), z.string().max(25_000_000)]),
  }),
  status: z.enum(["success", "partial_success", "skipped", "failure"]),
  processing_time: z.number().nonnegative(),
  timings: z.record(z.unknown()).optional(),
  errors: z.array(z.unknown()).default([]),
});

const formatByExtension: Record<string, "pdf" | "image" | "docx" | "pptx" | "xlsx"> = {
  pdf: "pdf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  tif: "image",
  tiff: "image",
  webp: "image",
  docx: "docx",
  pptx: "pptx",
  xlsx: "xlsx",
};

export type DoclingExtraction = {
  markdown: string;
  text?: string;
  sourceBlocks: SourceTextBlock[];
  processingTimeSeconds: number;
  status: "success" | "partial_success";
  errorCount: number;
};

type DoclingDocument = z.infer<typeof doclingDocumentSchema>;
type DoclingItem = z.infer<typeof itemSchema>;
type ItemKind = "text" | "table" | "picture";

interface OrderedItem {
  item: DoclingItem;
  kind: ItemKind;
  index: number;
  ref: string;
}

interface MarkdownSpan {
  start: number;
  end: number;
}

function parseDoclingDocument(value: Record<string, unknown> | string): DoclingDocument {
  const decoded = typeof value === "string" ? JSON.parse(value) : value;
  return doclingDocumentSchema.parse(decoded);
}

function orderedItems(document: DoclingDocument): OrderedItem[] {
  const ordered: OrderedItem[] = [];
  const seen = new Set<string>();
  const groups = new Set<string>();
  const resolve = (reference: string): OrderedItem | undefined => {
    const match = /^#\/(texts|tables|pictures)\/(\d+)$/.exec(reference);
    if (!match) return undefined;
    const index = Number(match[2]);
    const collection = document[match[1] as "texts" | "tables" | "pictures"];
    const item = collection[index];
    if (!item) return undefined;
    return { item, kind: match[1] === "texts" ? "text" : match[1] === "tables" ? "table" : "picture", index, ref: reference };
  };
  const visit = (reference: string) => {
    const groupMatch = /^#\/groups\/(\d+)$/.exec(reference);
    if (groupMatch) {
      if (groups.has(reference)) return;
      groups.add(reference);
      for (const child of document.groups[Number(groupMatch[1])]?.children ?? []) visit(child.$ref);
      return;
    }
    const resolved = resolve(reference);
    if (!resolved || seen.has(reference)) return;
    seen.add(reference);
    ordered.push(resolved);
  };
  for (const child of [...(document.body?.children ?? []), ...(document.furniture?.children ?? [])]) visit(child.$ref);
  if (ordered.length === 0) {
    for (const [kind, collection] of [["text", document.texts], ["table", document.tables], ["picture", document.pictures]] as const) {
      for (const [index, item] of collection.entries()) ordered.push({ item, kind, index, ref: item.self_ref ?? `#/${kind}s/${index}` });
    }
  }
  if (ordered.length > MAX_EXTRACTION_PROVENANCE_BLOCKS) throw new Error("Docling document contains too many provenance blocks");
  return ordered;
}

function markdownLines(markdown: string): Array<MarkdownSpan & { text: string }> {
  const lines: Array<MarkdownSpan & { text: string }> = [];
  const expression = /.*(?:\r\n|\r|\n|$)/g;
  for (const match of markdown.matchAll(expression)) {
    if (!match[0]) continue;
    const end = match.index + match[0].replace(/[\r\n]+$/, "").length;
    lines.push({ start: match.index, end, text: markdown.slice(match.index, end) });
  }
  return lines;
}

function markdownTableSpans(markdown: string): MarkdownSpan[] {
  const lines = markdownLines(markdown);
  const spans: MarkdownSpan[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].text.includes("|")) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < lines.length && lines[index].text.includes("|")) index += 1;
    const run = lines.slice(start, index);
    if (run.some((line) => /^\s*\|?\s*:?-{3,}/.test(line.text))) spans.push({ start: run[0].start, end: run[run.length - 1].end });
  }
  return spans;
}

function markdownPictureSpans(markdown: string): MarkdownSpan[] {
  return [...markdown.matchAll(/!\[[^\]]*\]\([^\r\n)]*\)|<!--\s*image\s*-->/gi)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
}

function headingSpan(markdown: string, title: string, after: number): (MarkdownSpan & { level: number }) | undefined {
  for (const line of markdownLines(markdown)) {
    if (line.end < after) continue;
    const match = /^\s{0,3}(#{1,6})[ \t]+(.+?)\s*#*\s*$/.exec(line.text);
    if (match?.[2].trim() === title) return { start: line.start, end: line.end, level: match[1].length };
  }
  return undefined;
}

function itemElementType(kind: ItemKind, label?: string): KnowledgeElementType {
  if (kind === "table") return "table";
  if (kind === "picture") return "picture";
  if (label === "title" || label === "section_header") return "heading";
  if (label === "list_item" || label === "checkbox_selected" || label === "checkbox_unselected") return "list";
  if (label === "code") return "code";
  return "paragraph";
}

function normalizeSourceBlocks(markdown: string, document: DoclingDocument): SourceTextBlock[] {
  const tables = markdownTableSpans(markdown);
  const pictures = markdownPictureSpans(markdown);
  let tableOffset = 0;
  let pictureOffset = 0;
  let cursor = 0;
  const blocks: SourceTextBlock[] = [];
  for (const ordered of orderedItems(document)) {
    const content = (ordered.item.text ?? ordered.item.orig)?.trim();
    const type = itemElementType(ordered.kind, ordered.item.label);
    let span: MarkdownSpan | undefined;
    let heading: { level: number; title: string } | undefined;
    if (type === "heading" && content) {
      const found = headingSpan(markdown, content, cursor);
      if (found) {
        span = found;
        heading = { level: found.level, title: content };
      }
    } else if (ordered.kind === "table") {
      span = tables.find((candidate, index) => index >= tableOffset && candidate.start >= cursor);
      if (span) tableOffset = tables.indexOf(span) + 1;
    } else if (ordered.kind === "picture") {
      span = pictures.find((candidate, index) => index >= pictureOffset && candidate.start >= cursor);
      if (span) pictureOffset = pictures.indexOf(span) + 1;
    }
    if (!span && content) {
      const start = markdown.indexOf(content, cursor);
      if (start >= 0) span = { start, end: start + content.length };
    }
    if (!span || span.end <= span.start) continue;
    cursor = Math.max(cursor, span.end);
    const boundingBoxes = ordered.item.prov.flatMap((entry) => entry.bbox ? [{
      pageNumber: entry.page_no,
      left: entry.bbox.l,
      top: entry.bbox.t,
      right: entry.bbox.r,
      bottom: entry.bbox.b,
      ...(entry.bbox.coord_origin ? { coordinateOrigin: entry.bbox.coord_origin } : {}),
    }] : []);
    const pageNumbers = [...new Set(ordered.item.prov.map((entry) => entry.page_no))];
    const firstBox = boundingBoxes[0];
    blocks.push({
      id: ordered.item.self_ref ?? ordered.ref,
      startChar: span.start,
      endChar: span.end,
      elementType: type,
      provenance: {
        source: "docling",
        doclingRef: ordered.item.self_ref ?? ordered.ref,
        ...(pageNumbers[0] === undefined ? {} : { page: pageNumbers[0] }),
        ...(firstBox ? { bbox: [firstBox.left, firstBox.top, firstBox.right, firstBox.bottom] } : {}),
        pageNumbers,
        boundingBoxes,
        ...(ordered.kind === "table" ? { tableIndex: ordered.index } : {}),
        ...(ordered.kind === "picture" ? { pictureIndex: ordered.index } : {}),
        ...(heading ? { heading } : {}),
      },
    });
  }
  return blocks;
}

export async function extractWithDocling(input: { filename: string; mimeType: string; bytes: Buffer }, signal?: AbortSignal): Promise<DoclingExtraction> {
  const extension = extname(input.filename).slice(1).toLowerCase();
  const format = formatByExtension[extension];
  if (!format) throw new AppError(415, "Docling does not support this artifact format", "EXTRACTION_FORMAT_UNSUPPORTED");

  const form = new FormData();
  const uploadBytes = Uint8Array.from(input.bytes);
  form.append("files", new Blob([uploadBytes], { type: input.mimeType }), input.filename);
  form.append("from_formats", format);
  form.append("to_formats", "md");
  form.append("to_formats", "text");
  form.append("to_formats", "json");
  form.append("do_ocr", String(format === "pdf" || format === "image"));
  form.append("force_ocr", "false");
  form.append("abort_on_error", "true");
  form.append("include_images", "false");
  form.append("image_export_mode", "placeholder");
  form.append("document_timeout", "300");

  const timeoutSignal = AbortSignal.timeout(env.DOCLING_REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetch(`${env.DOCLING_BASE_URL}/v1/convert/file`, {
      method: "POST",
      headers: { accept: "application/json", "x-api-key": env.DOCLING_API_KEY },
      body: form,
      signal: requestSignal,
    });
  } catch (error) {
    if (signal?.aborted) throw new AppError(503, "Document extraction was cancelled", "EXTRACTION_CANCELLED");
    if (requestSignal.aborted || (error instanceof Error && error.name === "TimeoutError")) throw new AppError(504, "Document extraction timed out", "EXTRACTION_TIMEOUT");
    throw new AppError(502, "Document extraction service is unavailable", "EXTRACTION_UNAVAILABLE");
  }
  if (!response.ok) throw new AppError(502, `Document extraction service failed with status ${response.status}`, "EXTRACTION_SERVICE_ERROR");

  let data: z.infer<typeof responseSchema>;
  try {
    data = responseSchema.parse(await response.json());
  } catch {
    throw new AppError(502, "Document extraction service returned an invalid response", "EXTRACTION_RESPONSE_INVALID");
  }
  if (data.status !== "success" && data.status !== "partial_success") throw new AppError(422, "Document extraction failed", "EXTRACTION_FAILED");
  const markdown = data.document.md_content?.trim();
  const text = data.document.text_content?.trim();
  if (!markdown && !text) throw new AppError(422, "Document extraction returned no content", "EXTRACTION_EMPTY");
  try {
    const canonicalMarkdown = markdown ?? text!;
    const document = parseDoclingDocument(data.document.json_content);
    return { markdown: canonicalMarkdown, text, sourceBlocks: normalizeSourceBlocks(canonicalMarkdown, document), processingTimeSeconds: data.processing_time, status: data.status, errorCount: data.errors.length };
  } catch {
    throw new AppError(502, "Document extraction service returned invalid structured content", "EXTRACTION_RESPONSE_INVALID");
  }
}
