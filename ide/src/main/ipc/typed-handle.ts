import { ipcMain, type IpcMainInvokeEvent } from "electron";

import type { IpcChannel, IpcRequest, IpcResponse } from "@shared/ipc.js";

/**
 * `ipcMain.handle` narrowed to the shared contract.
 *
 * Using this instead of the raw API means a channel name that is not in
 * `IpcContract`, or a handler whose argument or return type disagrees with it,
 * fails to compile. Handlers are registered once at startup; re-registering a
 * channel throws in Electron, so `registerIpcHandlers` must not run twice.
 */
export function handle<C extends IpcChannel>(
  channel: C,
  handler: (request: IpcRequest<C>, event: IpcMainInvokeEvent) => IpcResponse<C> | Promise<IpcResponse<C>>,
): void {
  ipcMain.handle(channel, (event, request) => handler(request as IpcRequest<C>, event));
}
