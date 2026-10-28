import type { BrowserWindow } from "electron";

export type NativeWindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RendererWindowSessionState = {
  bounds: NativeWindowBounds;
  hash: string;
  maximized: boolean;
  fullScreen: boolean;
};

/** Capture the renderer-owned state needed by the next BrowserWindow. */
export function captureRendererWindowSessionState(
  browserWindow: BrowserWindow
): RendererWindowSessionState {
  return {
    bounds: browserWindow.getNormalBounds(),
    hash: rendererHashFromUrl(browserWindow.webContents.getURL()),
    maximized: browserWindow.isMaximized(),
    fullScreen: browserWindow.isFullScreen(),
  };
}

/** Best-effort capture for a close event whose renderer may already be gone. */
export function tryCaptureRendererWindowSessionState(
  browserWindow: BrowserWindow
): { state: RendererWindowSessionState | null; error: unknown } {
  try {
    return {
      state: captureRendererWindowSessionState(browserWindow),
      error: null,
    };
  } catch (error) {
    return { state: null, error };
  }
}

/** Destroy a native window and report only failures that leave it alive. */
export function tryDestroyRendererWindow(
  browserWindow: BrowserWindow
): unknown {
  try {
    browserWindow.destroy();
    return null;
  } catch (error) {
    return browserWindow.isDestroyed() ? null : error;
  }
}

/** Apply maximize/full-screen once, before the replacement is presented. */
export function applyWindowPresentation(
  browserWindow: BrowserWindow,
  state: RendererWindowSessionState | null
): void {
  if (state?.maximized) {
    browserWindow.maximize();
  }
  if (state?.fullScreen) {
    browserWindow.setFullScreen(true);
  }
}

/** Keep restored bounds fully inside the display Electron selects for them. */
export function clampWindowBounds(
  bounds: NativeWindowBounds,
  workArea: NativeWindowBounds
): NativeWindowBounds {
  const width = Math.min(Math.max(1, bounds.width), workArea.width);
  const height = Math.min(Math.max(1, bounds.height), workArea.height);
  const maxX = workArea.x + workArea.width - width;
  const maxY = workArea.y + workArea.height - height;

  return {
    x: Math.min(Math.max(bounds.x, workArea.x), maxX),
    y: Math.min(Math.max(bounds.y, workArea.y), maxY),
    width,
    height,
  };
}

/** Apply a preserved renderer hash without changing the selected asset origin. */
export function rendererUrlWithHash(url: string, hash: string): string {
  const parsed = new URL(url);
  parsed.hash = hash;
  return parsed.href;
}

/** Convert the renderer's org-relative navigation payload into its URL hash. */
export function rendererRouteHash(route: string): string {
  const normalized = route.startsWith("/") ? route : `/${route}`;
  return `#${normalized}`;
}

/** Choose one routing mechanism so recreation never pushes a duplicate href. */
export function rendererRouteOpenDecision(
  hasLiveWindow: boolean,
  route: string
): { initialHash: string | null; queuedRoute: string | null } {
  return hasLiveWindow
    ? { initialHash: null, queuedRoute: route }
    : { initialHash: rendererRouteHash(route), queuedRoute: null };
}

/** Read a valid route hash from the retiring renderer URL. */
export function rendererHashFromUrl(url: string): string {
  try {
    return new URL(url).hash;
  } catch {
    return "";
  }
}
