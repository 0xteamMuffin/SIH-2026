import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";

import { dialog, type BaseWindow } from "electron";

import { MAX_PREVIEW_BYTES, type DocumentKind, type DocumentRef } from "@shared/types.js";

/**
 * Extension → (MIME, family). Extension-driven rather than sniffed, because
 * the family only selects a viewer; a mislabelled file fails in the viewer
 * rather than becoming a security decision.
 */
const FILE_TYPES: Record<string, { mimeType: string; kind: DocumentKind }> = {
  ".pdf": { mimeType: "application/pdf", kind: "pdf" },

  ".xlsx": {
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    kind: "spreadsheet",
  },
  ".csv": { mimeType: "text/csv", kind: "spreadsheet" },
  ".tsv": { mimeType: "text/tab-separated-values", kind: "spreadsheet" },

  ".docx": {
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    kind: "wordprocessing",
  },

  ".png": { mimeType: "image/png", kind: "image" },
  ".jpg": { mimeType: "image/jpeg", kind: "image" },
  ".jpeg": { mimeType: "image/jpeg", kind: "image" },
  ".gif": { mimeType: "image/gif", kind: "image" },
  ".webp": { mimeType: "image/webp", kind: "image" },
  ".avif": { mimeType: "image/avif", kind: "image" },
  ".bmp": { mimeType: "image/bmp", kind: "image" },
  ".svg": { mimeType: "image/svg+xml", kind: "image" },
  // Kept in the image family so the viewer can explain the gap; Chromium
  // cannot decode TIFF and no decoder is bundled yet.
  ".tif": { mimeType: "image/tiff", kind: "image" },
  ".tiff": { mimeType: "image/tiff", kind: "image" },

  ".txt": { mimeType: "text/plain", kind: "text" },
  ".md": { mimeType: "text/markdown", kind: "text" },
  ".json": { mimeType: "application/json", kind: "text" },
  ".yaml": { mimeType: "text/yaml", kind: "text" },
  ".yml": { mimeType: "text/yaml", kind: "text" },
  ".xml": { mimeType: "text/xml", kind: "text" },
  ".log": { mimeType: "text/plain", kind: "text" },
  ".py": { mimeType: "text/x-python", kind: "text" },
  ".ts": { mimeType: "text/typescript", kind: "text" },
  ".tsx": { mimeType: "text/typescript", kind: "text" },
  ".js": { mimeType: "text/javascript", kind: "text" },
  ".sql": { mimeType: "application/sql", kind: "text" },
  ".sh": { mimeType: "application/x-sh", kind: "text" },
};

const PICKER_FILTERS = [
  { name: "Documents", extensions: ["pdf", "xlsx", "csv", "tsv", "docx"] },
  { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg"] },
  { name: "Text", extensions: ["txt", "md", "json", "yaml", "yml", "xml", "log", "py", "ts", "js", "sql"] },
  { name: "All files", extensions: ["*"] },
];

export function classifyFile(filename: string): { mimeType: string; kind: DocumentKind } {
  return (
    FILE_TYPES[extname(filename).toLowerCase()] ?? {
      mimeType: "application/octet-stream",
      kind: "unknown",
    }
  );
}

/**
 * Tracks the documents the user has opened, and is the only way to turn a
 * renderer request into a path on disk.
 *
 * The renderer asks for bytes by document id, never by path. Ids exist only
 * for files the user picked through the native dialog, so a compromised
 * renderer cannot read arbitrary files — it can only re-read something the
 * user already chose to open. Registrations are per-session and deliberately
 * not persisted.
 */
export class DocumentLibrary {
  readonly #paths = new Map<string, string>();

  /** Prompts the user for files and registers whatever they choose. */
  async pick(window: BaseWindow | null): Promise<DocumentRef[]> {
    const result = window
      ? await dialog.showOpenDialog(window, {
          title: "Open document",
          properties: ["openFile", "multiSelections"],
          filters: PICKER_FILTERS,
        })
      : await dialog.showOpenDialog({
          title: "Open document",
          properties: ["openFile", "multiSelections"],
          filters: PICKER_FILTERS,
        });

    if (result.canceled) return [];

    const refs = await Promise.all(result.filePaths.map((path) => this.register(path)));
    return refs.filter((ref): ref is DocumentRef => ref !== null);
  }

  /** Registers a path and returns its reference, or `null` if unreadable. */
  async register(path: string): Promise<DocumentRef | null> {
    let byteSize: number;
    try {
      const stats = await stat(path);
      if (!stats.isFile()) return null;
      byteSize = stats.size;
    } catch (error) {
      console.error(`[documents] cannot stat ${path}`, error);
      return null;
    }

    const filename = basename(path);
    const { mimeType, kind } = classifyFile(filename);
    const id = randomUUID();
    this.#paths.set(id, path);

    return { id, filename, mimeType, kind, byteSize, source: { type: "file", path } };
  }

  /**
   * Re-registers `id → path` pairs recovered from persisted chat history.
   *
   * Ids issued in an earlier session are otherwise unknown to this process,
   * which would leave a thread unable to preview its own attachments after a
   * restart. Ids this session already issued are never overwritten, so a
   * restore cannot redirect a live registration at a different file.
   *
   * Paths are not checked here: a file that has since moved should fail when
   * it is actually read, not silently vanish from a thread at startup.
   */
  restore(entries: Iterable<readonly [string, string]>): number {
    let restored = 0;
    for (const [documentId, path] of entries) {
      if (this.#paths.has(documentId)) continue;
      this.#paths.set(documentId, path);
      restored += 1;
    }
    return restored;
  }

  /**
   * Reads a registered document.
   *
   * Rejects unknown ids and anything over the preview cap, so a single huge
   * file cannot exhaust memory in the renderer it is being sent to.
   */
  async read(documentId: string): Promise<Buffer> {
    const path = this.#paths.get(documentId);
    if (!path) throw new Error("Unknown document — it was not opened in this session.");

    // Restored registrations can outlive the file they name, so a missing
    // path is reported as a moved file rather than a raw ENOENT.
    let size: number;
    try {
      ({ size } = await stat(path));
    } catch {
      throw new Error(`${basename(path)} is no longer at ${path}.`);
    }

    if (size > MAX_PREVIEW_BYTES) {
      throw new Error(
        `File is ${formatMegabytes(size)} — larger than the ${formatMegabytes(MAX_PREVIEW_BYTES)} preview limit.`,
      );
    }

    return readFile(path);
  }

  /** Whether this id was issued locally, as opposed to being a backend artifact. */
  has(documentId: string): boolean {
    return this.#paths.has(documentId);
  }

  /** Path for a registered document, for parsers that stream from disk. */
  pathFor(documentId: string): string {
    const path = this.#paths.get(documentId);
    if (!path) throw new Error("Unknown document — it was not opened in this session.");
    return path;
  }
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
