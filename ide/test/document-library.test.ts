import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { MAX_PREVIEW_BYTES } from "@shared/types.js";

// `document-library` imports Electron's dialog, which does not exist outside a
// running app. Only `pick()` touches it, and that needs a real window, so the
// module is stubbed and the file-handling behaviour tested directly.
vi.mock("electron", () => ({ dialog: { showOpenDialog: vi.fn() } }));

const { DocumentLibrary, classifyFile } = await import("../src/main/services/document-library.js");

describe("classifyFile", () => {
  it("maps known extensions to a family", () => {
    expect(classifyFile("report.pdf")).toMatchObject({ kind: "pdf" });
    expect(classifyFile("book.xlsx")).toMatchObject({ kind: "spreadsheet" });
    expect(classifyFile("data.csv")).toMatchObject({ kind: "spreadsheet" });
    expect(classifyFile("notes.docx")).toMatchObject({ kind: "wordprocessing" });
    expect(classifyFile("chart.png")).toMatchObject({ kind: "image" });
    expect(classifyFile("main.py")).toMatchObject({ kind: "text" });
  });

  it("is case-insensitive about the extension", () => {
    expect(classifyFile("REPORT.PDF")).toMatchObject({ kind: "pdf" });
  });

  it("keeps TIFF in the image family so the viewer can explain the gap", () => {
    expect(classifyFile("scan.tiff")).toMatchObject({ kind: "image", mimeType: "image/tiff" });
  });

  it("falls back to unknown for anything unrecognised", () => {
    expect(classifyFile("archive.7z")).toMatchObject({ kind: "unknown" });
    expect(classifyFile("no-extension")).toMatchObject({ kind: "unknown" });
  });
});

describe("DocumentLibrary", () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "workbench-docs-"));
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("registers a file and describes it", async () => {
    const path = join(directory, "notes.txt");
    await writeFile(path, "hello");

    const ref = await new DocumentLibrary().register(path);

    expect(ref).toMatchObject({ filename: "notes.txt", kind: "text", byteSize: 5 });
    expect(ref?.source).toEqual({ type: "file", path });
  });

  it("returns the file's bytes for a registered id", async () => {
    const path = join(directory, "read-me.txt");
    await writeFile(path, "contents");

    const library = new DocumentLibrary();
    const ref = await library.register(path);
    const bytes = await library.read(ref!.id);

    expect(bytes.toString("utf8")).toBe("contents");
  });

  it("refuses an id it never issued", async () => {
    await expect(new DocumentLibrary().read("not-a-real-id")).rejects.toThrow(/Unknown document/);
  });

  it("refuses a path registered with a different library instance", async () => {
    // Ids are per-session state, not a token another instance would honour.
    const path = join(directory, "isolated.txt");
    await writeFile(path, "x");

    const owner = new DocumentLibrary();
    const ref = await owner.register(path);

    await expect(new DocumentLibrary().read(ref!.id)).rejects.toThrow(/Unknown document/);
  });

  it("returns null for a directory rather than registering it", async () => {
    expect(await new DocumentLibrary().register(directory)).toBeNull();
  });

  it("returns null for a path that does not exist", async () => {
    expect(await new DocumentLibrary().register(join(directory, "missing.txt"))).toBeNull();
  });

  it("refuses to read a file over the preview limit", async () => {
    const path = join(directory, "huge.bin");
    await writeFile(path, "");
    // Sparse file: reports an oversized length without writing 25 MB.
    await truncate(path, MAX_PREVIEW_BYTES + 1);

    const library = new DocumentLibrary();
    const ref = await library.register(path);

    await expect(library.read(ref!.id)).rejects.toThrow(/preview limit/);
  });

  it("reads a file that sits just under the limit", async () => {
    const path = join(directory, "just-ok.bin");
    await writeFile(path, "");
    await truncate(path, MAX_PREVIEW_BYTES);

    const library = new DocumentLibrary();
    const ref = await library.register(path);

    await expect(library.read(ref!.id)).resolves.toBeInstanceOf(Buffer);
  });
});
