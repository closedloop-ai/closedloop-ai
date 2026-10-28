/**
 * ISS-6875 — make a desktop-e2e launch death attributable to the HARNESS
 * instead of to whichever spec happened to be running when it happened.
 *
 * `electron.launch: Process failed to launch` is the largest single family in
 * the flake-quarantine intake (17 entries). Quarantine cannot cover it: the app
 * never came up, so nothing the spec was there to assert got asserted, and every
 * spec in the run is equally exposed — it enters the set spec by spec, as each
 * one takes its turn being the one that died. What another retry cannot supply,
 * and what this module does, is say "not the spec" in the failure itself — for
 * the person reading the run. Acting on that downstream is ISS-6931, below.
 *
 * The emitted message is CONSTANT apart from Playwright's own text. That is
 * load-bearing, not incidental: the 17 entries collapsed onto one string in the
 * first place, and interpolating anything per-run (a `mkdtemp` user-data dir,
 * a timestamp) would split one family into N one-off ones for any consumer that
 * fingerprints the message.
 *
 * That is all this module does, and the restraint is deliberate. Two richer
 * fixes were built and then rejected against `playwright-core@1.60`'s source:
 *
 *   - RE-SPAWNING the failed launch to recover its stderr. Playwright discards
 *     the child's output (`server/electron/electron.ts` → `waitForLine` reads
 *     stderr for the DevTools line and drops every line on `close`/`exit`), so
 *     the only way to get it is a second, different launch — different in ways
 *     that decide the outcome. Playwright prepends `--inspect=0
 *     --remote-debugging-port=0`, unshifts `--no-sandbox` on Linux when
 *     `chromiumSandbox` is falsy (neither launcher sets it), and does
 *     `delete env.NODE_OPTIONS`. A bare re-spawn on the ubuntu runner this suite
 *     actually runs on therefore aborts in Electron's SUID sandbox and reports
 *     THAT as the cause of every launch failure. A diagnostic that names the
 *     wrong cause is worse than one that names none. Recovering the real stderr
 *     wants Electron's own `--enable-logging=file --log-file=`, on the launch
 *     that actually failed.
 *   - RETRYING the launch here. `playwright.config.ts` already sets
 *     `retries: process.env.CI ? 1 : 0`. A second layer inside the launcher
 *     multiplies with that rather than adding to it, on a suite whose wall clock
 *     is a tracked problem.
 *
 * So: no second process, no second attempt, no new failure modes — the original
 * rejection is preserved as `cause` (Playwright hangs a stack, and on some paths
 * its own log transcript, off it) and the marker is added around it.
 */

import {
  type ElectronLaunchOptions,
  preflightElectronLaunch,
} from "./electron-launch-preflight";
/**
 * The token that says the app did not come up.
 *
 * NOTHING CONSUMES THIS TOKEN YET, and this module does not pretend otherwise.
 * The intake it is shaped for is Datadog Test Management, which is outside this
 * repository and keys on module/suite/test rather than on the error string; the
 * repo-side `scripts/deploy/e2e-quarantine-*` audits reconcile suppression
 * RECORDS and never read an error message. So what lands here is the readable
 * half — a failure that says "the harness, not this spec" to whoever opens the
 * run — and not a change in how the failure is attributed downstream. Making
 * the intake act on it is ISS-6931, filed against this line.
 *
 * Deliberately one flat snake_case token: it is matched against recorded error
 * strings and grepped out of run logs, both of which reflow the prose around it.
 *
 * It claims that much and NOT a cause, and not that the spec did nothing —
 * nineteen specs launch the app more than once (boot, seed on disk, relaunch),
 * so a launch death can arrive after the body has already done real work. A
 * main-process crash on boot also rejects identically to an unusable runner, so
 * a marker reading "environmental" would route a product regression away from
 * product triage. Telling those apart needs the app's own output, which is the
 * thing Playwright does not give us.
 *
 * ISS-10066 made this token cover TWO headlines rather than one, and the token
 * itself no longer says which. {@link HARNESS_LAUNCH_FAILURE_HEADLINE} is still
 * cause-free, for the reason above. {@link WINDOWLESS_EXIT_HEADLINE} is NOT: it
 * carries the child's own exit code or signal, and `exit code 1` or
 * `killed by SIGSEGV` with no window is a product crash more often than it is a
 * wedged runner. So the "one grep, one family" property above now buys
 * groupability at the cost of routability — a renderer that segfaults on boot
 * greps identically to an unusable runner. ISS-6931, when it wires this into
 * intake, must split on the HEADLINE (or on a subtype added there) rather than
 * on this token alone; the two headlines are asserted distinct in
 * `test/electron-launch-attribution.test.ts` so that split stays available.
 */
export const HARNESS_LAUNCH_FAILURE_MARKER = "harness_launch_failure";

/**
 * The whole constant part of the emitted message.
 *
 * Exported so the suite can assert the message is EXACTLY this plus Playwright's
 * own text — which pins the determinism the grouping depends on without pinning
 * the wording, so a copy edit here stays a copy edit rather than a red test.
 */
