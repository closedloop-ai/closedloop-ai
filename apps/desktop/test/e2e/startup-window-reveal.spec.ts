/**
 * ISS-5346 regression, through the LAUNCHED app.
 *
 * The bug: the initial `BrowserWindow` was revealed on the bare
 * `desktop:renderer-ready` IPC, which `renderer-ready-signal.ts` sends from a
 * module script in `index.html` — BEFORE the React entry mounts. The user got a
 * window containing a painted-but-dead shell.
 *
 * The unit suites cover the gate and the IPC chain in isolation. Nothing there
 * reaches the real window: a break in preload wiring, in phase delivery over the
 * actual IPC bridge, or in `DesktopWindow`'s own reveal path leaves them green.
 * So this spec asserts against the launched app.
 *
 * The load-bearing assertion is the REASON, not a timing observation. Every
 * reveal logs `Desktop window visible reason=<reason>` exactly once, and the
 * reason names which path revealed the window:
 *
 *   - `renderer-ready`  — the pre-ISS-5346 reveal (fires on the painted shell).
 *   - `app-mounted`     — the fix: held until React committed its first render.
 *   - `mount-fail-open` — the bounded escape hatch; also what a reveal gated on
 *                         a signal that is DOWNSTREAM of the reveal would
 *                         produce on every boot.
 *   - `mount-wait-failed` — the wait threw.
 *
 * Asserting `app-mounted` therefore fails on the original bug AND on a
 * circularly-gated "fix", with no dependence on wall-clock ordering.
 */

import fs from "node:fs";
import path from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktop-app.js";

const LOG_WAIT_TIMEOUT_MS = 30_000;
const REVEAL_LINE_RE = /Desktop window visible reason=([a-z-]+)/g;
/** The pre-mount React signal, logged by the gates when the mount lands. */
const MOUNT_SIGNAL_LINE = "Renderer app mounted";
/** The healthy reason: the reveal waited for React to commit its first render. */
const REVEAL_REASON_APP_MOUNTED = "app-mounted";

function readFileOrEmpty(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

/** Every reveal reason recorded in the launched profile's durable log. */
function revealReasons(logPath: string): string[] {
  const contents = readFileOrEmpty(logPath);
  return [...contents.matchAll(REVEAL_LINE_RE)].map((match) => match[1] ?? "");
}

/**
 * What the OS window is actually doing.
 *
 * `present`/`destroyed` are carried alongside `visible` on purpose: "not
 * visible" is also what a torn-down or never-created window reports, so a bare
 * `isVisible() === false` would pass on a launch that had no window left to
 * suppress. Asserting a LIVE window is what makes the negative mean something.
 */
type WindowState = {
  present: boolean;
  destroyed: boolean;
  visible: boolean;
  /**
   * ISS-6112. Read back off the LIVE `webContents`, not off the config object
   * we passed in (wongk, PR #4920): the unit tests prove `window.ts` spreads
   * `backgroundThrottling: false` into `webPreferences`, and stay green if
   * Electron ignores the key or resolves it differently. Only the running
   * window can say whether the setting took.
   */
  backgroundThrottling: boolean | null;
  /**
   * ISS-6112 (wongk, PR #4920). The RENDERER's own view of whether it is
   * visible, read through `executeJavaScript` because `document` does not
   * exist in the main process. `null` when there is no live window to ask, or
   * when the renderer is not far enough along to answer — distinguished from a
   * real value so a failed read cannot masquerade as one.
   */
  visibilityState: string | null;
};

function readWindowState(app: ElectronApplication): Promise<WindowState> {
  return app.evaluate(({ BrowserWindow }) => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) {
      return {
        present: false,
        destroyed: true,
        visible: false,
        backgroundThrottling: null,
        visibilityState: null,
      };
    }
    const destroyed = window.isDestroyed();
    if (destroyed) {
      return {
        present: true,
        destroyed,
        visible: false,
        backgroundThrottling: null,
        visibilityState: null,
      };
    }
    return window.webContents
      .executeJavaScript("document.visibilityState")
      .catch(() => null)
      .then((visibilityState: unknown) => ({
        present: true,
        destroyed,
        visible: window.isVisible(),
        backgroundThrottling: window.webContents.backgroundThrottling,
        visibilityState:
          typeof visibilityState === "string" ? visibilityState : null,
      }));
  });
}

