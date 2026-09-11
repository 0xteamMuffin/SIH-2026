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
    send: (chatId, prompt, attachments, classification) =>
      invoke("chat:send", {
        chatId,
        prompt,
        ...(attachments ? { attachments } : {}),
        ...(classification ? { classification } : {}),
      }),
    cancel: (chatId) => invoke("chat:cancel", chatId),
  },

  session: {
    state: () => invoke("session:state", undefined),
    connect: (baseUrl, email, password) => invoke("session:connect", { baseUrl, email, password }),
    disconnect: () => invoke("session:disconnect", undefined),
    selectWorkspace: (workspaceId) => invoke("session:select-workspace", workspaceId),
  },

  approvals: {
    decide: (approvalId, decision) => invoke("approval:decide", { approvalId, decision }),
  },

  preview: {
    capabilities: () => invoke("preview:capabilities", undefined),
  },

  documents: {
    pick: () => invoke("document:pick", undefined),
    read: (document) => invoke("document:read", document),
    readSpreadsheet: (document) => invoke("document:read-spreadsheet", document),
    save: (document, filename) => invoke("document:save", { ...document, filename }),
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

  sovereignty: {
    posture: () => invoke("sovereignty:posture", undefined),
    egress: (options = {}) => invoke("sovereignty:egress", options),
    probe: (workspaceId) =>
      invoke("sovereignty:probe", workspaceId ? { workspaceId } : {}),
  },

  admin: {
    modelProviders: () => invoke("admin:model-providers", undefined),
    users: () => invoke("admin:users", undefined),
    createUser: (email, password, role) => invoke("admin:create-user", { email, password, role }),
    disableUser: (userId) => invoke("admin:disable-user", userId),
    createWorkspace: (name) => invoke("admin:create-workspace", name),
    workspaceMembers: (workspaceId) => invoke("admin:workspace-members", workspaceId),
    addMember: (workspaceId, userId, role) =>
      invoke("admin:add-member", { workspaceId, userId, role }),
    updateMemberRole: (workspaceId, userId, role) =>
      invoke("admin:update-member-role", { workspaceId, userId, role }),
    removeMember: (workspaceId, userId) => invoke("admin:remove-member", { workspaceId, userId }),
  },

  audit: {
    list: (query) => invoke("audit:list", query),
    export: (workspaceId, format, filters = {}) =>
      invoke("audit:export", { workspaceId, format, filters }),
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
