/**
 * @file process-group-kill.ts
 * @description SIGKILL a spawned process AND the process tree it leads.
 *
 * Its own module rather than another concern piled onto `desktop-app.ts`
 * (already at the file-size smell threshold): this owns only the POSIX
 * process-group question, and the node lane drives it directly against a real
 * spawned tree.
 */

import { type ChildProcess, execFileSync } from "node:child_process";

/**
 * Kill `child` and every process in its group. A no-op for an absent child.
 *
 * ISS-7683: `child.kill("SIGKILL")` reaps only the LEADER. Electron forks helper
 * (utility, renderer, GPU) processes that INHERIT the stdout/stderr pipes
 * Playwright's launcher created for the leader, so a helper orphaned by the
 * leader's death keeps those pipes open and the child's `"close"` event — which
 * needs process exit AND stdio EOF, not exit alone — never fires. Playwright's
 * teardown awaits exactly that event (`launchProcess`'s `waitForCleanup`), so
 * the worker then sits until `Worker teardown timeout of 60000ms exceeded` and
 * the run exits non-zero with every test still reported green. Observed on
 * `session-transcript-caption-reconciliation.spec.ts`, whose real historical
 * import leaves such a helper behind; an `Electron Helper` reparented to pid 1
 * outlived the whole run.
 *
 * Playwright spawns Electron `detached` on non-Windows, so the child leads its
 * own group and `kill(-groupId)` reaches those helpers. Leadership is CHECKED
 * rather than assumed — a `-pid` against a child that is not a group leader
 * would signal the test runner's OWN group, and this helper is reachable from
 * ~127 specs.
 *
 * `groupId` is the value {@link captureProcessGroupId} took AT LAUNCH, and
 * taking it there rather than here is the whole point. Resolving the group
 * lazily at teardown asks `ps` about a leader that may already be gone —
 * precisely the case this helper exists for, since a helper holding the
 * inherited pipes is what keeps the group alive AFTER the leader dies. `ps -p`
 * against a reaped pid exits non-zero, so a teardown-time lookup would conclude
 * "not a group leader", fall through to `child.kill` on an already-dead leader,
 * and leave the surviving helper holding the pipes — the exact hang above,
 * reported as a successful teardown. A pgid read while the leader was alive
 * cannot be wrong about that.
 *
 * Signalling a captured id is also strictly narrower than what Playwright's own
 * launcher does, which is `kill(-pid)` with no leadership check at all.
 */
export function killProcessGroup(
  child: ChildProcess | undefined,
  groupId: number | undefined
): void {
  if (groupId) {
    try {
      process.kill(-groupId, "SIGKILL");
      return;
    } catch {
      // The whole group went away between capture and signal. Fall through, so
      // the caller's bounded exit wait still grades a real kill attempt rather
      // than a swallowed one.
    }
  }
  child?.kill("SIGKILL");
}

/**
 * The group id to SIGKILL at teardown, or `undefined` when `child` does not lead
 * a group of its own.
 *
 * MUST be called while the child is still alive — a group leader's pgid equals
 * its pid, and that fact is only readable from a process the OS still knows
 * about. {@link killProcessGroup} explains what a late read gets wrong.
 */
export function captureProcessGroupId(
  child: ChildProcess | undefined
): number | undefined {
  const pid = child?.pid;
  if (!pid || process.platform === "win32") {
    return undefined;
  }
  try {
    const pgid = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], {
      encoding: "utf8",
    });
    return Number.parseInt(pgid.trim(), 10) === pid ? pid : undefined;
  } catch {
    return undefined;
  }
}
