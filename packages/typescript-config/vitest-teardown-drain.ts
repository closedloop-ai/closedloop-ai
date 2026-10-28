/**
 * ISS-9661 — drain the teardown work a test file's LAST unmount defers.
 *
 * Unmounting a component tree does not finish synchronously. React defers the
 * passive-unmount effects to its scheduler, which in Node schedules them through
 * `setImmediate`; one of those effects — `@radix-ui/react-focus-scope`'s cleanup
 * — then schedules a `setTimeout(…, 0)` whose callback builds a `CustomEvent`
 * and dispatches it on the container it was watching.
 *
 * For every unmount but the last, both of those run inside the file and nobody
 * notices. The last one has nothing left to run before the file ends, so it
 * fires after Vitest has torn the jsdom environment down, and the torn-down
 * realm rejects the work: "Failed to execute 'dispatchEvent' on 'EventTarget':
 * parameter 1 is not of type 'Event'" from a Radix timer, or "window is not
 * defined" from `Immediate.performWorkUntilDeadline` when it is React's own
 * scheduler that was still holding work.
 *
 * Vitest books that as an UNHANDLED ERROR rather than a test failure, so the job
 * exits 1 with a fully green suite: no failing test, no assertion, and the
 * originating file buried in an "Unhandled Errors" block after every passing
 * line. Seven PRs were blocked by that signature inside 24 hours.
 *
 * Two ticks are what the chain costs, and each one has a job:
 *
 *   1. a `setImmediate` tick, queued behind React's own scheduler immediate, so
 *      the deferred passive-unmount effects actually run;
 *   2. a `setTimeout(…, 0)` tick, queued behind the timers step 1 scheduled, so
 *      Radix's focus-scope callback runs too.
 *
 * This SUPPRESSES NOTHING. The deferred work still executes, and if it throws it
 * now throws inside the file that owns it — which is the diagnosis the old
 * signature made everybody pay for from scratch.
 *
 * `afterAll` runs after every `afterEach`, including the auto-cleanup
 * `@testing-library/react` registers, so the unmount has always happened by the
 * time this runs.
 *
 * WHAT THIS DOES NOT COVER, so nobody reads it as a blanket guarantee:
 *
 *   - A root that is never UNMOUNTED at all. Nothing is deferred in that case;
 *     the work is still owned by a live tree, and no number of ticks drains it.
 *     That was the Storybook half of ISS-9661, fixed by making portable stories
 *     render through RTL (`apps/storybook/vitest.setup.ts`).
 *   - A timer with a real DELAY that its component never cleared —
 *     `@radix-ui/react-tooltip`'s skip-delay is the live example. Two ticks do
 *     not reach it, and waiting out an arbitrary delay here would be a sleep
 *     pretending to be a fix. Those belong to the component or to fake timers in
 *     the suite that mounts it.
 */
import { setImmediate, setTimeout } from "node:timers";
import { afterAll } from "vitest";

afterAll(drainDeferredTeardownWork);

/**
 * ISS-9696 — the two turns MUST schedule through `node:timers`, not the globals.
 * `vi.useFakeTimers()` installs a Sinon clock over the properties on
 * `globalThis`, not over a module's own import bindings, so a file that ends
 * with fake timers still installed would leave a globals-scheduled drain waiting
 * on a clock nobody advances again — this hook never resolves and the file dies
 * as a hook timeout with no visible relation to timers.
 */
export async function drainDeferredTeardownWork(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}