/**
 * Drives the POST-reveal show path, through production code.
 *
 * `DesktopWindow.show()` is the other caller of `presentWindow` — a macOS dock
 * click, a notification click, a tray "Open". `startup.ts` routes the `activate`
 * event through `handleActivateEvent` → `DesktopApplication.handleActivate()` →
 * `showWindow(AppActivated)` → `DesktopWindow.show()`, and once the initial
 * reveal has landed `InitialWindowRevealGate.requestShow` runs every intent
 * straight through. Emitting the event is therefore the real path, not a poke at
 * `BrowserWindow`.
 *
 * Synchronous all the way to `presentWindow`: `handleActivate` calls
 * `showWindow` before its first `await`, so when this resolves the show has
 * already been decided and the state below needs no settling wait.
 */
function emitAppActivate(app: ElectronApplication): Promise<void> {
  return app.evaluate(({ app: electronApp }) => {
    electronApp.emit("activate");
  });
}

test("the initial window is revealed only after the renderer app mounts", async () => {
  const launched = await launchDesktopApp({
    userDataPrefix: "desktop-window-reveal-",
    // ISS-5987: the ONE spec that opts back into a real on-screen window. Every
    // other launch in the suite now runs off screen; this spec's subject IS the
    // reveal, so it has to watch the shipped `BrowserWindow.show()` happen.
    revealWindow: true,
  });
  const { app, page, userDataDir, cleanup } = launched;

  try {
    const logPath = path.join(userDataDir, "logs", "main.log");

    // The renderer really rendered — not just `index.html`. `#root` is empty in
    // the static shell and only gains children once React commits.
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.getElementById("root")?.childElementCount ?? 0
          ),
        {
          timeout: LOG_WAIT_TIMEOUT_MS,
          message: "expected the React entry to mount into #root",
        }
      )
      .toBeGreaterThan(0);

    // The main process observed the MOUNTED phase of `desktop:renderer-ready`.
    // Without preload/renderer/IPC phase delivery working end to end this line
    // never appears, and the reveal below could only be a fail-open.
    await expect
      .poll(() => readFileOrEmpty(logPath), {
        timeout: LOG_WAIT_TIMEOUT_MS,
        message: `expected the renderer-mount signal in ${logPath}`,
      })
      .toContain(MOUNT_SIGNAL_LINE);

    await expect
      .poll(() => revealReasons(logPath), {
        timeout: LOG_WAIT_TIMEOUT_MS,
        message: `expected a reveal line in ${logPath}`,
      })
      .not.toEqual([]);

    const reasons = revealReasons(logPath);
    // The regression assertion. `renderer-ready` is the original bug;
    // `mount-fail-open` is what a reveal gated on a post-reveal signal degrades
    // to on every boot. Only the gated path is acceptable here.
    expect(
      reasons,
      "the window was revealed by the renderer-mount gate"
    ).toEqual([REVEAL_REASON_APP_MOUNTED]);

    // And it is actually on screen — a gate that never releases would be a
    // worse bug than the early reveal it replaced.
    const revealed = await readWindowState(app);
    expect(revealed.visible, "the revealed window is visible").toBe(true);

    // POSITIVE CONTROL for the suppressed test below, which asserts that the
    // same drive leaves the window off screen. "Stayed hidden" is worthless
    // unless this exact query, driven this exact way, can be seen to put a
    // window ON screen — so hide it and drive the activate for real. If
    // `emitAppActivate` ever stops reaching `presentWindow`, this fails here
    // rather than silently making the negative assertion vacuous.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.hide();
    });
    expect(
      (await readWindowState(app)).visible,
      "the window is hidden before the post-reveal show"
    ).toBe(false);

    await emitAppActivate(app);

    const reshown = await readWindowState(app);
    expect(
      reshown.visible,
      "a post-reveal show puts an unsuppressed window back on screen"
    ).toBe(true);
  } finally {
    await cleanup();
  }
});

