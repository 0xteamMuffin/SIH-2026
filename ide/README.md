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

The UI shell, the IPC contract, the diff renderer, document previews, and the
embedded browser are built and working. One piece is deliberately stubbed:

| Area | State | Where |
| --- | --- | --- |
| Agent execution | `ScriptedAgentGateway` replays canned turns; no model, no network | `src/main/services/scripted-agent.ts` |

It sits behind an interface, so replacing it touches nothing else. See
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
type MessageBlock = TextBlock | StatusBlock | DiffBlock | DocumentBlock | BrowserBlock;
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
| Browser pane seam | `src/renderer/src/hooks/useBrowserPane.ts` |

## Next steps

1. Replace `ScriptedAgentGateway` with an HTTP client against the backend's run
   API, translating streamed tool calls and artifacts into blocks.
2. Fetch `artifact`-sourced documents from the backend's object storage, so
   agent-produced files preview the same way attached ones do.
3. A human-in-the-loop approval panel for the backend's `WAITING_APPROVAL`
   gate — `awaiting-approval` exists in `RunState` but has no UI.
4. Authentication — reuse the backend's JWT flow and hold the token in main,
   never in the renderer.
5. Agentic browsing, on top of the `webContents` the pane already owns.
