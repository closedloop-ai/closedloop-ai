/**
 * IPC channel for the Engineer gateway transport (M-001).
 *
 * Single source of truth shared by the preload bridge (`preload-common.ts`),
 * the main handler, and its registration in `app.ts`. Keeping it here — a
 * framework-free module with no heavy imports — means a rename can't silently
 * desync the renderer's `ipcRenderer.invoke` from the main `ipcMain.handle`
 * (which would hang every overlay request with no compile-time signal).
 */
export const GATEWAY_DISPATCH_CHANNEL = "desktop:gateway-dispatch";
