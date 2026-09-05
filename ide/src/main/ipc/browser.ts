import type { BrowserPane } from "../services/browser-pane.js";
import { handle } from "./typed-handle.js";

export function registerBrowserHandlers(pane: BrowserPane): void {
  handle("browser:open", ({ url, bounds }) => pane.open(url, bounds));
  handle("browser:set-bounds", (bounds) => pane.setBounds(bounds));
  handle("browser:go-back", () => pane.goBack());
  handle("browser:go-forward", () => pane.goForward());
  handle("browser:reload", () => pane.reload());
  handle("browser:close", () => pane.close());
  handle("browser:open-external", (url) => pane.openExternal(url));
}
