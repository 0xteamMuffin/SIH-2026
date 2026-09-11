import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DocumentReadRequest } from "@shared/types.js";

import { buildCsv, buildXlsx } from "./fixtures.js";

// The handlers register through `ipcMain.handle`, so the mock captures them by
// channel and the tests invoke them the way Electron would. Note the listener
// Electron receives takes `(event, request)` — `typed-handle` flips the pair
// before calling the handler itself.
const handlers = new Map<string, (event: unknown, request: unknown) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, request: unknown) => unknown) => {
      handlers.set(channel, listener);
    },
  },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
}));

const { registerDocumentHandlers } = await import("../src/main/ipc/document.js");

const LOCAL_ID = "9a1f0f4c-1f0e-4b2e-9c9c-6b1d2e3f4a5b";
const ARTIFACT_ID = "dbcdeee0-3142-4a48-ad00-46a0497c1fe2";

function setup(options: {
  localPaths?: Record<string, string>;
  localBytes?: Buffer;
  artifact?: { bytes: Buffer; filename: string | null; mimeType: string | null };
}) {
  const paths = options.localPaths ?? {};
  const downloadArtifact = vi.fn(async () => {
    if (!options.artifact) throw new Error("Download failed (404)");
    return options.artifact;
  });

  const library = {
    has: (id: string) => id in paths,
    pathFor: (id: string) => paths[id]!,
    read: async () => options.localBytes ?? Buffer.from(""),
  };
  const session = { requireClient: () => ({ downloadArtifact }) };

  handlers.clear();
  registerDocumentHandlers(library as never, session as never);
  return { downloadArtifact };
}

function invoke(channel: string, request: DocumentReadRequest | Record<string, unknown>) {
  const listener = handlers.get(channel);
  if (!listener) throw new Error(`No handler registered for ${channel}`);
  return listener({ sender: {} }, request);
}

describe("reading a document by source", () => {
  beforeEach(() => {
    handlers.clear();
  });

  it("reads a file-backed document from the library", async () => {
    const { downloadArtifact } = setup({
      localPaths: { [LOCAL_ID]: "/tmp/readings.csv" },
      localBytes: Buffer.from("a,b\n1,2\n"),
    });

    const bytes = await invoke("document:read", { documentId: LOCAL_ID, sourceType: "file" });

    expect(Buffer.from(bytes as ArrayBuffer).toString()).toBe("a,b\n1,2\n");
    expect(downloadArtifact).not.toHaveBeenCalled();
  });

  // The regression: library registrations are per-session, so an id from an
  // earlier session is absent. It must fail as a stale local document rather
  // than being retried against the backend, where it became a bare 404.
  it("reports a stale local id instead of asking the backend for it", async () => {
    const { downloadArtifact } = setup({ localPaths: {} });

    await expect(
      invoke("document:read", { documentId: LOCAL_ID, sourceType: "file" }),
    ).rejects.toThrow(/no longer registered/i);
    expect(downloadArtifact).not.toHaveBeenCalled();
  });

  it("fetches an artifact-backed document from the backend", async () => {
    const { downloadArtifact } = setup({
      artifact: { bytes: Buffer.from("generated"), filename: "note.docx", mimeType: null },
    });

    const bytes = await invoke("document:read", {
      documentId: ARTIFACT_ID,
      sourceType: "artifact",
    });

    expect(Buffer.from(bytes as ArrayBuffer).toString()).toBe("generated");
    expect(downloadArtifact).toHaveBeenCalledWith(ARTIFACT_ID);
  });
});

describe("reading a spreadsheet", () => {
  beforeEach(() => {
    handlers.clear();
  });

  it("parses a workbook artifact using the name the server sent", async () => {
    setup({
      artifact: { bytes: await buildXlsx(), filename: "workbook.xlsx", mimeType: null },
    });

    const model = await invoke("document:read-spreadsheet", {
      documentId: ARTIFACT_ID,
      sourceType: "artifact",
    });

    expect((model as { sheets: unknown[] }).sheets.length).toBeGreaterThan(0);
  });

  it("parses a delimited artifact by its extension rather than assuming xlsx", async () => {
    setup({ artifact: { bytes: buildCsv(), filename: "readings.csv", mimeType: null } });

    const model = (await invoke("document:read-spreadsheet", {
      documentId: ARTIFACT_ID,
      sourceType: "artifact",
    })) as { sheets: Array<{ rows: unknown[] }> };

    expect(model.sheets[0]!.rows.length).toBeGreaterThan(0);
  });

  // Most generated artifacts are .docx. Previously every artifact reaching
  // this handler was assumed to be xlsx and failed inside the parser.
  it("rejects an artifact that is not a spreadsheet", async () => {
    setup({ artifact: { bytes: Buffer.from("PK"), filename: "note.docx", mimeType: null } });

    await expect(
      invoke("document:read-spreadsheet", { documentId: ARTIFACT_ID, sourceType: "artifact" }),
    ).rejects.toThrow(/not a spreadsheet/i);
  });
});
