import { useEffect, useState } from "react";
import { macStoplightUnderlayEnabled } from "../../platform";

// After the window refocuses, the native stoplights take a beat to redraw. Keep
// the fallback discs up for this long afterwards so they bridge that gap — the
// native buttons paint on top during the overlap, then the discs drop out once
// the real ones are surely present. Otherwise neither is visible for a frame and
// the controls visibly flash.
const REDRAW_BRIDGE_MS = 250;

/**
 * Muted fallback discs for the native macOS stoplight buttons (hidden title
 * bar). Electron hides the custom-positioned native buttons when the window goes
 * inactive (an unresolved quirk — see the `trafficLightPosition` notes in
 * main/window.ts), so they vanish instead of dimming. These gray discs stand in
 * for them while the window is blurred, giving the "still visible but muted"
 * look; while the window is focused the real (colored) buttons are drawn and
 * these are hidden, so there is no risk of a colored edge peeking out.
 *
 * Gated to pre-Tahoe macOS via `macStoplightUnderlayEnabled()`: macOS 26 keeps
 * the dimmed native buttons on blur instead of dropping them, so drawing the
 * discs there double-draws and misaligns (the native buttons live in window
 * points and don't track page zoom/display scaling the discs do).
 *
 * `pointer-events-none` so they never intercept window dragging. macOS only —
 * every other platform keeps its native window frame.
 *
 * The discs approximate the native button metrics (~12px each, 20px
 * center-to-center). Their origin is anchored to `TRAFFIC_LIGHT_POSITION`
 * ({x:19, y:17}) in main/window.ts but is NOT equal to it: the values below
 * (top 19px, left 20px) are that origin plus a small empirical offset (+2px
 * top, +1px left) tuned by eye so the discs sit directly under the buttons as
 * macOS actually draws them — `trafficLightPosition` is the button proxy's
 * frame origin, which lands a hair above/left of the rendered circles. The
 * offset is observational, not derived, so if you move `TRAFFIC_LIGHT_POSITION`
 * re-eyeball these against a real macOS build rather than recomputing them.
 */
export function MacWindowControlsUnderlay() {
  const [visible, setVisible] = useState(
    () => macStoplightUnderlayEnabled() && !document.hasFocus()
  );

  useEffect(() => {
    if (!macStoplightUnderlayEnabled()) {
      return;
    }
    let bridge: ReturnType<typeof setTimeout> | undefined;
    const showNow = () => {
      clearTimeout(bridge);
      setVisible(true);
    };
    const hideAfterRedraw = () => {
      clearTimeout(bridge);
      bridge = setTimeout(() => setVisible(false), REDRAW_BRIDGE_MS);
    };
    window.addEventListener("blur", showNow);
    window.addEventListener("focus", hideAfterRedraw);
    return () => {
      clearTimeout(bridge);
      window.removeEventListener("blur", showNow);
      window.removeEventListener("focus", hideAfterRedraw);
    };
  }, []);

  if (!visible) {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed top-[19px] left-[20px] z-50 flex items-center gap-2"
    >
      <span className="size-3 rounded-full bg-[#c4c4c4]/50" />
      <span className="size-3 rounded-full bg-[#c4c4c4]/50" />
      <span className="size-3 rounded-full bg-[#c4c4c4]/50" />
    </div>
  );
}
