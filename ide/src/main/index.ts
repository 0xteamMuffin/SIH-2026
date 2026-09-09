import { app, BrowserWindow } from "electron";

import { EventBroadcaster } from "./events.js";
import { registerIpcHandlers } from "./ipc/index.js";
import { installApplicationMenu } from "./menu.js";
import { applySecurityPolicy } from "./security.js";
import { BrowserPane } from "./services/browser-pane.js";
import { ChatService } from "./services/chat-service.js";
import { ChatStore } from "./services/chat-store.js";
import { DocumentLibrary } from "./services/document-library.js";
import { BackendAgentGateway } from "./services/backend-agent.js";
import { SessionManager } from "./services/session.js";
import { createMainWindow } from "./window.js";

/**
 * Application entry point.
 *
 * Composition happens here and nowhere else: services are constructed once,
 * wired together explicitly, and handed to the IPC layer. Nothing below this
 * file reaches for a global, which is what keeps the services testable in
 * isolation.
 */

// A second instance would contend for the same chat history file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const events = new EventBroadcaster();
const browserPane = new BrowserPane(events);
const documents = new DocumentLibrary();
const session = new SessionManager(events);
let chats: ChatService | null = null;
let store: ChatStore | null = null;

app.whenReady().then(main).catch((error: unknown) => {
  console.error("[main] failed to start", error);
  app.quit();
});

async function main(): Promise<void> {
  applySecurityPolicy();
  installApplicationMenu();

  store = await ChatStore.open(app.getPath("userData"));
  chats = new ChatService(store, new BackendAgentGateway({ session, documents }), events);

  openWindow();
  registerIpcHandlers({ chats, documents, session, browserPane });

  app.on("second-instance", () => focusExistingWindow());

  // macOS keeps the app alive with no windows; recreate on dock activation.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow();
  });
}

function openWindow(): void {
  const window = createMainWindow();
  events.setTarget(window.webContents);
  browserPane.attach(window);
}

function focusExistingWindow(): void {
  const [window] = BrowserWindow.getAllWindows();
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.focus();
}

// Standard platform convention: quitting on last window closed everywhere
// except macOS.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Give in-flight work a chance to stop and history a chance to land on disk.
app.on("before-quit", () => {
  chats?.cancelAll();
  browserPane.close();
  void store?.flush();
});