export const HARNESS_LAUNCH_FAILURE_HEADLINE = `${HARNESS_LAUNCH_FAILURE_MARKER}: the Electron app did not come up (cause: UNKNOWN — Playwright reports no stderr and no exit code for a failed launch).`;

/**
 * Run `launch`, and re-throw any failure as an attributable harness failure.
 *
 * A successful launch is returned untouched — this adds nothing to the happy
 * path, which is every launch but the ones this ticket is about.
 *
 * ISS-12135: `launch` receives the options {@link preflightElectronLaunch}
 * returns, and is never called when that throws. A preflight failure is not
 * wrapped in the marker: its cause is known, and it names it.
 */
export async function launchElectronOrExplain<T>(
  launchOptions: ElectronLaunchOptions,
  launch: (options: ElectronLaunchOptions) => Promise<T>
): Promise<T> {
  const prepared = preflightElectronLaunch(launchOptions);
  try {
    return await launch(prepared);
  } catch (error) {
    throw new Error(harnessLaunchFailureMessage(error), { cause: error });
  }
}

function harnessLaunchFailureMessage(error: unknown): string {
  const reported = error instanceof Error ? error.message : String(error);
  return `${HARNESS_LAUNCH_FAILURE_HEADLINE}\n  playwright: ${reported}`;
}

/**
 * The SECOND window a launch can die in, which {@link launchElectronOrExplain}
 * cannot see: `electron.launch` resolved — so a real process exists and nothing
 * above is attributable — and then no window ever arrives.
 *
 * Playwright reports only `firstWindow: Timeout 30000ms exceeded`. It is not
 * merely terse, it is empty: `desktop-build` job 103380866864 records
 * `stdout: []` and `stderr: []` for both attempts of the one spec that hit it,
 * so the run says nothing about whether the app crashed on boot or the runner
 * was wedged — the split ISS-10066 says nothing separates yet.
 *
 * The child handle the launcher already captured answers half of that for free.
 * A process that has EXITED can never produce a window, so the remaining budget
 * buys a verdict that is already decided; racing the window against the child's
 * own `exit` spends it on an exit code instead of on silence.
 *
 * This does NOT widen the window budget, deliberately: an app still ALIVE at 30s
 * is untouched and still fails on Playwright's own timeout with Playwright's own
 * message. Measured on the same job, the ten sibling launches that DID come up
 * finished their whole test in 3.6-9.8s, so the budget is not what is tight.
 */
export const WINDOWLESS_EXIT_HEADLINE = `${HARNESS_LAUNCH_FAILURE_MARKER}: the Electron app launched and then exited before opening a window.`;

/** What the launcher needs from its child handle to observe an exit. */
export type ExitObservableChild = {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once(event: "exit", listener: ChildExitListener): unknown;
  off(event: "exit", listener: ChildExitListener): unknown;
};

type ChildExitListener = (
  code: number | null,
  signal: NodeJS.Signals | null
) => void;

/**
 * Await `window`, but reject as soon as `child` exits without producing one.
 *
 * `window` is taken already-started rather than as a thunk so the caller's own
 * `app` narrowing survives, and so this races a wait that is genuinely already
 * running.
 *
 * A caller with no child handle gets the plain await: there is no extra fact to
 * report, and inventing one would claim an exit nobody observed (the ISS-7654
 * rule, applied to launch instead of to teardown).
 */
export async function firstWindowOrExplainExit<T>(
  window: Promise<T>,
  child: ExitObservableChild | undefined
): Promise<T> {
  if (child === undefined) {
    return await window;
  }
  const already = describeExit(child.exitCode, child.signalCode);
  if (already !== null) {
    suppressRejection(window);
    throw new Error(windowlessExitMessage(already));
  }
  let onExit: ChildExitListener | undefined;
  const exited = new Promise<never>((_resolve, reject) => {
    onExit = (code, signal) => {
      reject(new Error(windowlessExitMessage(describeExit(code, signal))));
    };
    child.once("exit", onExit);
  });
  try {
    return await Promise.race([window, exited]);
  } finally {
    if (onExit !== undefined) {
      child.off("exit", onExit);
    }
    suppressRejection(window);
    suppressRejection(exited);
  }
}

/**
 * How the exit is spelled in the message, or `null` when the child has not
 * exited.
 *
 * `exit` can fire with both values null when the handle is already detached, so
 * the caller that reaches this from the EVENT must still get a sentence — it
 * observed an exit even though the OS reason is gone.
 */
function describeExit(
  code: number | null,
  signal: NodeJS.Signals | null
): string | null {
  if (signal !== null) {
    return `killed by ${signal}`;
  }
  if (code !== null) {
    return `exit code ${code}`;
  }
  return null;
}

function windowlessExitMessage(exit: string | null): string {
  return `${WINDOWLESS_EXIT_HEADLINE}\n  electron: ${exit ?? "exit reason unavailable"}`;
}

/**
 * Drop a rejection from the promise that LOST the race above.
 *
 * The loser settles after the winner with nobody awaiting it, and an unhandled
 * rejection takes down the whole Playwright worker rather than the one launch
 * this function was diagnosing — which would replace a readable failure with an
 * unreadable one, the opposite of the point.
 */
function suppressRejection(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}
