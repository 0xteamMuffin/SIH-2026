import { join } from "node:path";

import { BrowserWindow } from "electron";

import { registerZoomShortcuts } from "./zoom.js";

/** Below this the three-pane layout stops being usable. */
const MIN_WIDTH = 900;
const MIN_HEIGHT = 600;

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    // Painting only once the renderer is ready avoids a white flash against
    // the dark UI.
    show: false,
    // Matches `--bg-canvas` in the renderer's dark theme, which is the
    // default a fresh profile opens in. The window is hidden until the
    // renderer has applied the stored theme, so this is only ever seen for
    // the frame before `ready-to-show`.
    backgroundColor: "#0b0a09",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    // Belt and braces: the application menu is removed on Windows and Linux
    // (see menu.ts) because the shell draws its own title bar, and a native
    // menu bar above it would look grafted on.
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });

  registerZoomShortcuts(window);

  window.once("ready-to-show", () => window.show());

  // A failed preload leaves the UI alive but with no bridge to main, which
  // looks like an unresponsive app rather than an error. Always report it.
  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`[preload] failed to load ${preloadPath}`, error);
  });

  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devServerUrl) {
    forwardRendererLogs(window);
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }

  return window;
}

/**
 * Mirrors renderer console output into the terminal during development.
 *
 * Without this a renderer-side crash is invisible unless DevTools happens to
 * be open — the window just sits there blank.
 */
function forwardRendererLogs(window: BrowserWindow): void {
  window.webContents.on("console-message", ({ level, message, lineNumber, sourceId }) => {
    if (level !== "error" && level !== "warning") return;
    console.error(`[renderer:${level}] ${message} (${sourceId}:${lineNumber})`);
  });
}
