import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
  createDesktopMainFeatureFlagAssignmentStore,
  publishDesktopMainFeatureFlagAssignmentStore,
} from "../src/main/auth/desktop-feature-flag-assignment.js";
import { createSessionLimitsGate } from "../src/main/session-limits/session-limits-gate.js";
import { DESKTOP_SUBSCRIPTION_SESSION_LIMITS_FEATURE_FLAG_KEY } from "../src/shared/feature-flags-labs-detail.js";

/**
 * ISS-8792 — main's session-limit producers read the SAME verdict the renderer's
 * `SessionLimitsFooter` reads, and they start when it LANDS.
 *
 * BUILT IN PRODUCTION ORDER, AND THE SUBSCRIPTION IS WHAT IS UNDER TEST.
 * `DesktopApplication` creates this gate from a class field initialiser, before
 * the constructor body publishes the assignment store, so a gate that
 * subscribed at construction would bind to a `null` store and never hear the
 * verdict. `UsageApiService.start()` schedules no timer while its gate reads
 * closed, so that silence would mean capture never runs for the life of the
 * process.
 *
 * The cases below therefore call `reconcile()` ONCE — what capture startup does,
 * and what registers the listener — and then let the verdict settle WITHOUT
 * calling it again. A second `reconcile()` would start the producers directly
 * and pass whether or not the notification path works, which is exactly how the
 * first version of the Routines gate suite went green against the bug it
 * claimed to cover.
 */

const SUBJECT = "user-1";

/** Bounded state poll — never a fixed sleep, and it fails loudly. */
async function flushUntil(
  predicate: () => boolean,
  label: string
): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
  // Thrown, not asserted: an assertion in a helper outside a test body is a
  // `noMisplacedAssertion` error, and a timeout is a harness failure.
  throw new Error(`timed out waiting for ${label}`);
}

function harness(flags: Record<string, boolean>) {
  // Gate FIRST, store published SECOND — production order.
  let starts = 0;
  const warnings: string[] = [];
  const gate = createSessionLimitsGate({
    getProducers: () => ({
      start: () => {
        starts += 1;
        return Promise.resolve();
      },
    }),
    isShuttingDown: () => false,
    logWarning: (message) => warnings.push(message),
  });
  const store = createDesktopMainFeatureFlagAssignmentStore({
    fetchAssignment: () =>
      Promise.resolve({ userId: SUBJECT, resolved: true, flags }),
    retryDelaysMs: [],
  });
  publishDesktopMainFeatureFlagAssignmentStore(store);
  return { gate, store, warnings, startCount: () => starts };
}

afterEach(() => {
  publishDesktopMainFeatureFlagAssignmentStore(null);
});

describe("session-limits gate (ISS-8792)", () => {
  test("the verdict comes from the ASSIGNMENT, and is CLOSED before it arrives", () => {
    const { gate } = harness({
      [DESKTOP_SUBSCRIPTION_SESSION_LIMITS_FEATURE_FLAG_KEY]: true,
    });

    // Nothing resolved yet: a boot-time read cannot open a credential read for
    // an account whose verdict has not been evaluated.
    assert.equal(gate.isUsageCaptureEnabled(), false);
    gate.dispose();
  });

  test("starts the producers when the verdict SETTLES, through the subscription alone", async () => {
    const { gate, store, startCount } = harness({
      [DESKTOP_SUBSCRIPTION_SESSION_LIMITS_FEATURE_FLAG_KEY]: true,
    });
    await gate.reconcile();
    assert.equal(startCount(), 0, "closed before the verdict");

    await store.resolveFor(SUBJECT);

    // Deliberately NO second `reconcile()`.
    await flushUntil(() => startCount() === 1, "the producers to start");
    assert.equal(gate.isUsageCaptureEnabled(), true);
    gate.dispose();
  });

  test("leaves the producers stopped when the account's verdict is CLOSED", async () => {
    const { gate, store, startCount } = harness({});
    await gate.reconcile();

    await store.resolveFor(SUBJECT);

    await flushUntil(() => true, "a turn of the event loop");
    assert.equal(startCount(), 0);
    assert.equal(gate.isUsageCaptureEnabled(), false);
    gate.dispose();
  });

  test("converges rather than starting twice when reconcile races the notification", async () => {
    const { gate, store, startCount } = harness({
      [DESKTOP_SUBSCRIPTION_SESSION_LIMITS_FEATURE_FLAG_KEY]: true,
    });
    await gate.reconcile();

    await store.resolveFor(SUBJECT);
    await gate.reconcile();
    await gate.reconcile();

    await flushUntil(() => startCount() === 1, "the producers to start");
    assert.equal(startCount(), 1, "converged: no second start");
    gate.dispose();
  });

  test("stops hearing verdicts after dispose, while staying usable on demand", async () => {
    const { gate, store, startCount } = harness({
      [DESKTOP_SUBSCRIPTION_SESSION_LIMITS_FEATURE_FLAG_KEY]: true,
    });
    await gate.reconcile();
    gate.dispose();

    await store.resolveFor(SUBJECT);
    await flushUntil(() => true, "a turn of the event loop");

    assert.equal(startCount(), 0, "disposed gate hears no verdict");
    // Positive control: the zero above is the subscription being gone, not the
    // verdict or the producers being wrong.
    await gate.reconcile();
    assert.equal(startCount(), 1);
  });
});
