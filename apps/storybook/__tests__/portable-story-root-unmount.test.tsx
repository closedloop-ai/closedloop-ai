/**
 * ISS-9661. Pins the one line in `vitest.setup.ts` that takes this app's live
 * React roots from 27 to 0: the `testingLibraryRender` project annotation.
 *
 * Without it, Storybook mounts portable stories through its own
 * `react-dom-shim`, which creates a root per `run()` and unmounts none of them.
 * `runStory`'s cleanup only DETACHES the container, so every suite in this
 * directory ended with a live root still holding queued scheduler work — work
 * that fires from `Immediate.performWorkUntilDeadline` after Vitest tears the
 * jsdom down and is booked as an unhandled error. The job then exits 1 with
 * every test green.
 *
 * Nothing else in this directory can catch that. Removing the annotation leaves
 * every story assertion passing (the story still renders; it is only never torn
 * down), which is precisely why the fix shipped unpinned and why this file is
 * an `afterAll` hook rather than another `it`.
 *
 * WHY THE PROBE IS A REACT INTERNAL. `unmount()` is the ONLY thing that clears
 * React's `__reactContainer$<seed>` back-reference on a container node — a
 * detach does not, an `innerHTML = ""` does not. So a non-null value on a node
 * the story mounted into, read after RTL's auto-cleanup has run, is direct
 * evidence the root outlived its test. Asserting on `document.body` instead
 * would prove nothing here: both the fixed and the broken path leave the body
 * empty, one by unmounting and one by detaching.
 */
import { composeStory } from "@storybook/react";
import { describe, expect, it } from "vitest";
import switchMeta, { Default as defaultStory } from "../stories/switch.stories";

/**
 * React suffixes this key with a per-runtime random seed, so it can only be
 * matched by prefix.
 */
const REACT_CONTAINER_KEY_PREFIX = "__reactContainer$";

/**
 * The nodes the story mounted into, captured while they are still attached —
 * RTL's cleanup detaches them, so `document` cannot be re-queried afterwards.
 */
const mountedContainers: Element[] = [];

function hasLiveReactRoot(node: Element): boolean {
  return Object.keys(node).some(
    (key) =>
      key.startsWith(REACT_CONTAINER_KEY_PREFIX) &&
      Reflect.get(node, key) != null
  );
}

function liveReactRoots(): Element[] {
  return mountedContainers.filter(hasLiveReactRoot);
}

describe("portable story root unmount (ISS-9661)", () => {
  it("mounts a portable story through the shared setup, on a live root", async () => {
    const Default = composeStory(defaultStory, switchMeta);

    await Default.run();
    mountedContainers.push(...document.body.children);

    // Both halves are the positive control for the `afterAll` below. Without
    // them a setup change that stopped mounting anything at all — or a probe
    // key React renamed — would leave that hook trivially satisfied and this
    // file green forever while pinning nothing.
    expect(mountedContainers.length).toBeGreaterThan(0);
    expect(liveReactRoots().length).toBeGreaterThan(0);
  });

  // A second case rather than an `afterAll`, because the teardown under test IS
  // the auto-cleanup RTL registers as an `afterEach` — which has therefore run
  // by the time this one starts, on exactly the roots the case above captured.
  it("leaves no live root behind once RTL's auto-cleanup has run", () => {
    expect(
      liveReactRoots(),
      "a portable story's React root was still mounted after RTL's auto-cleanup, so this file ends holding queued scheduler work that will fire against a torn-down jsdom and fail the job with a fully green suite (ISS-9661). Restore the `testingLibraryRender` annotation in apps/storybook/vitest.setup.ts."
    ).toEqual([]);
  });
});
