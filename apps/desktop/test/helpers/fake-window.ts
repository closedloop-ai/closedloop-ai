import type { BrowserWindow } from "electron";

export type SendCall = { channel: string; args: unknown[] };

export function fakeWindow(opts: {
  windowDestroyed?: boolean;
  contentsDestroyed?: boolean;
  frameDestroyed?: boolean;
  webContentsThrows?: Error;
  throwOnSend?: Error;
  calls?: SendCall[];
}): BrowserWindow {
  const window: Record<string, unknown> = {
    isDestroyed: () => opts.windowDestroyed === true,
  };
  if (opts.webContentsThrows) {
    Object.defineProperty(window, "webContents", {
      get() {
        throw opts.webContentsThrows;
      },
    });
  } else {
    window.webContents = {
      isDestroyed: () => opts.contentsDestroyed === true,
      mainFrame: { isDestroyed: () => opts.frameDestroyed === true },
      send: (channel: string, ...args: unknown[]) => {
        if (opts.throwOnSend) {
          throw opts.throwOnSend;
        }
        opts.calls?.push({ channel, args });
      },
    };
  }
  return window as unknown as BrowserWindow;
}
