import type { BrowserWindow, WebContents } from "electron";

/**
 * UI zoom for the app shell.
 *
 * Electron's default menu binds zoom-in to `CommandOrControl+Plus`, and on a
 * US/UK layout the `+` glyph requires Shift — so `Ctrl+-` zoomed out while
 * `Ctrl+=`, the key people actually press, did nothing. Rather than fight
 * accelerator matching, the shortcuts are handled from the raw key event,
 * which sees every variant: `=`, `+`, the numpad keys, and Shift or not.
 *
 * Zoom applies to the shell's own renderer only. The embedded browser is a
 * separate `WebContents`, so a page in the pane keeps its own zoom — which is
 * the behaviour a browser inside an app should have.
 */

/** Chromium's zoom-level unit: a whole step is a 1.2× change. */
const ZOOM_STEP = 0.5;

/*
 * Bounds, not because Chromium needs them, but because the shell's layout
 * does: the three-pane grid stops being usable once the sidebar and panel
 * minimums no longer fit, and there is no way back if the controls have been
 * scaled off screen.
 */
const ZOOM_MIN = -2;
const ZOOM_MAX = 3.5;

export function stepZoom(contents: WebContents, direction: 1 | -1): void {
  const next = contents.getZoomLevel() + direction * ZOOM_STEP;
  contents.setZoomLevel(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next)));
}

export function resetZoom(contents: WebContents): void {
  contents.setZoomLevel(0);
}

/** What a key press means for zoom, or `null` if it means nothing. */
type ZoomAction = "in" | "out" | "reset";

function zoomActionFor(key: string, code: string): ZoomAction | null {
  // `=` is the unshifted key; `+` is the shifted one and the numpad key.
  if (key === "=" || key === "+" || code === "NumpadAdd") return "in";
  if (key === "-" || key === "_" || code === "NumpadSubtract") return "out";
  if (key === "0" || code === "Numpad0") return "reset";
  return null;
}

export function registerZoomShortcuts(window: BrowserWindow): void {
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;

    const accelerator = process.platform === "darwin" ? input.meta : input.control;
    // Alt-modified combinations belong to the OS or to the page.
    if (!accelerator || input.alt) return;

    const action = zoomActionFor(input.key, input.code);
    if (!action) return;

    // Claimed before the renderer sees it, so the composer does not also
    // receive a `-` or a `0`.
    event.preventDefault();

    if (action === "reset") resetZoom(window.webContents);
    else stepZoom(window.webContents, action === "in" ? 1 : -1);
  });
}
