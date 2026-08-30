import { createHash } from "node:crypto";
import type {
  ChunkSourceBlock,
  ChunkTextInput,
  CitationTextChunk,
  KnowledgeElementType,
  SourceTextBlock,
  TextChunkerOptions,
} from "./text-chunker.types.js";

export const DEFAULT_TEXT_CHUNKER_OPTIONS = Object.freeze({
  targetChars: 1_800,
  maxChars: 2_400,
  overlapChars: 240,
  maxChunks: 10_000,
});

const HARD_MAX_CHARS = 2_400;
const HARD_MAX_OVERLAP_CHARS = 240;
const HARD_MAX_CHUNKS = 100_000;
const UUID_NAMESPACE = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");
const ELEMENT_TYPES = new Set<KnowledgeElementType>(["heading", "paragraph", "list", "table", "code", "quote", "other"]);

interface Line {
  start: number;
  contentEnd: number;
  end: number;
  text: string;
}

interface TextElement {
  start: number;
  end: number;
  type: KnowledgeElementType;
  headingPath: readonly string[];
}

interface IndexedSourceBlock extends SourceTextBlock {
  inputIndex: number;
}

function resolveOptions(options: TextChunkerOptions) {
  const resolved = { ...DEFAULT_TEXT_CHUNKER_OPTIONS, ...options };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
  }
  if (resolved.targetChars < 1 || resolved.targetChars > resolved.maxChars) throw new RangeError("targetChars must be between 1 and maxChars");
  if (resolved.maxChars < 1 || resolved.maxChars > HARD_MAX_CHARS) throw new RangeError(`maxChars must be between 1 and ${HARD_MAX_CHARS}`);
  if (resolved.overlapChars > HARD_MAX_OVERLAP_CHARS || resolved.overlapChars >= resolved.maxChars) {
    throw new RangeError(`overlapChars must be less than maxChars and no more than ${HARD_MAX_OVERLAP_CHARS}`);
  }
  if (resolved.maxChunks < 1 || resolved.maxChunks > HARD_MAX_CHUNKS) throw new RangeError(`maxChunks must be between 1 and ${HARD_MAX_CHUNKS}`);
  return resolved;
}

function validateAndSortSourceBlocks(text: string, sourceBlocks: readonly SourceTextBlock[]): IndexedSourceBlock[] {
  const blocks = sourceBlocks.map((block, inputIndex) => {
    if (!Number.isInteger(block.startChar) || !Number.isInteger(block.endChar) || block.startChar < 0 || block.endChar <= block.startChar || block.endChar > text.length) {
      throw new RangeError(`sourceBlocks[${inputIndex}] has an invalid character range`);
    }
    if (block.elementType && !ELEMENT_TYPES.has(block.elementType)) throw new TypeError(`sourceBlocks[${inputIndex}] has an invalid elementType`);
    return { ...block, inputIndex };
  });
  return blocks.sort((a, b) => a.startChar - b.startChar || a.endChar - b.endChar || (a.id ?? "").localeCompare(b.id ?? "") || a.inputIndex - b.inputIndex);
}

function readLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start < text.length) {
    let contentEnd = start;
    while (contentEnd < text.length && text[contentEnd] !== "\r" && text[contentEnd] !== "\n") contentEnd += 1;
    let end = contentEnd;
    if (text[end] === "\r" && text[end + 1] === "\n") end += 2;
    else if (text[end] === "\r" || text[end] === "\n") end += 1;
    lines.push({ start, contentEnd, end, text: text.slice(start, contentEnd) });
    start = end;
  }
  return lines;
}

