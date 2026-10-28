import { expect, type Page } from "@playwright/test";
import { LIVE_BRIDGE_INVALIDATION_THROTTLE_MS } from "@repo/app/shared/hooks/use-live-query-bridge.ts";

/** Where the renderer keeps its push tally, so both helpers name one key. */
const PUSH_TALLY_KEY = "__clE2eDbChangedPushes";

/**
 * How long quiescence may take before it is a hang rather than a wait. Generous
 * on purpose: it bounds a stuck collector, it is not the expected cost.
 */
const QUIESCENCE_TIMEOUT_MS = 60_000;

/**
 * Start tallying `desktop:db:changed` pushes in the renderer.
 *
 * Idempotent: a second subscription on the same page would double-count every
 * push, and a tally that climbs twice per event never goes quiet.
 */
export async function recordDbChangedPushes(page: Page): Promise<void> {
  await page.evaluate((key) => {
    if (Reflect.get(globalThis, key) !== undefined) {
      return;
    }
    Reflect.set(globalThis, key, 0);
    const api = Reflect.get(globalThis, "desktopApi") as
      | { onDbChanged?: (listener: () => void) => unknown }
      | undefined;
    api?.onDbChanged?.(() => {
      Reflect.set(
        globalThis,
        key,
        (Reflect.get(globalThis, key) as number) + 1
      );
    });
  }, PUSH_TALLY_KEY);
}

/**
 * Wait until the live bridge has no invalidation left to deliver.
 *
 * `useLiveQueryBridge` throttles `desktop:db:changed` pushes on BOTH edges, and
 * the leading one is what makes this wait necessary. `lastInvalidatedAt` starts
 * at 0, so the first push after mount computes a zero wait and flushes on the
 * next macrotask; every later push inside the window collapses into a single
 * TRAILING flush at most {@link LIVE_BRIDGE_INVALIDATION_THROTTLE_MS} after the
 * PREVIOUS flush, not after the burst's first push. `BranchesLiveBridge` flushes
 * by invalidating `pageDataRoot()` and `cohortAnalyticsRoot()`. The desktop
 * local branches policy is `staleTime: Infinity`, so that invalidation is the
 * ONLY thing that can refresh an already-fetched range — which makes a flush
 * landing after a range was cached indistinguishable, to a spec counting reads,
 * from the cache reuse it is trying to pin failing.
 *
 * So the collector's startup burst always produces two flushes: an immediate one
 * on its first push, then one trailing flush ~5s later carrying the rest. What
 * varies is where that trailing flush falls relative to the counted span — past
 * its end on a fast local run, inside it under CI load. Waiting for a full
 * throttle window with no new push is what makes that difference stop mattering:
 * a timer is only ever scheduled by a push and `invalidate` drains the backlog,
 * so once a whole window passes push-free, every flush the bridge had scheduled
 * has already fired and the reads counted afterwards are the spec's own.
 *
 * Call it BEFORE the first read a spec counts, not just before the assertion —
 * an invalidation already delivered has already marked the cached range stale.
 */
export async function waitForLiveBridgeQuiescence(page: Page): Promise<void> {
  let previous = -1;
  await expect
    .poll(
      async () => {
        const current = await dbChangedPushCount(page);
        const quiet = current === previous;
        previous = current;
        return quiet;
      },
      {
        intervals: [LIVE_BRIDGE_INVALIDATION_THROTTLE_MS],
        timeout: QUIESCENCE_TIMEOUT_MS,
      }
    )
    .toBe(true);
}

function dbChangedPushCount(page: Page): Promise<number> {
  return page.evaluate((key) => {
    const tally = Reflect.get(globalThis, key);
    if (typeof tally !== "number") {
      throw new Error(
        "the desktop:db:changed tally is missing — call recordDbChangedPushes first"
      );
    }
    return tally;
  }, PUSH_TALLY_KEY);
}
