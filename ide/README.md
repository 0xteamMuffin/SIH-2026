# Sovereign Workbench IDE

The desktop client for the on-premise agentic workbench. It is not a code
editor. It is a chat-first surface — closer to Cursor's agent mode than to VS
Code — where the user states an intent and the agent does the work on the
cluster where the data already lives.

Nothing is edited locally. Code, documents, and datasets stay on the on-premise
deployment; the agent changes them there and writes results back to object
storage or disk. This app sends prompts, streams back what the agent did, and
renders the results: prose, red/green diffs, document previews, and web pages.

## Status

Connected to the on-premise backend and running real work: sign-in, real model
runs, live tool steps, human approval of high-risk tools, and inline previews
of both attached and agent-generated documents.

The backend's agent is a model-driven loop: it chooses its own next tool each
turn and can revise — read a document, find the text garbled, look at the page
as an image, search, then produce the deliverable. See
[docs/DOCUMENT_PREVIEW.md](./docs/DOCUMENT_PREVIEW.md) for the viewer stack and
[docs/BROWSER_PANE.md](./docs/BROWSER_PANE.md) for how the embedded browser
works and what agentic browsing will need from it.

## Running it

```bash
npm install
npm run dev        # electron-vite dev server + app
npm run build      # bundle main, preload, and renderer into out/
npm test           # vitest: diff, URL policy, spreadsheets, document library
npm run test:e2e   # drives the built renderer in Electron (needs a display)
npm run typecheck  # both tsconfig projects
npm run demo:docs  # generate sample documents to try the previews on
```

### Connecting

The workbench has no offline mode: every answer comes from the backend, so the
app opens on a sign-in screen. Start the stack from the repository root, then
sign in with the seeded admin credentials from `.env`:

```bash
docker compose up -d
```

The base stack publishes the API on `http://localhost:4000` and puts the
backend on the `edge` network, because the Electron client runs on the host
rather than inside the compose network. The sovereign stack does neither — it
publishes nothing and keeps the backend on the closed `internal` network.

Add `-f docker-compose.dev.yml` for hot reload. If you do, come back to the
normal stack with `docker compose up -d --build` — the dev override replaces the
backend and worker images with watch-mode variants that need the bind mount.

Credentials go straight to the main process and are never persisted, so a
restart requires signing in again.

In development the form arrives prefilled: main reads `SEED_ADMIN_EMAIL` and
`SEED_ADMIN_PASSWORD` from the repository's `.env`, so connecting is one click.
Override with `WORKBENCH_EMAIL`, `WORKBENCH_PASSWORD`, and
`WORKBENCH_BACKEND_URL`. Nothing is hardcoded and a packaged build
(`app.isPackaged`) never receives these, so a release always opens on an empty
form.

### Trying the previews

`npm run demo:docs` writes eight synthetic industrial documents to
`demo-docs/`. Attach them with the **+** button in the composer, then press
**Preview** on each card.

| File | What it shows |
| --- | --- |
| `inspection-report.pdf` | Two-page PDF, headings and rules |
| `deviation-log.xlsx` | Three sheet tabs, formula results, ISO dates |
| `sensor-readings.csv` | Quoted commas staying inside one cell |
| `approval-note.docx` | Headings, body text, sign-off table |
| `throughput-chart.png` | Image decoding |
| `quality_pipeline.py` | Source text |
| `batch-export.xlsx` | Row cap — "first 2,000 of 3,001 rows" |
| `unsupported-archive.7z` | The honest "no preview" card |

They are generated rather than committed, so the content stays reviewable in
`scripts/make-demo-docs.mjs` and no binaries enter the repository. All content
is synthetic and describes no real asset.

Node 20.19+ or 22.12+. Electron's own tooling warns on Node 20 (`@electron/get`
wants 22.12+) but runs correctly; the bundled runtime is unaffected.

## Architecture

Three contexts, one contract.

```
src/
  main/       Electron main. Owns windows, security policy, the chat store,
              the agent gateway, and the native browser view.
  preload/    The only bridge. A hand-written, narrow contextBridge surface.
  renderer/   React UI. Sandboxed, no Node, no direct Electron access.
  shared/     The contract all three import: domain types, IPC channels,
              and the shape of the preload API.
```

The renderer never polls and never computes. Main pushes every change over a
single event channel, and the renderer renders whatever arrives.

### Messages are blocks, not strings

An agent turn is an ordered list of `MessageBlock`s, because one answer can mix
prose, a diff, a spreadsheet, and a browser session:

```ts
type MessageBlock =
  | TextBlock      // prose, rendered as markdown
  | StatusBlock    // the turn's lifecycle
  | ToolCallBlock  // a step the agent took
  | ApprovalBlock  // a high-risk tool waiting on a human
  | DiffBlock      // red/green file change
  | DocumentBlock  // inline preview
  | BrowserBlock;  // embedded page
```

Rendering is a pure function of that list. Adding a capability is additive: add
a block kind to `src/shared/types.ts` and the renderer's exhaustive switch
fails to compile until it has a view. That is the intended workflow.

