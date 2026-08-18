/**
 * ISS-4934 — node:test's `mock.timers`, expressed on Vitest.
 *
 * The 26 desktop suites converted off `mock.timers` call this rather than `vi`
 * directly, because node:test and Vitest disagree in ways that are SILENT
 * — a mistranslation does not throw, it produces a test that passes while no
 * longer testing what it says. Both were confirmed by running the two runners
 * against each other on this repo rather than read off a doc page. The two this
 * helper TRANSLATES are pinned in `test/node-test-fake-timers.test.ts`; a third,
 * which it does not, is recorded below:
 *
 *   1. **The clock's origin.** node:test starts a faked `Date` at epoch 0;
 *      Vitest starts it at the real `Date.now()`. A fixture timestamp compared
 *      for equality would fail loudly on that, which is the safe direction. The
 *      dangerous one is an assertion that a recorded time is "recent", or a
 *      TTL/expiry measured against the wall clock: those keep passing and
 *      quietly stop measuring what they were written for.
 *
 *   2. **The implicit clear functions.** node:test fakes `clearTimeout` with
 *      `setTimeout`, `clearInterval` with `setInterval`, and `clearImmediate`
 *      with `setImmediate`. Vitest fakes exactly what `toFake` lists, and a
 *      REAL `clearTimeout` handed a fake handle is a silent no-op — so a suite
 *      whose whole subject is "shutdown cancels the pending timer" would keep
 *      passing its setup and then watch the timer fire anyway. That is the
 *      test-cannot-fail shape, reached by a one-word omission.
 *
 * Keeping the translation in one module also means the next suite that needs
 * fake timers gets both rules for free instead of re-deriving them.
 *
 * THERE IS A THIRD DIFFERENCE, and this helper does NOT translate it: node:test
 * also patches the `node:timers` MODULE, so `import timers from "node:timers";
 * timers.setTimeout(…)` is faked there and is NOT faked here (measured, both
 * runners, this repo). No desktop subject imports `node:timers` today, so
 * nothing is currently mistranslated — but a subject that starts to would go
 * quiet rather than red, so it is written down instead of left to be
 * rediscovered. `node:timers/promises` is NOT part of this: neither runner
 * fakes it, so `src/server/operations/learnings.ts` behaves identically on
 * both, and it is recorded here so the non-difference is not re-raised as one.
 */

import { vi } from "vitest";

/**
 * Every timer api node:test's `mock.timers.enable({ apis })` accepts, mapped to
 * the Vitest `toFake` entries that reproduce it — the api itself plus the clear
 * function node:test fakes alongside it.
 */
const NODE_TEST_TIMER_APIS = {
  Date: ["Date"],
  setImmediate: ["setImmediate", "clearImmediate"],
  setInterval: ["setInterval", "clearInterval"],
  setTimeout: ["setTimeout", "clearTimeout"],
} as const;

/** A member of node:test's `mock.timers.enable({ apis })` array. */
export type NodeTestTimerApi = keyof typeof NODE_TEST_TIMER_APIS;

/**
 * A member of Vitest's `toFake`.
 *
 * Derived from the map rather than annotated `string[]`: Vitest types `toFake`
 * as a union, so a widened `string[]` does not satisfy it, and adding an api
 * above should extend this automatically instead of needing a second edit.
 */
type NodeTestFakeMethod =
  (typeof NODE_TEST_TIMER_APIS)[NodeTestTimerApi][number];

/**
 * Vitest's `toFake` list for a node:test `apis` list.
 *
 * Exported for the test that proves the clear functions come along; call sites
 * want {@link nodeTestTimers} instead.
 */
export function nodeTestTimersToFake(
  apis: readonly NodeTestTimerApi[]
): NodeTestFakeMethod[] {
  return [...new Set(apis.flatMap((api) => NODE_TEST_TIMER_APIS[api]))];
}

/**
 * `mock.timers.enable` / `.tick` / `.reset`, one verb each.
 *
 * A facade rather than three exports so a converted suite adds ONE import line.
 * Several of these files are on the shrink-only grandfather list, where a
 * two-line import cost is the difference between a clean conversion and a
 * blocked push — enforced by `pnpm check:grandfather-line-growth`, which diffs
 * logical lines against the merge base. NOT by Biome: the `biome.jsonc`
 * override turns `noExcessiveLinesPerFile` OFF for those files rather than
 * raising its cap, so lint alone would never notice.
 */
export const nodeTestTimers = {
  /**
   * `mock.timers.enable({ apis, now })`.
   *
   * `now` defaults to 0 — node:test's origin, not Vitest's. It is passed even
   * when `Date` is not faked, which matches node:test: its clock also starts at
   * 0 regardless of which apis are mocked.
   */
  enable(
    apis: readonly NodeTestTimerApi[],
    options?: { now?: number | Date }
  ): void {
    vi.useFakeTimers({
      toFake: nodeTestTimersToFake(apis),
      now: options?.now ?? 0,
    });
  },

  /**
   * `mock.timers.tick(ms)` — synchronous, and deliberately NOT
   * `advanceTimersByTimeAsync`. node:test's `tick` runs due callbacks and
   * returns without draining the microtask queue, so a suite that awaited its
   * own flush after ticking keeps the same interleaving; the async form would
   * additionally drain promises between timers and could reorder work the test
   * was written to observe in a particular order.
   */
  tick(ms: number): void {
    vi.advanceTimersByTime(ms);
  },

  /** `mock.timers.reset()` — restores the real clock. */
  reset(): void {
    vi.useRealTimers();
  },
};
