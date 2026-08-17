/**
 * @file renderer-activity-window.ts
 * @description ISS-4711: pure "is the renderer actively being served?" predicate
 * extracted from the `DesktopApplication` monolith so it is unit-testable without
 * booting Electron (and to shrink `app.ts`). The DATA_REVISION rebuild's adaptive
 * write-pause gate consults this to decide between the full cooperative pause and
 * the idle fast path.
 *
 * The renderer is "active" when EITHER a trusted DB IPC read OR a user-input
 * event landed within the recent quiet window. The DB-read arm is the one that
 * matters for a hands-off-keyboard auto-refreshing/polling list reading the same
 * local DB the rebuild is writing — that fires no user-input event but is still
 * active UI serving that must hold the full pause (wongk, PR #4184). The
 * user-input arm keeps parity with the existing `waitForRendererBackgroundSlot`
 * background-slot policy.
 */

/**
 * Returns `true` when the renderer counts as actively served at `nowMs`: the most
 * recent of the two activity timestamps is strictly within `windowMs`. Absent
 * activity is represented by `0` (the app's initial timestamp value), which is
 * only "recent" if `nowMs < windowMs` — i.e. within the window of the epoch,
 * never in practice.
 */
export function isRendererRecentlyActive(
  nowMs: number,
  lastDbReadAtMs: number,
  lastUserInputAtMs: number,
  windowMs: number
): boolean {
  const lastActivityAtMs = Math.max(lastDbReadAtMs, lastUserInputAtMs);
  return nowMs - lastActivityAtMs < windowMs;
}
