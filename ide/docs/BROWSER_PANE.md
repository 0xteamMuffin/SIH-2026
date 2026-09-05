# The embedded browser

Opening a URL inside the IDE works today. This explains the primitive chosen,
the one architectural constraint it imposes, and what agentic browsing will
need from it later.

## Why `WebContentsView`

| Approach | Status in Electron 44 | Composites with DOM | Safe for untrusted content | Automatable |
| --- | --- | --- | --- | --- |
| **`WebContentsView`** | Current, recommended | No | Yes | Yes, fully |
| `<webview>` tag | Actively discouraged | Yes | No | Partially |
| `BrowserView` | Deprecated since 29/30 | No | No | Yes, but a dead end |
| `<iframe>` | Supported web platform | Yes | Only for content you control | **No** |

`<webview>`'s own documentation page opens with a warning recommending against
it and states Electron does not guarantee the API will remain available.
`BrowserView` has been a thin wrapper around `WebContentsView` since Electron
30. A plain `<iframe>` fails on most real sites (`X-Frame-Options`,
`frame-ancestors`) and, more importantly, gives no `webContents` handle — which
makes agentic browsing impossible without a rewrite.

`WebContentsView` is the only option that is simultaneously current,
process-isolated, and automatable.

## The constraint: it is not part of the DOM

A `WebContentsView` is a native view positioned by the main process. It cannot
be laid out by CSS, clipped by an ancestor, or interleaved with DOM content —
it draws entirely above (or below) the React UI.

Two consequences shaped the design:

**The renderer measures, main positions.** `BrowserPanel` renders an empty
`.browser__slot` div whose only job is to reserve space and be measured.
`useBrowserPane` reports its rectangle via `ResizeObserver` plus window
`resize` and capture-phase `scroll` listeners; main calls `setBounds` to match.
There is no auto-resize on `View` — the deprecated `BrowserView.setAutoResize`
has no successor — so main also re-applies the last rectangle on window
`resize`.

**The browser is a fixed pane, not an inline chat block.** A native view inside
the scrolling thread would paint over the sidebar and composer as the user
scrolled. So a `BrowserBlock` in a message renders as a *card*; clicking it
opens the page in a stable pane on the right. This is a deliberate UX
consequence of the primitive, not a shortcut.

There is also only **one** pane, since two native overlays could not be stacked
sensibly against the React UI.

## Hardening

Applied in `src/main/services/browser-pane.ts`, and verified by a smoke test
against a live URL:

- **No `preload`.** The most important line. With no preload and context
  isolation on, `window.workbench` simply does not exist in the guest —
  confirmed, along with `require` being `undefined`.
- Own session partition (`persist:workbench-browser`), so nothing a visited
  page stores is reachable from the app's own web contents.
- `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`,
  `nodeIntegrationInSubFrames: false`, `webSecurity: true`,
  `allowRunningInsecureContent: false`, `experimentalFeatures: false`.
- `webviewTag: false` — the guest cannot embed its own guest view.
- `disableDialogs: true` — an untrusted page cannot block the UI with
  `alert`/`confirm`.
- `setPermissionRequestHandler` **and** `setPermissionCheckHandler` both deny.
  Both are required: most web APIs perform a permission *check* first and only
  fall back to a *request* if the check fails, so handling one half silently
  allows some capabilities.
- `setDevicePermissionHandler` denies HID/serial/USB;
  `setDisplayMediaRequestHandler(null)` denies screen capture.
- `setWindowOpenHandler` denies all popups, handing vetted URLs to the system
  browser.
- `will-navigate` **and** `will-frame-navigate` both enforce the allowlist —
  the first covers the main frame, the second every subframe. Neither fires for
  our own `loadURL`, which is why `open()` checks the policy itself.

`setCertificateVerifyProc` is deliberately **not** used. It replaces Chromium's
verification wholesale, and accepting with `callback(0)` also disables
Certificate Transparency. For an on-premise CA, install the root into the OS
trust store instead.

### Teardown matters

A `WebContentsView`'s `webContents` is **not** destroyed when its window
closes. `close()` removes the child view and then calls
`webContents.close()`; skipping that leaks a renderer process per pane. The
destruction is asynchronous — `isDestroyed()` stays false until the
`destroyed` event fires, which is expected, not a leak.

## What agentic browsing will need

All confirmed present on the guest's `webContents` in Electron 44:

- `executeJavaScript` / `executeJavaScriptInIsolatedWorld` — use a private
  world id so automation helpers cannot be observed by page script.
- `capturePage` — screenshots for a vision model. `stayHidden` allows capture
  without making the pane visible. Note it needs a composited window.
- `sendInputEvent` — synthetic mouse and keyboard events. **Caveat:** the
  containing window must be focused for this to work.
- `webContents.debugger` — full Chrome DevTools Protocol via `attach` and
  `sendCommand`. This is the stronger path for background driving:
  `Input.dispatchMouseEvent` and `Input.insertText` do not require window
  focus, and the `DOM`/`Accessibility` domains give structured page state. It
  detaches if DevTools is opened on the same contents, so do not do both.

The driver attaches to a `webContents` the pane already owns, so that work is
purely additive.

## Sources

Verified against the `44-x-y` docs branch:
[`web-contents-view`](https://www.electronjs.org/docs/latest/api/web-contents-view),
[`view`](https://www.electronjs.org/docs/latest/api/view),
[`base-window`](https://www.electronjs.org/docs/latest/api/base-window),
[`webview-tag`](https://www.electronjs.org/docs/latest/api/webview-tag),
[`web-embeds`](https://www.electronjs.org/docs/latest/tutorial/web-embeds),
[`security`](https://www.electronjs.org/docs/latest/tutorial/security),
[`session`](https://www.electronjs.org/docs/latest/api/session),
[`web-contents`](https://www.electronjs.org/docs/latest/api/web-contents).