### Documents are read by id, never by path

The renderer can only request files the user opened through the native picker.
`DocumentLibrary` in main issues an id per opened file; the renderer never
names a path, so a compromised renderer cannot read arbitrary files off disk.
Reads are capped at 25 MB.

Attach files with the **+** button in the composer. PDF, XLSX, CSV, DOCX,
images, and text render inline.

### Runs are inspectable, not just observable

The thread shows what the agent produced. The trace shows how it got there: the
prompt, which model was routed to and the router's stated reason, every tool
call in order, and the outcome. Clicking a node opens its full detail — a
tool's exact arguments and raw result, or the routing rationale.

It opens on its own when a turn starts and follows the run live, because
showing the work only helps if it is in front of you. **Hide** closes it, and a
**View trace** button on the turn brings it back. Hiding is remembered for that
run, so a poll cannot reopen what was just dismissed; the next turn opens
fresh.

That detail is carried on the message as a `RunTrace`, deliberately beside the
blocks rather than inside them: it is inspection data, not conversation, and
the thread stays readable without it.

The trace and the embedded browser share the right column and are mutually
exclusive, because the browser is a native view that paints over any DOM
beneath it.

### The renderer never holds a credential

Access and refresh tokens live in the main process. The renderer receives only
`SessionState` — who is connected and where — and asks for outcomes ("start
this run"), never constructing a request itself. Silent token refresh on a 401
happens in main too, so a long run does not drop when the short-lived access
token expires.

### Diffs are rendered, never computed

The renderer receives a fully resolved `FilePatch` — hunks, per-side line
numbers, and counts already settled — and only draws it. Patches are built in
main by `src/main/services/diff.ts`. When the backend starts sending real
patches, that one file is replaced and the renderer does not change.

## Security posture

The app shell and the embedded browser are hardened separately, because they
have opposite jobs: the shell is trusted local UI, the browser deliberately
loads untrusted remote pages.

- Renderer: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`.
- The preload is CommonJS on purpose. Electron only supports an ESM preload
  when `sandbox` is false, and keeping the sandbox is worth more than module
  syntax in one bridge file.
- `ipcRenderer` is never exposed — only a named list of functions. In
  particular `ipcRenderer.on` is not forwarded, since its event argument
  carries a `sender` handle back into main.
- Embedded pages get their own session partition, deny-all permission handlers,
  a navigation allowlist, and **no preload at all** — so a visited page has no
  route to this app's IPC bridge. Verified: `window.workbench` and `require`
  are both `undefined` in the guest.
- Every URL check parses with `new URL()`. A `startsWith` test would admit
  `https://example.com.attacker.test`; there is a test for exactly that.

### Locking down browsing

`WORKBENCH_BROWSER_ALLOWLIST` restricts which hosts the embedded browser may
reach. Unset means any host over http/https, which is the right default while
the agent's browsing tool is still being built. A sovereign deployment should
set it:

```bash
WORKBENCH_BROWSER_ALLOWLIST=docs.internal.example.in,wiki.internal.example.in
```

Entries also match subdomains. Non-http(s) schemes are always refused.

## Where things live

| Concern | File |
| --- | --- |
| Composition root | `src/main/index.ts` |
| Window + dev log forwarding | `src/main/window.ts` |
| App-shell hardening | `src/main/security.ts` |
| Chat orchestration | `src/main/services/chat-service.ts` |
| Backend HTTP client | `src/main/services/backend-client.ts` |
| Connection + tokens | `src/main/services/session.ts` |
| Run → blocks projection | `src/main/services/backend-agent.ts` |
| Chat persistence (JSON in userData) | `src/main/services/chat-store.ts` |
| Agent seam | `src/main/services/agent-gateway.ts` |
| Diff construction | `src/main/services/diff.ts` |
| Embedded browser | `src/main/services/browser-pane.ts` |
| URL policy | `src/main/services/url-policy.ts` |
| Document access + classification | `src/main/services/document-library.ts` |
| Spreadsheet parsing | `src/main/services/spreadsheet.ts` |
| Viewer registry | `src/renderer/src/components/preview/registry.ts` |
| IPC contract | `src/shared/ipc.ts`, `src/shared/types.ts`, `src/shared/api.ts` |
| Diff rendering | `src/renderer/src/components/blocks/DiffView.tsx` |
| Run trace graph | `src/renderer/src/components/trace/` |
| Browser pane seam | `src/renderer/src/hooks/useBrowserPane.ts` |

## Next steps

1. The backend's agent loop — replacing the fixed `SOURCE → ANALYZE` pipeline
   with tool-calling iteration, so a turn can plan and revise rather than
   answering once.
2. Streaming instead of polling. The gateway re-reads the run every 1.2s; a
   server-sent event stream would remove the latency and the wasted requests.
3. Multiple attachments per run. The run API takes one source artifact, so the
   rest are uploaded to the workspace but not handed to the turn.
4. Agentic browsing, on top of the `webContents` the pane already owns.