test("a suppressed launch runs the same reveal sequence with the window off screen", async () => {
  // ISS-5987: the default for every other spec in this suite, asserted once
  // here. The pair matters more than either half — the test above proves the
  // shipped launch still puts a window on screen, this one proves the harness
  // default reaches the SAME reveal decision (`app-mounted`, once) and only
  // skips the final `show()`. A suppression that short-circuited the gate would
  // pass an `isVisible() === false` check while quietly retiring the ISS-5346
  // guarantee, so the reason assertion is what makes this test worth having.
  const launched = await launchDesktopApp({
    userDataPrefix: "desktop-window-no-reveal-",
  });
  const { app, page, userDataDir, cleanup } = launched;

  try {
    const logPath = path.join(userDataDir, "logs", "main.log");

    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.getElementById("root")?.childElementCount ?? 0
          ),
        {
          timeout: LOG_WAIT_TIMEOUT_MS,
          message: "expected the React entry to mount into #root",
        }
      )
      .toBeGreaterThan(0);

    await expect
      .poll(() => revealReasons(logPath), {
        timeout: LOG_WAIT_TIMEOUT_MS,
        message: `expected a reveal line in ${logPath}`,
      })
      .toEqual([REVEAL_REASON_APP_MOUNTED]);

    const afterReveal = await readWindowState(app);
    expect(
      afterReveal.visible,
      "the suppressed window never reached the screen"
    ).toBe(false);

    // ISS-6112, and the reason this assertion is HERE rather than in a unit
    // test (wongk, PR #4920): a never-shown window is exactly the state
    // Chromium throttles, and the suppressed launch is the only place in the
    // suite that reaches it. Asserting the live value closes the gap the unit
    // tests cannot — they pin what `window.ts` passes, and would stay green if
    // Electron ignored the key or resolved it differently.
    expect(
      afterReveal.backgroundThrottling,
      "the suppressed window's renderer must stay unthrottled while hidden"
    ).toBe(false);

    // ISS-6112 (wongk, PR #4920). MEASURED on desktop-e2e run 31699649713
    // (ubuntu-latest), not assumed — and the measurement overturned the obvious
    // reading, which is why it is asserted rather than argued.
    //
    // The suppression never calls `show()`, so `isVisible()` is `false` two
    // assertions up and this "should" read "hidden". It does NOT: X11 reports
    // the renderer's document as VISIBLE for a window the window manager never
    // mapped. The two signals genuinely disagree here.
    //
    // That disagreement is the reason the `backgroundThrottling` assertion above
    // is the load-bearing one and this is its companion: a renderer that
    // believes it is visible cannot be relied on to reveal throttling, so the
    // live `webContents.backgroundThrottling` read is what actually pins the
    // contract. This line pins the platform behaviour the suite runs on, so a
    // future reader who reasons "never shown, therefore hidden" — as this PR
    // first did — is corrected by a failing test rather than by a comment.
    expect(
      afterReveal.visibilityState,
      "X11 reports an unmapped window's document as visible; see run 31699649713"
    ).toBe("visible");

    // The initial reveal is not the only way onto the screen. `presentWindow` is
    // also the terminus of `DesktopWindow.show()`, which a dock activate or a
    // notification click reaches long AFTER the reveal — and post-reveal the
    // gate passes every intent straight through, so nothing upstream would stop
    // it. Suppressing only the initial reveal would leave this test green while
    // a window appeared mid-run, which is the whole failure ISS-5987 exists to
    // prevent. The pairing test above proves this same drive does put an
    // unsuppressed window back on screen.
    await emitAppActivate(app);

    const afterActivate = await readWindowState(app);
    expect(
      afterActivate.present && !afterActivate.destroyed,
      "the window still exists to be suppressed"
    ).toBe(true);
    expect(
      afterActivate.visible,
      "a post-reveal show left the suppressed window off screen"
    ).toBe(false);
  } finally {
    await cleanup();
  }
});
