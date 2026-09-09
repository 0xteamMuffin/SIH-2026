import { BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";

import { resetZoom, stepZoom } from "./zoom.js";

/**
 * The application menu.
 *
 * On Windows and Linux there is no menu at all. The shell draws its own title
 * bar with the workspace switcher, panel toggles, and a command palette, so a
 * native File/Edit/View bar sitting above that is both redundant and the
 * clearest possible tell that this is an Electron window wearing a costume.
 * Chromium still handles clipboard and text-editing shortcuts inside editable
 * fields without menu roles, and zoom is handled in `zoom.ts`.
 *
 * macOS is different: the menu bar belongs to the OS rather than to the
 * window, and without one the standard Cmd+Q/Cmd+C/Cmd+V bindings are simply
 * absent. So there it gets a real, minimal menu.
 */
export function installApplicationMenu(): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(macTemplate()));
}

function macTemplate(): MenuItemConstructorOptions[] {
  return [
    { role: "appMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        // Explicit click handlers rather than the `zoomIn`/`zoomOut` roles, so
        // the menu and the keyboard path in `zoom.ts` share one clamped
        // implementation and cannot drift into different step sizes.
        {
          label: "Zoom In",
          accelerator: "Command+Plus",
          click: () => withFocusedWindow((window) => stepZoom(window.webContents, 1)),
        },
        {
          label: "Zoom Out",
          accelerator: "Command+-",
          click: () => withFocusedWindow((window) => stepZoom(window.webContents, -1)),
        },
        {
          label: "Actual Size",
          accelerator: "Command+0",
          click: () => withFocusedWindow((window) => resetZoom(window.webContents)),
        },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
}

function withFocusedWindow(action: (window: BrowserWindow) => void): void {
  const window = BrowserWindow.getFocusedWindow();
  if (window) action(window);
}
