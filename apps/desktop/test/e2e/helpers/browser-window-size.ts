import type { ElectronApplication, Page } from "@playwright/test";
import { expect } from "@playwright/test";

/** Resizes the real Electron content viewport and verifies the main-process result. */
export async function setBrowserWindowContentSize(
  app: ElectronApplication,
  size: { height: number; width: number }
): Promise<void> {
  const actual = await app.evaluate(({ BrowserWindow }, nextSize) => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) {
      return null;
    }
    window.setContentSize(nextSize.width, nextSize.height);
    const [width, height] = window.getContentSize();
    return { height, width };
  }, size);
  expect(actual, "no BrowserWindow was open to resize").toEqual(size);
}

/** Returns the renderer viewport width after a BrowserWindow content resize. */
export function browserViewportWidth(page: Page): Promise<number> {
  return page.evaluate(() => globalThis.innerWidth);
}

/** Applies Chromium's real page zoom through Electron's owning WebContents. */
export async function setBrowserWindowZoomFactor(
  app: ElectronApplication,
  zoomFactor: number
): Promise<void> {
  const actual = await app.evaluate(({ BrowserWindow }, nextZoomFactor) => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) {
      return null;
    }
    window.webContents.setZoomFactor(nextZoomFactor);
    return window.webContents.getZoomFactor();
  }, zoomFactor);
  if (actual === null) {
    throw new Error("No BrowserWindow was open to zoom");
  }
  expect(actual).toBeCloseTo(zoomFactor, 10);
}
