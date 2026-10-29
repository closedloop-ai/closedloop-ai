import path from "node:path";
import { BrowserWindow, nativeImage } from "electron";
import {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
} from "../../shared/window-defaults.js";
import { resolveResourcesDir } from "../resources-dir.js";
import type { NativeWindowBounds } from "./renderer-window-session-state.js";
import { windowRevealSuppressedWebPreferences } from "./window-reveal-suppression.js";

// macOS stoplight position for the hidden title bar. y is tuned to the inset
// shell (renderer globals.css) so the buttons line up with the Topbar; bump it
// together with the inset/Topbar height if either changes.
const TRAFFIC_LIGHT_POSITION = { x: 19, y: 17 };
// The native window background painted before the renderer document paints. It
// matches the renderer's light splash palette and avoids a dark startup frame.
const INITIAL_WINDOW_BACKGROUND_COLOR = "#fbfbfb";
// Re-asserted after load because the renderer HTML title replaces this option.
export const GOLDEN_WINDOW_TITLE = "Closedloop — GOLDEN";

/** Construct one hidden renderer generation with native platform chrome. */
export function createDesktopBrowserWindow(options: {
  bounds: NativeWindowBounds | null;
  golden: boolean;
  preloadPath: string;
  revealSuppressed: boolean;
}): BrowserWindow {
  return new BrowserWindow({
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    ...(options.bounds ?? {}),
    show: false,
    backgroundColor: INITIAL_WINDOW_BACKGROUND_COLOR,
    ...(options.golden ? { title: GOLDEN_WINDOW_TITLE } : {}),
    // macOS: drop the native title bar/title text so the renderer fills to the
    // top of the window, but keep the stoplight buttons. Other platforms keep
    // their native frame so window controls are never lost.
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hidden" as const,
          trafficLightPosition: TRAFFIC_LIGHT_POSITION,
        }
      : {
          icon: nativeImage.createFromPath(
            path.join(resolveResourcesDir(), "icon-1024.png")
          ),
        }),
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      preload: options.preloadPath,
      additionalArguments: ["--closedloop-agent-dashboard-design-system"],
      // ISS-6112: an off-screen e2e launch keeps its renderer unthrottled and
      // reporting `visible`. Empty for every other launch, so a real user's
      // window still throttles when they background it.
      ...windowRevealSuppressedWebPreferences(options.revealSuppressed),
    },
  });
}
