import { beforeEach } from "vitest";
import {
  DASHBOARD_FLAG_SET,
  dashboardOnboardedStorageKey,
} from "../components/dashboard/dashboard-storage-keys";

/**
 * Renderer-lane setup: every suite models an install that HAS RUN BEFORE.
 *
 * ISS-10195 gave a signed-out reader the guided onboarding run, and
 * `Sidebar.tsx` mounts its dialog host unconditionally. The run arms on a first
 * run, and "first run" is this latch being absent — so a suite that mounts the
 * shell without seeding it got a blocking modal over the surface it asserts on:
 * `data-scroll-locked="1"`, `pointer-events: none` on the body, the shell
 * `aria-hidden="true"`. Five layout suites went red that way, and none of them
 * installs a store of its own to seed.
 *
 * This is the same seed and the same reason as `setupReturningInstallStorage`,
 * applied to the lane instead of to the suites that remembered to call it.
 * `installLocalStorage` re-seeds because it REPLACES this store rather than
 * adding to it, so both are load-bearing.
 *
 * A suite whose SUBJECT is first run opts out explicitly: it stubs
 * `globalThis.localStorage` wholesale via `stubLocalStorage`, which discards
 * whatever this wrote, or removes the key after its own setup
 * (`app-shell-first-run.test.tsx`).
 */
beforeEach(() => {
  try {
    globalThis.localStorage?.setItem(
      dashboardOnboardedStorageKey,
      DASHBOARD_FLAG_SET
    );
  } catch {
    // A jsdom with no usable Storage cannot be seeded, and the run fails closed
    // there anyway — it arms only on a latch ABSENT from a readable store.
  }
});
