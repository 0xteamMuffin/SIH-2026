import { WebContentsView, session, shell, type BaseWindow, type Session } from "electron";

import { CLOSED_BROWSER_PANE, type BrowserPaneState, type ViewBounds } from "@shared/types.js";

import type { EventBroadcaster } from "../events.js";
import { evaluateUrl } from "./url-policy.js";

/**
 * Cookie/cache jar for embedded content. Deliberately *not* `defaultSession`,
 * so nothing a visited page stores can be read by the app's own web contents.
 * The `persist:` prefix keeps it on disk across restarts; drop the prefix for
 * an in-memory, forget-on-quit jar.
 */
const BROWSER_PARTITION = "persist:workbench-browser";

/**
 * The embedded browser pane, backed by a single `WebContentsView`.
 *
 * `WebContentsView` is the primitive Electron currently recommends for
 * embedding third-party content — `<webview>` is documented as discouraged and
 * `BrowserView` is deprecated. The tradeoff is that it is a native view
 * outside the DOM: it cannot be clipped or stacked by CSS, so the renderer
 * must tell us the rectangle to occupy and we must reposition on resize
 * ourselves (there is no auto-resize on `View`).
 *
 * The same `webContents` handle is what a future agentic-browsing driver
 * needs — `capturePage` for vision input, `sendInputEvent` or
 * `webContents.debugger` (CDP) for synthetic interaction — so this class is
 * the intended attachment point for that work rather than a throwaway.
 */
export class BrowserPane {
  readonly #events: EventBroadcaster;

  #window: BaseWindow | null = null;
  #view: WebContentsView | null = null;
  #bounds: ViewBounds | null = null;
  #error: string | undefined;

  constructor(events: EventBroadcaster) {
    this.#events = events;
  }

  /**
   * Binds the pane to a window. One instance lives for the whole app run —
   * IPC handlers are process-wide and would otherwise keep pointing at a pane
   * belonging to a window that has since closed — so re-attaching drops any
   * view owned by the previous window.
   */
  attach(window: BaseWindow): void {
    this.close();
    this.#window = window;

    // `View` has no auto-resize, so the last reported rectangle is re-applied
    // whenever the window geometry changes.
    window.on("resize", () => this.#applyBounds());
  }

  /** Opens `url`, creating the native view on first use. */
  async open(url: string, bounds: ViewBounds): Promise<BrowserPaneState> {
    const window = this.#window;
    if (!window) throw new Error("Browser pane is not attached to a window");

    const decision = evaluateUrl(url);
    if (!decision.allowed) {
      this.#error = decision.reason;
      const state = this.state();
      this.#emit(state);
      return state;
    }

    this.#error = undefined;
    this.#bounds = bounds;

    const view = this.#view ?? this.#createView(window);
    this.#applyBounds();

    try {
      await view.webContents.loadURL(url);
    } catch (error) {
      // A failed load still leaves a usable pane, so this is reported in the
      // pane's own state rather than thrown back at the renderer.
      this.#error = describe(error);
    }

    const state = this.state();
    this.#emit(state);
    return state;
  }

  setBounds(bounds: ViewBounds): void {
    this.#bounds = bounds;
    this.#applyBounds();
  }

  goBack(): void {
    const history = this.#view?.webContents.navigationHistory;
    if (history?.canGoBack()) history.goBack();
  }

  goForward(): void {
    const history = this.#view?.webContents.navigationHistory;
    if (history?.canGoForward()) history.goForward();
  }

  reload(): void {
    this.#view?.webContents.reload();
  }

  /** Opens a vetted URL in the user's real browser. */
  async openExternal(url: string): Promise<void> {
    const decision = evaluateUrl(url);
    if (!decision.allowed) throw new Error(decision.reason ?? "Blocked by URL policy");
    await shell.openExternal(url);
  }

  /**
   * Tears the pane down.
   *
   * A `WebContentsView`'s `webContents` is not destroyed with its window, so
   * closing it explicitly is required to avoid leaking a renderer process.
   */
  close(): void {
    const view = this.#view;
    this.#view = null;
    this.#bounds = null;
    this.#error = undefined;

    if (view) {
      // `attach` closes before swapping `#window`, so this is still the window
      // that actually owns the view.
      this.#window?.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }

    this.#emit(CLOSED_BROWSER_PANE);
  }

  state(): BrowserPaneState {
    const contents = this.#view?.webContents;
    if (!contents || contents.isDestroyed()) {
      return this.#error ? { ...CLOSED_BROWSER_PANE, error: this.#error } : CLOSED_BROWSER_PANE;
    }

    const state: BrowserPaneState = {
      url: contents.getURL() || null,
      title: contents.getTitle(),
      isLoading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
    };
    return this.#error ? { ...state, error: this.#error } : state;
  }

  #createView(window: BaseWindow): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        // Note the absence of `preload`. Without one, and with context
        // isolation on, a visited page has no route to this app's IPC bridge —
        // that bridge is attached only to our own window's web contents.
        session: hardenedBrowserSession(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        // A visited page must not be able to embed its own guest view.
        webviewTag: false,
        // Untrusted pages should not be able to block our UI with dialogs.
        disableDialogs: true,
        spellcheck: false,
        navigateOnDragDrop: false,
      },
    });

