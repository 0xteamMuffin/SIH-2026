import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { app, BrowserWindow } from "electron";

import { EventBroadcaster } from "../../src/main/events.js";
import { registerIpcHandlers } from "../../src/main/ipc/index.js";
import { BrowserPane } from "../../src/main/services/browser-pane.js";
import { ChatService } from "../../src/main/services/chat-service.js";
import { ChatStore } from "../../src/main/services/chat-store.js";
import { DocumentLibrary } from "../../src/main/services/document-library.js";
import { SessionManager } from "../../src/main/services/session.js";
import type { AgentGateway } from "../../src/main/services/agent-gateway.js";
import { buildCsv, buildDocx, buildPdf, buildPng, buildXlsx } from "../fixtures.js";

/**
 * End-to-end check that documents actually render.
 *
 * Runs the real service graph against the real built renderer, attaches
 * generated fixtures to a chat, expands every preview, and inspects the
 * resulting DOM and canvas pixels.
 *
 * This covers the fragile parts of the preview stack that unit tests cannot
 * reach: that pdf.js finds its four runtime asset directories, that its
 * worker resolves, and that the CSP permits WASM and blob workers. All of
 * that only exists inside a real renderer.
 *
 * Run with `npm run test:e2e` — needs a display and a prior `npm run build`.
 */

/**
 * Supplied by `scripts/run-e2e.mjs`. The test is bundled to CommonJS, where
 * `import.meta.url` is undefined, so the path cannot be derived from the
 * module's own location.
 */
const IDE_ROOT = requireEnv("WORKBENCH_IDE_ROOT");

/**
 * The workbench has no offline mode — it gates on a backend connection — so
 * this suite signs in before it can reach the thread it needs to drive.
 */
const BACKEND_URL = process.env["WORKBENCH_BACKEND_URL"] ?? "http://localhost:4000";
const ADMIN_EMAIL = process.env["SEED_ADMIN_EMAIL"] ?? "admin@sih.local";
const ADMIN_PASSWORD = process.env["SEED_ADMIN_PASSWORD"] ?? "";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — run via \`npm run test:e2e\`.`);
  return value;
}

let failures = 0;

