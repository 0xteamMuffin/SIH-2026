export type KnowledgeElementType = "heading" | "paragraph" | "list" | "table" | "picture" | "code" | "quote" | "other";

export type ProvenanceValue =
  | string
  | number
  | boolean
  | null
  | readonly ProvenanceValue[]
  | { readonly [key: string]: ProvenanceValue };

export interface SourceTextBlock {
  id?: string;
  /** Zero-based, half-open offsets into the canonical text. */
  startChar: number;
  endChar: number;
  elementType?: KnowledgeElementType;
  provenance?: Readonly<Record<string, ProvenanceValue>>;
}

export interface ChunkTextInput {
  /** Canonical extracted text. Offsets are measured in JavaScript UTF-16 code units. */
  text: string;
  /** Stable source identity, such as an artifact ID. */
  sourceId?: string;
  sourceBlocks?: readonly SourceTextBlock[];
  provenance?: Readonly<Record<string, ProvenanceValue>>;
}

export interface TextChunkerOptions {
  targetChars?: number;
  maxChars?: number;
  overlapChars?: number;
  maxChunks?: number;
}

export interface CharacterRange {
  /** Zero-based, inclusive. */
  start: number;
  /** Zero-based, exclusive. */
  end: number;
}

export interface LineRange {
  /** One-based, inclusive. */
  start: number;
  /** One-based, inclusive. */
  end: number;
}

export interface ChunkSourceBlock {
  id?: string;
  elementType?: KnowledgeElementType;
  /** The intersecting range in the canonical source text. */
  charRange: CharacterRange;
  /** The same intersection relative to the start of this chunk. */
  chunkCharRange: CharacterRange;
  provenance?: Readonly<Record<string, ProvenanceValue>>;
}

export interface CitationTextChunk {
  index: number;
  text: string;
  headingPath: readonly string[];
  charRange: CharacterRange;
  lineRange: LineRange;
  elementTypes: readonly KnowledgeElementType[];
  /** Lowercase SHA-256 hex digest of the exact chunk text. */
  contentHash: string;
  /** Deterministic UUIDv5 accepted by UUID-compatible point stores. */
  pointId: string;
  sourceBlocks: readonly ChunkSourceBlock[];
  provenance?: Readonly<Record<string, ProvenanceValue>>;
}
