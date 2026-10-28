/**
 * ISS-10950 — the predicate deciding whether local session analysis may begin,
 * and the latch that holds the boot import until it says yes.
 *
 * The gate's cases drive the REAL predicate rather than a boolean the test made
 * up, because the two are only correct together: a device carries an explicit
 * `null` tier on first launch (ISS-10554's seed writes the KEY), so a gate that
 * read key presence alone would be open on exactly the launch this ticket is
 * about — and one that read the value alone would shut on an upgrading profile
 * that never had the key and is already importing.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  createSessionAnalysisConsentGate,
  hasAgreedToSessionAnalysis,
  SessionAnalysisConsentGate,
} from "../src/main/onboarding/session-analysis-consent-gate.js";
import type { SyncConsentRecord } from "../src/shared/sync-consent.js";

/** What a first launch persists: the key written, the answer withheld. */
const UNANSWERED: SyncConsentRecord = {
  bound: true,
  organizationId: null,
  tier: null,
};

/** The lowest level the sync-policy step offers, and still an answer. */
const ANSWERED_OFF: SyncConsentRecord = {
  bound: true,
  organizationId: null,
  tier: "local",
};

describe("hasAgreedToSessionAnalysis", () => {
  it("withholds agreement on the first-launch seed's explicit not-consented tier", () => {
    assert.equal(agreed(UNANSWERED), false);
  });

  // ISS-10890: Welcome's Start is the agreement a fresh install gives, and it
  // arrives while the seeded tier is still the explicit not-yet `null`.
  it("reads the recorded Welcome Start agreement as agreement over an unanswered tier", () => {
    assert.equal(agreed(UNANSWERED, { startAgreed: true }), true);
  });

  it("reads any recorded tier as agreement, the lowest level included", () => {
    assert.equal(agreed(ANSWERED_OFF), true);
  });

  // The Compatibility Guardrail clause. A profile predating ISS-10554's seed has
  // no key at all, no screen is coming to ask it, and it has been importing for
  // releases — so the same unanswered RECORD flips to agreement on key absence.
  it("grandfathers a profile that predates the first-launch tier seed", () => {
    assert.equal(
      hasAgreedToSessionAnalysis({
        getSessionAnalysisAgreed: () => false,
        getSyncConsentRecord: () => UNANSWERED,
        hasSyncObservabilityTierBeenSet: () => false,
      }),
      true
    );
  });
});

describe("SessionAnalysisConsentGate", () => {
  it("stays shut while neither Start nor the sync-policy step is answered", async () => {
    const gate = gateOver(UNANSWERED);

    assert.equal(await settledWithin(gate.whenGranted()), false);
  });

  it("opens as soon as the answer is recorded", async () => {
    let record = UNANSWERED;
    const gate = new SessionAnalysisConsentGate({
      hasAgreedToSessionAnalysis: () => agreed(record),
    });
    const granted = gate.whenGranted();

    record = ANSWERED_OFF;
    gate.reconcile();

    assert.equal(await settledWithin(granted), true);
  });

  // The `off` level is the case a value-blind gate gets wrong in the other
  // direction: it records a real answer, so the import must start, even though
  // the device chose to upload nothing.
  it("treats the lowest sync level as consent, not as no answer", async () => {
    const gate = gateOver(ANSWERED_OFF);

    assert.equal(await settledWithin(gate.whenGranted()), true);
  });

  it("never reopens a shut gate on a reconcile that finds no answer", async () => {
    const gate = gateOver(UNANSWERED);
    const granted = gate.whenGranted();

    gate.reconcile();

    assert.equal(await settledWithin(granted), false);
  });

  // A boot parked here would otherwise hold its caller for the life of the
  // process; the resumer distinguishes the two outcomes by the resolved value.
  it("unwinds a pending wait at shutdown as NOT granted", async () => {
    let asked = 0;
    const gate = new SessionAnalysisConsentGate({
      hasAgreedToSessionAnalysis: () => {
        asked += 1;
        return false;
      },
    });
    const granted = gate.whenGranted();

    gate.dispose();

    assert.equal(await settledWithin(granted), true);
    assert.equal(await granted, false);
    assert.equal(asked, 1);
  });

  it("refuses a live restart while the answer is outstanding", () => {
    assert.equal(gateOver(UNANSWERED).isGranted(), false);
  });

  it("refuses a live restart once disposed, however the answer reads", () => {
    const gate = gateOver(ANSWERED_OFF);

    gate.dispose();

    assert.equal(gate.isGranted(), false);
  });
});

function gateOver(record: SyncConsentRecord): SessionAnalysisConsentGate {
  return new SessionAnalysisConsentGate({
    hasAgreedToSessionAnalysis: () => agreed(record),
  });
}

