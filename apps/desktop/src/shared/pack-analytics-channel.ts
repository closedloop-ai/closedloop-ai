/**
 * IPC channel for the desktop-team pack-analytics bridge. Single-sourced so the
 * main-process handler and the preload `ipcRenderer.invoke` can never drift.
 */
export const PACK_ANALYTICS_IPC_CHANNEL = "desktop:pack:get-analytics";