    const contents = view.webContents;

    // Popups are never opened in-app; vetted ones go to the system browser.
    contents.setWindowOpenHandler(({ url }) => {
      if (evaluateUrl(url).allowed) {
        setImmediate(() => void shell.openExternal(url));
      }
      return { action: "deny" };
    });

    // `will-navigate` covers the main frame; `will-frame-navigate` covers every
    // frame including subframes. Both are needed for a complete allowlist, and
    // neither fires for our own `loadURL`, which `open()` checks separately.
    const guard = (event: { preventDefault: () => void; url: string }): void => {
      const decision = evaluateUrl(event.url);
      if (decision.allowed) return;
      event.preventDefault();
      this.#error = decision.reason;
      this.#emit(this.state());
    };
    contents.on("will-navigate", guard);
    contents.on("will-frame-navigate", guard);

    // Navigation state drives the pane toolbar, so re-publish on every change.
    const publish = (): void => this.#emit(this.state());
    contents.on("did-start-loading", publish);
    contents.on("did-stop-loading", publish);
    contents.on("did-navigate", publish);
    contents.on("did-navigate-in-page", publish);
    contents.on("page-title-updated", publish);
    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      // -3 is ERR_ABORTED, which fires routinely on redirects and user-cancelled
      // loads and is not worth surfacing.
      if (isMainFrame && code !== -3) {
        this.#error = `${description} (${url})`;
      }
      publish();
    });

    // Appending puts the native view above the React UI. The renderer keeps a
    // matching gap in its layout so nothing important sits underneath.
    window.contentView.addChildView(view);
    this.#view = view;
    return view;
  }

  #applyBounds(): void {
    const view = this.#view;
    const bounds = this.#bounds;
    if (!view || !bounds) return;

    view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
  }

  #emit(state: BrowserPaneState): void {
    this.#events.emit({ type: "browser/state-changed", state });
  }
}

let cachedSession: Session | null = null;

/**
 * The isolated session used by embedded content, hardened once and reused.
 *
 * Both permission hooks are installed: most web APIs perform a permission
 * *check* and only fall back to a *request* if the check fails, so handling
 * only the request half would silently allow some capabilities.
 */
function hardenedBrowserSession(): Session {
  if (cachedSession) return cachedSession;

  const browserSession = session.fromPartition(BROWSER_PARTITION);
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.setDevicePermissionHandler(() => false);
  browserSession.setDisplayMediaRequestHandler(null);

  cachedSession = browserSession;
  return browserSession;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
