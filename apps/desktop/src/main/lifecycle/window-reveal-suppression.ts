/**
 * ISS-5987: the launch-argument opt-out that keeps a launch's window off screen.
 *
 * Electron has no headless mode — its browser process is not Chromium's
 * `headless_shell`, so every form of `--headless` is accepted and silently
 * ignored (verified against electron@43 / Chromium 150; see ISS-5987 and
 * microsoft/playwright#13288). Do not re-litigate this with a Chromium switch.
 *
 * What does work is never revealing the window in the first place. `DesktopWindow`
 * already CONSTRUCTS the window with `show: false`; the only reason one ever
 * appears is the deliberate ISS-5346 reveal. Playwright's visibility and
 * actionability checks are layout/DOM-based rather than paint-based, so a
 * never-revealed window drives exactly like a revealed one — which is what makes
 * the desktop Electron E2E suite runnable on an operator's Mac without taking
 * over the screen for the length of the run.
 *
 * Deliberately an app-level LAUNCH ARGUMENT rather than an env var: an env var
 * can be inherited into a real user's session, whereas the packaged app never
 * passes this argument. Belt-and-suspenders, a packaged build ignores it outright
 * — the same posture `resolveDevRendererUrl` takes on `--closedloop-renderer-url=`.
 */

/** Suppresses the window reveal for this launch. Unpackaged builds only. */
export const E2E_NO_REVEAL_ARG = "--e2e-no-reveal";

/**
 * True when this launch must keep its window off screen.
 *
 * The reveal GATE still runs and still logs its reason — only the final
 * `BrowserWindow.show()` is skipped — so the ISS-5346 guarantee (never expose a
 * pre-mount shell) is untouched rather than weakened.
 */
export function isWindowRevealSuppressed(
  argv: readonly string[],
  options: { isPackaged: boolean }
): boolean {
  if (options.isPackaged) {
    return false;
  }
  return argv.includes(E2E_NO_REVEAL_ARG);
}

/**
 * ISS-6112: the `webPreferences` overrides an off-screen launch needs, or
 * nothing at all for an ordinary one.
 *
 * A never-revealed window can be a BACKGROUNDED page, and Chromium's default
 * treatment of one is hostile to a test suite: timers are clamped, animations
 * stop, and `document.visibilityState` reports `hidden`. That last part is not
 * academic here — this renderer's own live bridge is visibility-gated, and the
 * FEA-2187 / FEA-3481 / FEA-4157 fallback polls in
 * `sessions-list-poll-defaults.ts` exist precisely because "a CI/offscreen
 * Electron window can report `document.hidden` indefinitely".
 *
 * "Can be", measured rather than assumed: on macOS a suppressed launch reports
 * `visible` and runs timers at the same rate as a revealed one (probed 2026-08-12
 * on the built app — 439 vs 447 `setTimeout(0)` ticks/2s, rAF firing in both), so
 * there this is a no-op. The throttling that ISS-6112 is about is the Linux/xvfb
 * `desktop-e2e` job, where the window is never mapped. Do not restate the clamp
 * as portable Chromium behavior; it is not what this platform does.
 *
 * Electron's `backgroundThrottling: false` is the one switch that covers all
 * three — its documented contract is "whether to throttle animations and timers
 * when the page becomes background. This also affects the Page Visibility API"
 * — so the hidden page keeps running, and reporting, like a visible one.
 *
 * Deliberately gated on the suppression flag rather than set unconditionally:
 * a real user's window SHOULD throttle when they background it. This is a
 * test-harness concession, and it reaches only launches that already carry
 * {@link E2E_NO_REVEAL_ARG}, which a packaged build ignores outright.
 *
 * Ruled out on the way here. `powerSaveBlocker` governs system sleep and app
 * suspension, not per-renderer background throttling, and never touches the
 * Page Visibility API. The `--disable-background-timer-throttling` /
 * `--disable-renderer-backgrounding` Chromium switches are process-global, so
 * they would change behavior for a real user's windows too, and they leave
 * `visibilityState` reporting `hidden` — the visibility-gated half unfixed.
 */
export function windowRevealSuppressedWebPreferences(suppressed: boolean): {
  backgroundThrottling?: false;
} {
  return suppressed ? { backgroundThrottling: false } : {};
}
