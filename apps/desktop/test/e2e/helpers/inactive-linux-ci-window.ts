import type { JSHandle } from "@playwright/test";
import type { BrowserWindow } from "electron";

type InactiveMappingWindow = Pick<
  BrowserWindow,
  | "getBounds"
  | "isDestroyed"
  | "isFocused"
  | "isModal"
  | "isVisible"
  | "showInactive"
> & {
  webContents: Pick<BrowserWindow["webContents"], "backgroundThrottling">;
};

/**
 * Explicit opt-in for genuine UI subjects in the owned Linux CI Xvfb display.
 * CI/DISPLAY identify the existing launch contract, not display ownership proof;
 * the executor must also attest that the display and descendants are contained.
 * Default, Mac, reveal, focus and hidden-window subjects do not opt in.
 */
export async function mapInactiveLinuxCiWindow<TPage>(
  app: {
    browserWindow(page: TPage): Promise<InactiveMappingHandle>;
  },
  page: TPage,
  enabled = false,
  context: InactiveLinuxCiContext = {
    platform: process.platform,
    env: process.env,
  }
): Promise<void> {
  if (!enabled) {
    return;
  }
  if (
    context.platform !== "linux" ||
    context.env.CI !== "true" ||
    !context.env.DISPLAY ||
    context.env.WAYLAND_DISPLAY
  ) {
    throw new Error("Inactive mapping requires the owned Linux CI Xvfb path");
  }
  const window = await app.browserWindow(page);
  try {
    await window.evaluate(mapInactiveWindow);
  } finally {
    await window.dispose();
  }
}

/** Serializable Electron callback shared with focused behavioral coverage. */
export function mapInactiveWindow(window: InactiveMappingWindow): void {
  if (
    window.isDestroyed() ||
    window.isModal() ||
    window.isVisible() ||
    window.isFocused() ||
    window.webContents.backgroundThrottling !== false
  ) {
    throw new Error("Inactive mapping requires a live hidden unfocused window");
  }
  const before = window.getBounds();
  window.showInactive();
  const after = window.getBounds();
  if (
    !window.isVisible() ||
    window.isFocused() ||
    window.isModal() ||
    window.webContents.backgroundThrottling !== false ||
    before.x !== after.x ||
    before.y !== after.y ||
    before.width !== after.width ||
    before.height !== after.height
  ) {
    throw new Error("Inactive mapping changed focus, bounds or window policy");
  }
}

/** Runtime inputs are injectable so guard tests never mutate the host process. */
export type InactiveLinuxCiContext = Readonly<{
  platform: NodeJS.Platform;
  env: Partial<
    Pick<NodeJS.ProcessEnv, "CI" | "DISPLAY" | "WAYLAND_DISPLAY" | "PWDEBUG">
  >;
}>;

type InactiveMappingHandle = Pick<JSHandle<BrowserWindow>, "dispose"> & {
  evaluate(callback: typeof mapInactiveWindow): Promise<void>;
};

/**
 * Preserve the caller's opt-in selection; DISPLAY/WAYLAND validation remains in
 * the mapping wrapper, and neither predicate establishes display ownership.
 */
export function selectInactiveLinuxCiMapping(
  context: InactiveLinuxCiContext,
  requested = false
): boolean {
  return (
    requested &&
    context.platform === "linux" &&
    context.env.CI === "true" &&
    !context.env.PWDEBUG
  );
}