function headingDetails(line: string): { level: number; title: string } | undefined {
  const match = /^\s{0,3}(#{1,6})[ \t]+(.+?)\s*$/.exec(line);
  if (!match) return undefined;
  const title = match[2].replace(/[ \t]+#+[ \t]*$/, "").trim();
  return title ? { level: match[1].length, title } : undefined;
}

function fenceMarker(line: string): string | undefined {
  return /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
}

function isClosingFence(line: string, marker: string): boolean {
  const trimmed = line.trim();
  let count = 0;
  while (trimmed[count] === marker[0]) count += 1;
  return count >= marker.length && trimmed.slice(count).trim() === "";
}

function inferElementType(lines: readonly Line[]): KnowledgeElementType {
  const first = lines[0].text;
  if (/^\s*(?:[-+*]|\d+[.)])[ \t]+/.test(first)) return "list";
  if (/^\s*>/.test(first)) return "quote";
  const nonBlank = lines.map((line) => line.text).filter((line) => line.trim());
  const hasTableDivider = nonBlank.some((line) => /^\s*\|?\s*:?-{3,}/.test(line) && line.includes("|"));
  if (hasTableDivider || (nonBlank.length > 1 && nonBlank.every((line) => line.includes("|")))) return "table";
  return "paragraph";
}

function parseElements(text: string): TextElement[] {
  const lines = readLines(text);
  const elements: TextElement[] = [];
  const headings = new Map<number, string>();
  let index = 0;

  const currentHeadingPath = () => [...headings.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]);

  while (index < lines.length) {
    if (!lines[index].text.trim()) {
      index += 1;
      continue;
    }

    const heading = headingDetails(lines[index].text);
    if (heading) {
      for (const level of headings.keys()) if (level >= heading.level) headings.delete(level);
      headings.set(heading.level, heading.title);
      elements.push({ start: lines[index].start, end: lines[index].contentEnd, type: "heading", headingPath: currentHeadingPath() });
      index += 1;
      continue;
    }

    const marker = fenceMarker(lines[index].text);
    if (marker) {
      const startLine = index;
      index += 1;
      while (index < lines.length) {
        const closesFence = isClosingFence(lines[index].text, marker);
        index += 1;
        if (closesFence) break;
      }
      elements.push({ start: lines[startLine].start, end: lines[index - 1].contentEnd, type: "code", headingPath: currentHeadingPath() });
      continue;
    }

    const startLine = index;
    index += 1;
    while (index < lines.length && lines[index].text.trim() && !headingDetails(lines[index].text) && !fenceMarker(lines[index].text)) index += 1;
    const blockLines = lines.slice(startLine, index);
    elements.push({
      start: blockLines[0].start,
      end: blockLines[blockLines.length - 1].contentEnd,
      type: inferElementType(blockLines),
      headingPath: currentHeadingPath(),
    });
  }
  return elements;
}

function preferredSplit(text: string, start: number, end: number, targetChars: number, maxChars: number): number {
  const limit = Math.min(start + maxChars, end);
  const desired = Math.min(start + targetChars, limit);
  let split = desired;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let candidate = start + 1; candidate <= limit; candidate += 1) {
    if (!/\s/.test(text[candidate - 1])) continue;
    const distance = Math.abs(candidate - desired);
    if (distance < bestDistance || (distance === bestDistance && candidate > split)) {
      split = candidate;
      bestDistance = distance;
    }
  }
  if (split < end && /[\uD800-\uDBFF]/.test(text[split - 1]) && /[\uDC00-\uDFFF]/.test(text[split])) split -= 1;
  return split > start ? split : limit;
}

function splitOversizedElements(text: string, elements: readonly TextElement[], targetChars: number, maxChars: number): TextElement[] {
  const split: TextElement[] = [];
  for (const element of elements) {
    let start = element.start;
    while (element.end - start > maxChars) {
      const end = preferredSplit(text, start, element.end, targetChars, maxChars);
      split.push({ ...element, start, end });
      start = end;
    }
    if (start < element.end) split.push({ ...element, start });
  }
  return split;
}

