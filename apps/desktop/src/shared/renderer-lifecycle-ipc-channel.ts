/**
 * Renderer lifecycle signals (fire-and-forget `ipcMain.on`, not request/response):
 * the renderer announcing it is ready, going idle on the live DB, or receiving
 * user input. These drive main-process window/DB-ready glue rather than returning
 * data, so they live apart from the `desktop:*` `.handle` data domains.
 */
export const RendererLifecycleIpcChannel = {
  RendererReady: "desktop:renderer-ready",
  RendererLiveDbIdle: "desktop:renderer-live-db-idle",
  RendererUserInput: "desktop:renderer-user-input",
} as const;

export type RendererLifecycleIpcChannel =
  (typeof RendererLifecycleIpcChannel)[keyof typeof RendererLifecycleIpcChannel];