function check(label: string, passed: boolean, detail = ""): void {
  console.log(`${passed ? "  ok  " : "  FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!passed) failures += 1;
}

/** Polls until `predicate` holds, then returns the latest value. */
async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest = await read();

  while (Date.now() < deadline) {
    latest = await read();
    if (predicate(latest)) return latest;
    await new Promise((settle) => setTimeout(settle, 250));
  }
  return latest;
}

async function run(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "workbench-e2e-"));
  const fixtures: Record<string, Buffer> = {
    "report.pdf": buildPdf(),
    "readings.xlsx": await buildXlsx(),
    "batches.csv": buildCsv(),
    "notes.docx": await buildDocx("Deviation DEV-114 was closed on review."),
    "chart.png": buildPng(),
    "pipeline.py": Buffer.from("def flag():\n    return 42\n", "utf8"),
  };

  const paths: string[] = [];
  for (const [name, data] of Object.entries(fixtures)) {
    const path = join(directory, name);
    await writeFile(path, data);
    paths.push(path);
  }

  const events = new EventBroadcaster();
  const store = await ChatStore.open(directory);
  // This suite exercises document rendering, not the agent, so the gateway is
  // a no-op: the user's own message carries the attachments being previewed.
  const idleAgent: AgentGateway = { runTurn: async ({ publish }) => publish([]) };
  const chats = new ChatService(store, idleAgent, events);
  const documents = new DocumentLibrary();
  const session = new SessionManager(events);
  const pane = new BrowserPane(events);
  registerIpcHandlers({ chats, documents, session, browserPane: pane });

  const window = new BrowserWindow({
    width: 1400,
    height: 950,
    show: false,
    webPreferences: {
      preload: join(IDE_ROOT, "out/preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  events.setTarget(window.webContents);
  pane.attach(window);

  const connected = await session.connect(BACKEND_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
  if (connected.status !== "connected") {
    console.error(`\nCannot reach the backend at ${BACKEND_URL}: ${connected.error ?? "unknown error"}`);
    console.error("Start the stack and set SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD, then retry.\n");
    failures += 1;
    return;
  }

  const cspViolations: string[] = [];
  window.webContents.on("console-message", (event) => {
    if (/Content Security Policy|Refused to/i.test(event.message)) {
      cspViolations.push(event.message);
    }
    if (event.level === "error") console.log("   [renderer error]", event.message.slice(0, 200));
  });

  await window.loadFile(join(IDE_ROOT, "out/renderer/index.html"));
  const contents = window.webContents;
  const evaluate = <T>(expression: string): Promise<T> =>
    contents.executeJavaScript(expression) as Promise<T>;

  // Wait for React to mount *and* for it to have created its first chat.
  // Creating one here instead would race the renderer and leave the message in
  // a chat the UI is not viewing.
  await waitFor(() => evaluate<boolean>(`!!document.querySelector('.composer')`), (ready) => ready);
  await waitFor(async () => chats.list().length, (count) => count > 0);

  const chat = chats.list()[0]!;
  const activeTitle = await evaluate<string | null>(
    `document.querySelector('.sidebar__link--active .sidebar__title')?.textContent ?? null`,
  );
  check("renderer has an active chat", activeTitle !== null, String(activeTitle));

  const refs = [];
  for (const path of paths) {
    const ref = await documents.register(path);
    if (ref) refs.push(ref);
  }
  check("all fixtures registered", refs.length === paths.length, `${refs.length}/${paths.length}`);

  chats.send(chat.id, "here are the files", refs);

  const cardCount = await waitFor(
    () => evaluate<number>(`document.querySelectorAll('.document-card').length`),
    (count) => count >= paths.length,
  );
  check("document cards rendered in thread", cardCount >= paths.length, `cards=${cardCount}`);

  // `Save` shares the button class, so match on the label.
  const toggles = await evaluate<number>(
    `[...document.querySelectorAll('.document-card__toggle')].filter(b => b.textContent === 'Preview').length`,
  );
  check("every fixture offers a preview", toggles === paths.length, `toggles=${toggles}`);

  await evaluate(`document.querySelectorAll('.document-card__toggle').forEach(b => b.click()); true`);

  console.log("\n-- PDF --");
  const pdf = await waitFor(
    () =>
      evaluate<{ present: boolean; width?: number; height?: number; darkPixels?: number }>(`(() => {
        const canvas = document.querySelector('canvas.pdf__page');
        if (!canvas) return { present: false };
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let darkPixels = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] < 100 && pixels[i + 1] < 100 && pixels[i + 2] < 100) darkPixels++;
        }
        return { present: true, width: canvas.width, height: canvas.height, darkPixels };
      })()`),
    (result) => result.present && (result.darkPixels ?? 0) > 0,
  );
  check("canvas present", pdf.present);
  check("canvas has real dimensions", (pdf.width ?? 0) > 0, `${pdf.width}x${pdf.height}`);
  // The fixture is a filled black square, so a blank page would be unambiguous.
  check("rendered actual page content", (pdf.darkPixels ?? 0) > 1000, `dark=${pdf.darkPixels}`);

  console.log("\n-- Spreadsheet (xlsx) --");
  const sheet = await waitFor(
    () =>
      evaluate<{
        present: boolean;
        headers?: string[];
        body?: string[][];
        tabs?: string[];
      }>(`(() => {
        const table = document.querySelector('.sheet__table');
        if (!table) return { present: false };
        return {
          present: true,
          headers: [...table.querySelectorAll('thead th')].map(e => e.textContent),
          body: [...table.querySelectorAll('tbody tr')].map(tr =>
            [...tr.querySelectorAll('td')].map(td => td.textContent)),
          tabs: [...document.querySelectorAll('.sheet__tab')].map(e => e.textContent),
        };
      })()`),
    (result) => result.present && (result.body?.length ?? 0) > 0,
  );
  check("table rendered", sheet.present);
  check(
    "headers correct",
    JSON.stringify(sheet.headers) === JSON.stringify(["", "Batch", "Value", "Recorded", "Flagged"]),
    JSON.stringify(sheet.headers),
  );
  check("data row present", sheet.body?.[0]?.[0] === "QA-2291", JSON.stringify(sheet.body?.[0]));
  check("date formatted", sheet.body?.[0]?.[2] === "2026-01-15");
  check("formula shows its result", sheet.body?.some((row) => row[1] === "0.875") === true);
  check(
    "both sheet tabs shown",
    JSON.stringify(sheet.tabs) === JSON.stringify(["Readings", "Notes"]),
    JSON.stringify(sheet.tabs),
  );

  console.log("\n-- CSV --");
  const csv = await evaluate<{ found: boolean; cells?: string[] }>(`(() => {
    for (const table of document.querySelectorAll('.sheet__table')) {
      const headers = [...table.querySelectorAll('thead th')].map(e => e.textContent);
      if (headers.includes('Notes')) {
        return { found: true, cells: [...table.querySelectorAll('tbody td')].map(e => e.textContent) };
      }
    }
    return { found: false };
  })()`);
  check("csv table rendered", csv.found);
  check(
    "quoted comma stays in one cell",
    csv.cells?.includes("Within tolerance, no action") === true,
    JSON.stringify(csv.cells?.slice(0, 3)),
  );

  console.log("\n-- DOCX --");
  const docx = await waitFor(
    () =>
      evaluate<{ present: boolean; text: string }>(`(() => {
        const host = document.querySelector('.docx-host');
        return { present: !!host, text: host ? host.textContent.trim() : '' };
      })()`),
    (result) => result.present && result.text.length > 0,
  );
  check("docx rendered", docx.present);
  check("paragraph text extracted", docx.text.includes("DEV-114"));

  console.log("\n-- Image --");
  const image = await waitFor(
    () =>
      evaluate<{ width: number }>(`(() => {
        const img = document.querySelector('img.image-preview');
        return { width: img?.naturalWidth ?? 0 };
      })()`),
    (result) => result.width > 0,
  );
  check("image decoded", image.width > 0, `naturalWidth=${image.width}`);

  console.log("\n-- Text --");
  const text = await evaluate<{ present: boolean; text: string }>(`(() => {
    const pre = document.querySelector('.textfile__body');
    return { present: !!pre, text: pre?.textContent ?? '' };
  })()`);
  check("text file rendered", text.present);
  check("contents shown", text.text.includes("def flag()"));

  console.log("\n-- CSP --");
  check(
    "no CSP violations during rendering",
    cspViolations.length === 0,
    cspViolations.slice(0, 2).join(" | "),
  );
}

app
  .whenReady()
  .then(run)
  .then(() => {
    console.log(failures === 0 ? "\nALL PASSED\n" : `\n${failures} FAILURE(S)\n`);
    app.exit(failures === 0 ? 0 : 1);
  })
  .catch((error: unknown) => {
    console.error("e2e crashed:", error);
    app.exit(2);
  });