function sameHeadingPath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((heading, index) => heading === right[index]);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function uuidV5(name: string): string {
  const bytes = createHash("sha1").update(UUID_NAMESPACE).update(name, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\r" && text[index + 1] === "\n") {
      starts.push(index + 2);
      index += 1;
    } else if (text[index] === "\r" || text[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
}

function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.max(1, low);
}

function sourceBlocksForChunk(blocks: readonly IndexedSourceBlock[], start: number, end: number): ChunkSourceBlock[] {
  return blocks.flatMap((block) => {
    const intersectionStart = Math.max(start, block.startChar);
    const intersectionEnd = Math.min(end, block.endChar);
    if (intersectionStart >= intersectionEnd) return [];
    return [{
      ...(block.id === undefined ? {} : { id: block.id }),
      ...(block.elementType === undefined ? {} : { elementType: block.elementType }),
      charRange: { start: intersectionStart, end: intersectionEnd },
      chunkCharRange: { start: intersectionStart - start, end: intersectionEnd - start },
      ...(block.provenance === undefined ? {} : { provenance: block.provenance }),
    }];
  });
}

function elementTypesForChunk(elements: readonly TextElement[], blocks: readonly IndexedSourceBlock[], start: number, end: number): KnowledgeElementType[] {
  const ordered: Array<{ start: number; type: KnowledgeElementType }> = [];
  for (const element of elements) {
    if (element.start >= end || element.end <= start) continue;
    const annotated = blocks.filter((block) => block.elementType && block.startChar < element.end && block.endChar > element.start);
    if (annotated.length) {
      for (const block of annotated) ordered.push({ start: Math.max(element.start, block.startChar), type: block.elementType! });
    } else {
      ordered.push({ start: element.start, type: element.type });
    }
  }
  ordered.sort((a, b) => a.start - b.start || a.type.localeCompare(b.type));
  return [...new Set(ordered.map((entry) => entry.type))];
}

/**
 * Deterministically chunks canonical extracted text without I/O or mutable state.
 */
export function chunkCanonicalText(input: ChunkTextInput, options: TextChunkerOptions = {}): CitationTextChunk[] {
  if (typeof input?.text !== "string") throw new TypeError("text must be a string");
  const resolved = resolveOptions(options);
  const sourceBlocks = validateAndSortSourceBlocks(input.text, input.sourceBlocks ?? []);
  const parsedElements = parseElements(input.text);
  const elements = splitOversizedElements(input.text, parsedElements, resolved.targetChars, resolved.maxChars);
  if (!elements.length) return [];

  const starts = lineStarts(input.text);
  const documentHash = sha256(input.text);
  const sourceIdentity = input.sourceId ?? documentHash;
  const chunks: CitationTextChunk[] = [];
  let elementIndex = 0;

  while (elementIndex < elements.length) {
    if (chunks.length >= resolved.maxChunks) throw new RangeError(`Chunk count exceeds maxChunks (${resolved.maxChunks})`);
    const chunkStart = elements[elementIndex].start;
    const headingPath = elements[elementIndex].headingPath;
    let bestEnd = elementIndex + 1;
    let bestDistance = Math.abs(elements[elementIndex].end - chunkStart - resolved.targetChars);

    for (let candidateEnd = elementIndex + 2; candidateEnd <= elements.length; candidateEnd += 1) {
      const candidate = elements[candidateEnd - 1];
      if (!sameHeadingPath(headingPath, candidate.headingPath)) break;
      const length = candidate.end - chunkStart;
      if (length > resolved.maxChars) break;
      const distance = Math.abs(length - resolved.targetChars);
      if (distance <= bestDistance) {
        bestEnd = candidateEnd;
        bestDistance = distance;
      }
    }

    const chunkEnd = elements[bestEnd - 1].end;
    const text = input.text.slice(chunkStart, chunkEnd);
    const contentHash = sha256(text);
    chunks.push({
      index: chunks.length,
      text,
      headingPath: [...headingPath],
      charRange: { start: chunkStart, end: chunkEnd },
      lineRange: { start: lineAt(starts, chunkStart), end: lineAt(starts, chunkEnd - 1) },
      elementTypes: elementTypesForChunk(elements.slice(elementIndex, bestEnd), sourceBlocks, chunkStart, chunkEnd),
      contentHash,
      pointId: uuidV5(`knowledge-chunk\0${sourceIdentity}\0${chunkStart}\0${chunkEnd}\0${contentHash}`),
      sourceBlocks: sourceBlocksForChunk(sourceBlocks, chunkStart, chunkEnd),
      ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
    });

    let nextIndex = bestEnd;
    if (bestEnd < elements.length && sameHeadingPath(headingPath, elements[bestEnd].headingPath) && resolved.overlapChars > 0) {
      for (let candidate = bestEnd - 1; candidate > elementIndex; candidate -= 1) {
        if (chunkEnd - elements[candidate].start > resolved.overlapChars) break;
        if (elements[bestEnd].end - elements[candidate].start <= resolved.maxChars) nextIndex = candidate;
      }
    }
    elementIndex = nextIndex;
  }

  return chunks;
}

export type {
  CharacterRange,
  ChunkSourceBlock,
  ChunkTextInput,
  CitationTextChunk,
  KnowledgeElementType,
  LineRange,
  ProvenanceValue,
  SourceTextBlock,
  TextChunkerOptions,
} from "./text-chunker.types.js";
