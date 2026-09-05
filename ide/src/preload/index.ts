import { contextBridge, ipcRenderer } from "electron";

import type { WorkbenchApi } from "@shared/api.js";
import {
  MAIN_EVENT_CHANNEL,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
  type MainEvent,
} from "@shared/ipc.js";

/**
 * The renderer's only route to the main process.
 *
 * Deliberately a hand-written, narrow surface rather than a generic `invoke`
 * passthrough: the renderer cannot name a channel that is not offered here, so
 * adding a capability is always an explicit decision in this file.
 *
 * `ipcRenderer` itself is never exposed. In particular `ipcRenderer.on` is not
 * forwarded, because its first callback argument is an `IpcRendererEvent`
 * carrying a `sender` handle — leaking that would hand page scripts a way back
 * into the main process.
 */

function invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>> {
  return ipcRenderer.invoke(channel, request) as Promise<IpcResponse<C>>;
}

const api: WorkbenchApi = {
  chat: {
    list: () => invoke("chat:list", undefined),
    create: () => invoke("chat:create", undefined),
    get: (chatId) => invoke("chat:get", chatId),
    rename: (chatId, title) => invoke("chat:rename", { chatId, title }),
    remove: (chatId) => invoke("chat:delete", chatId),
    send: (chatId, prompt, attachments) =>
      invoke("chat:send", attachments ? { chatId, prompt, attachments } : { chatId, prompt }),
    cancel: (chatId) => invoke("chat:cancel", chatId),
  },

  preview: {
    capabilities: () => invoke("preview:capabilities", undefined),
  },

  documents: {
    pick: () => invoke("document:pick", undefined),
    read: (documentId) => invoke("document:read", documentId),
    readSpreadsheet: (documentId) => invoke("document:read-spreadsheet", documentId),
  },

  browser: {
    open: (url, bounds) => invoke("browser:open", { url, bounds }),
    setBounds: (bounds) => invoke("browser:set-bounds", bounds),
    goBack: () => invoke("browser:go-back", undefined),
    goForward: () => invoke("browser:go-forward", undefined),
    reload: () => invoke("browser:reload", undefined),
    close: () => invoke("browser:close", undefined),
    openExternal: (url) => invoke("browser:open-external", url),
  },

  onEvent: (listener: (event: MainEvent) => void): (() => void) => {
    const handler = (_event: unknown, payload: MainEvent): void => listener(payload);
    ipcRenderer.on(MAIN_EVENT_CHANNEL, handler);
    return () => {
      ipcRenderer.off(MAIN_EVENT_CHANNEL, handler);
    };
  },
};

contextBridge.exposeInMainWorld("workbench", api);
