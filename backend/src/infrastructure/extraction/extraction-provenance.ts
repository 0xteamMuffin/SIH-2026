import crypto from "node:crypto";
import { z } from "zod";
import type { KnowledgeElementType, SourceTextBlock } from "../../modules/knowledge/text-chunker.types.js";

export const EXTRACTION_PROVENANCE_SCHEMA_VERSION = 1;
export const MAX_EXTRACTION_PROVENANCE_BLOCKS = 20_000;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const elementTypeSchema = z.enum(["heading", "paragraph", "list", "table", "picture", "code", "quote", "other"]);
const pageNumberSchema = z.number().int().min(1).max(1_000_000);
const coordinateSchema = z.number().finite().min(-1_000_000_000).max(1_000_000_000);
const boundingBoxSchema = z.object({
  pageNumber: pageNumberSchema,
  left: coordinateSchema,
  top: coordinateSchema,
  right: coordinateSchema,
  bottom: coordinateSchema,
  coordinateOrigin: z.string().max(64).optional(),
}).strict();
const localProvenanceSchema = z.object({
  source: z.literal("local-utf8"),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  charStart: z.number().int().nonnegative(),
  charEnd: z.number().int().positive(),
}).strict().refine((value) => value.lineEnd >= value.lineStart && value.charEnd > value.charStart, "Local provenance range is invalid");
const doclingProvenanceSchema = z.object({
  source: z.literal("docling"),
  doclingRef: z.string().min(1).max(512),
  page: pageNumberSchema.optional(),
  bbox: z.tuple([coordinateSchema, coordinateSchema, coordinateSchema, coordinateSchema]).optional(),
  pageNumbers: z.array(pageNumberSchema).max(32),
  boundingBoxes: z.array(boundingBoxSchema).max(32),
  tableIndex: z.number().int().nonnegative().optional(),
  pictureIndex: z.number().int().nonnegative().optional(),
  heading: z.object({ level: z.number().int().min(1).max(6), title: z.string().min(1).max(4_096) }).strict().optional(),
}).strict();
const blockSchema = z.object({
  id: z.string().min(1).max(512).optional(),
  startChar: z.number().int().nonnegative(),
  endChar: z.number().int().positive(),
  elementType: elementTypeSchema.optional(),
  provenance: z.union([localProvenanceSchema, doclingProvenanceSchema]),
}).strict().superRefine((block, context) => {
  if (block.endChar <= block.startChar) context.addIssue({ code: z.ZodIssueCode.custom, message: "Block character range is invalid" });
  if (block.provenance.source === "local-utf8" && (block.provenance.charStart !== block.startChar || block.provenance.charEnd !== block.endChar)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Local provenance character range does not match its block" });
  }
});
const sidecarSchema = z.object({
  schema: z.literal("extraction-provenance"),
  schemaVersion: z.literal(EXTRACTION_PROVENANCE_SCHEMA_VERSION),
  sourceSha256: sha256Schema,
  canonicalTextSha256: sha256Schema,
  blocks: z.array(blockSchema).max(MAX_EXTRACTION_PROVENANCE_BLOCKS),
}).strict();

export type ExtractionProvenanceSidecar = z.infer<typeof sidecarSchema>;

export function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function validateBlocks(text: string, blocks: readonly SourceTextBlock[]): void {
  if (blocks.length > MAX_EXTRACTION_PROVENANCE_BLOCKS) throw new RangeError(`Extraction provenance exceeds ${MAX_EXTRACTION_PROVENANCE_BLOCKS} blocks`);
  for (const [index, block] of blocks.entries()) {
    if (!Number.isInteger(block.startChar) || !Number.isInteger(block.endChar) || block.startChar < 0 || block.endChar <= block.startChar || block.endChar > text.length) {
      throw new RangeError(`Extraction provenance block ${index} has an invalid character range`);
    }
  }
}

export function createExtractionProvenanceSidecar(input: {
  sourceSha256: string;
  canonicalText: string;
  blocks: readonly SourceTextBlock[];
}): ExtractionProvenanceSidecar {
  validateBlocks(input.canonicalText, input.blocks);
  return sidecarSchema.parse({
    schema: "extraction-provenance",
    schemaVersion: EXTRACTION_PROVENANCE_SCHEMA_VERSION,
    sourceSha256: input.sourceSha256,
    canonicalTextSha256: sha256(input.canonicalText),
    blocks: input.blocks,
  });
}

export function parseExtractionProvenanceSidecar(bytes: Buffer, canonicalText: string): ExtractionProvenanceSidecar {
  const sidecar = sidecarSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  validateBlocks(canonicalText, sidecar.blocks);
  if (sidecar.canonicalTextSha256 !== sha256(canonicalText)) throw new Error("Extraction provenance canonical text checksum does not match");
  return sidecar;
}

interface LocalLine {
  start: number;
  end: number;
  number: number;
}

export function localTextProvenance(text: string, elementType?: KnowledgeElementType): SourceTextBlock[] {
  const lines: LocalLine[] = [];
  let start = 0;
  let number = 1;
  while (start < text.length) {
    let end = start;
    while (end < text.length && text[end] !== "\r" && text[end] !== "\n") end += 1;
    if (text[end] === "\r" && text[end + 1] === "\n") end += 2;
    else if (text[end] === "\r" || text[end] === "\n") end += 1;
    lines.push({ start, end, number });
    start = end;
    number += 1;
  }
  const groupSize = Math.max(1, Math.ceil(lines.length / MAX_EXTRACTION_PROVENANCE_BLOCKS));
  const blocks: SourceTextBlock[] = [];
  for (let index = 0; index < lines.length; index += groupSize) {
    const first = lines[index];
    const last = lines[Math.min(lines.length - 1, index + groupSize - 1)];
    blocks.push({
      id: `lines-${first.number}-${last.number}`,
      startChar: first.start,
      endChar: last.end,
      ...(elementType ? { elementType } : {}),
      provenance: { source: "local-utf8", lineStart: first.number, lineEnd: last.number, charStart: first.start, charEnd: last.end },
    });
  }
  return blocks;
}
