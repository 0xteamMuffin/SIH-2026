import { app, session, shell, type WebContents } from "electron";

import { evaluateUrl } from "./services/url-policy.js";

/**
 * Baseline hardening for the application's own windows.
 *
 * This is separate from the embedded browser's hardening (see
 * `services/browser-pane.ts`): the pane deliberately loads untrusted content
 * under a deny-everything policy, whereas these rules protect the app shell
 * itself from being navigated somewhere it should never go.
 */
export function applySecurityPolicy(): void {
  denyDefaultSessionPermissions();

  app.on("web-contents-created", (_event, contents) => {
    // Guest views (the embedded browser) install their own, more permissive
    // navigation rules. Applying the app-shell rules to them too would fight
    // those and block every legitimate page load.
    if (contents.getType() !== "window") {
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      return;
    }
    hardenAppWindow(contents);
  });
}

/**
 * The app shell has no need for camera, microphone, geolocation, or
 * notifications. Denying by default means adding one later is a deliberate,
 * reviewable change rather than an inherited default.
 *
 * Both hooks are installed because most web APIs perform a permission *check*
 * first and only issue a *request* if that check fails.
 */
function denyDefaultSessionPermissions(): void {
  const defaultSession = session.defaultSession;
  defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  defaultSession.setPermissionCheckHandler(() => false);
  defaultSession.setDevicePermissionHandler(() => false);
  defaultSession.setDisplayMediaRequestHandler(null);
}

function hardenAppWindow(contents: WebContents): void {
  // The shell never opens popups. A link to a real site is handed to the
  // user's browser instead, which keeps remote pages out of a window that has
  // our preload bridge attached.
  contents.setWindowOpenHandler(({ url }) => {
    if (evaluateUrl(url).allowed) {
      setImmediate(() => void shell.openExternal(url));
    }
    return { action: "deny" };
  });

  // The shell is a local document and must never navigate itself elsewhere;
  // a stray link should not be able to replace the UI with a remote page.
  const blockOffAppNavigation = (event: { preventDefault: () => void; url: string }): void => {
    if (isAppUrl(event.url)) return;
    event.preventDefault();
    if (evaluateUrl(event.url).allowed) {
      void shell.openExternal(event.url);
    }
  };
  contents.on("will-navigate", blockOffAppNavigation);
  contents.on("will-frame-navigate", blockOffAppNavigation);

  // Nothing in the shell should ever request an elevated web permission.
  contents.on("select-bluetooth-device", (event) => event.preventDefault());
}

/**
 * True for URLs that are the app's own UI: a bundled `file://` document in
 * production, or the dev server that electron-vite points us at.
 */
function isAppUrl(candidate: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }

  if (url.protocol === "file:") return true;

  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
  if (!devServerUrl) return false;

  try {
    return url.origin === new URL(devServerUrl).origin;
  } catch {
    return false;
  }
}
