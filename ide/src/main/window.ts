import { join } from "node:path";

import { BrowserWindow } from "electron";

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
    backgroundColor: "#090909",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });

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