/** The predicate over a profile whose tier key is present, as every seeded one is. */
function agreed(
  record: SyncConsentRecord,
  { startAgreed = false }: { startAgreed?: boolean } = {}
): boolean {
  return hasAgreedToSessionAnalysis({
    getSessionAnalysisAgreed: () => startAgreed,
    getSyncConsentRecord: () => record,
    hasSyncObservabilityTierBeenSet: () => true,
  });
}

/**
 * Whether `promise` resolved by the time the microtask queue drained.
 *
 * No timer, real or fake: every path under test settles synchronously or not at
 * all, so a pending gate is proven by the race resolving to the sentinel rather
 * than by a duration.
 */
function settledWithin(promise: Promise<unknown>): Promise<boolean> {
  const pending = Symbol("pending");
  return Promise.race([
    promise.then(() => true),
    Promise.resolve(pending).then(() => false),
  ]);
}

/**
 * The COMPOSED gate — the two clauses the hand-built class above cannot reach.
 *
 * Golden mode's pre-grant and the disposed refusal both live in the factory, so
 * a suite that only drives {@link SessionAnalysisConsentGate} stays green when
 * either is deleted (tamsinb review, ISS-10950).
 */
describe("createSessionAnalysisConsentGate", () => {
  it("pre-grants golden mode, which has no reader to ask", async () => {
    const harness = composeOver(UNANSWERED, { isGoldenMode: true });

    harness.gate.startCollectorsWhenAgreed(harness.runtime);

    assert.equal(await startsAfterFlush(harness), 1);
  });

  it("holds the boot import while neither Start nor the sync policy is answered", async () => {
    const harness = composeOver(UNANSWERED);

    harness.gate.startCollectorsWhenAgreed(harness.runtime);

    assert.equal(await startsAfterFlush(harness), 0);
  });

  it("starts the boot import once Welcome's Start agreement is recorded", async () => {
    const harness = composeOver(UNANSWERED);
    harness.gate.startCollectorsWhenAgreed(harness.runtime);

    harness.startAgreed = true;
    harness.gate.reconcile();

    assert.equal(await startsAfterFlush(harness), 1);
  });

  it("starts the boot import once a level write records the answer", async () => {
    const harness = composeOver(UNANSWERED);
    harness.gate.startCollectorsWhenAgreed(harness.runtime);

    harness.record = ANSWERED_OFF;
    harness.gate.reconcile();

    assert.equal(await startsAfterFlush(harness), 1);
  });

  // The fail-open marisolashgrove named: dispose releases every waiter, so a
  // resumer that consulted only `isShuttingDown` would start the import here.
  it("does not start the boot import when dispose released the wait", async () => {
    const harness = composeOver(UNANSWERED, { isShuttingDown: false });
    harness.gate.startCollectorsWhenAgreed(harness.runtime);

    harness.gate.dispose();

    assert.equal(await startsAfterFlush(harness), 0);
  });

  it("refuses a live restart while the gate is held, and runs it once granted", () => {
    const harness = composeOver(UNANSWERED);
    let restarts = 0;
    const restart = () => {
      restarts += 1;
      return undefined;
    };

    harness.gate.restartCollectorsIfAgreed(restart);
    assert.equal(restarts, 0);

    harness.record = ANSWERED_OFF;
    harness.gate.restartCollectorsIfAgreed(restart);
    assert.equal(restarts, 1);
  });
});

type ComposedHarness = {
  gate: ReturnType<typeof createSessionAnalysisConsentGate>;
  record: SyncConsentRecord;
  runtime: { startCollectors: () => void };
  startAgreed: boolean;
  starts: () => number;
};

function composeOver(
  record: SyncConsentRecord,
  overrides: { isGoldenMode?: boolean; isShuttingDown?: boolean } = {}
): ComposedHarness {
  let starts = 0;
  const harness = {
    record,
    startAgreed: false,
    runtime: {
      startCollectors: () => {
        starts += 1;
      },
    },
    starts: () => starts,
  } as ComposedHarness;
  harness.gate = createSessionAnalysisConsentGate({
    isGoldenMode: () => overrides.isGoldenMode === true,
    isShuttingDown: () => overrides.isShuttingDown === true,
    logWarning: () => undefined,
    settings: () => ({
      getSessionAnalysisAgreed: () => harness.startAgreed,
      getSyncConsentRecord: () => harness.record,
      hasSyncObservabilityTierBeenSet: () => true,
    }),
  });
  return harness;
}

/**
 * `startCollectorsWhenAgreed` resumes in a `.then`, so the count is only true
 * after the microtask queue drains. Two turns: the gate's promise, then the
 * continuation chained onto it.
 */
async function startsAfterFlush(harness: ComposedHarness): Promise<number> {
  await Promise.resolve();
  await Promise.resolve();
  return harness.starts();
}
