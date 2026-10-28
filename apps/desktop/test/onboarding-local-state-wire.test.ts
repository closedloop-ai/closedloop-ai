/**
 * @file onboarding-local-state-wire.test.ts
 * @description ISS-8376 — the renderer's boundary parser.
 *
 * The acceptance criterion is that "malformed collector or installer data is
 * never persisted and never shown as a plausible count or completion". The
 * producer already names this impossible set at collection time
 * (`TranscriptExclusionReason.ImplausibleSize`), and this parse is the SECOND
 * trust boundary — a process hop that a version-skewed or buggy main can cross
 * with a number no bare `z.number()` would refuse.
 *
 * Negative and non-finite are the two everyone remembers. What actually reaches
 * a rendered total is the rest: a fractional count, and a magnitude past the
 * safe-integer range where every later addition silently loses precision and the
 * sum still renders as a confident number of GB.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  ONBOARDING_LOCAL_STATE_CONTRACT_VERSION,
  OnboardingHarness,
  OnboardingHarnessOutcome,
  OnboardingInventoryCompleteness,
  OnboardingInventoryStatus,
} from "../src/shared/onboarding-local-state-contract.js";
import { parseOnboardingLocalState } from "../src/shared/onboarding-local-state-parse.js";
import {
  ANALYSIS_ETA_CONTRACT_VERSION,
  AnalysisEtaConfidence,
  AnalysisEtaKind,
  AnalysisEtaUnavailableReason,
} from "../src/shared/transcript-analysis-eta-contract.js";

const ETA = {
  contractVersion: ANALYSIS_ETA_CONTRACT_VERSION,
  inventoryRevision: 3,
  kind: AnalysisEtaKind.Calculating,
  retainedSampleCount: 0,
  activeElapsedMs: 0,
};

/** A complete `measured` estimate, the shape the per-kind check must let past. */
const MEASURED_ETA = {
  contractVersion: ANALYSIS_ETA_CONTRACT_VERSION,
  inventoryRevision: 3,
  kind: AnalysisEtaKind.Measured,
  remainingMs: 90_000,
  rawRemainingMs: 88_000,
  remainingBytes: 2048,
  throughputBytesPerMs: 0.023,
  confidence: AnalysisEtaConfidence.Established,
  retainedSampleCount: 12,
  activeElapsedMs: 30_000,
};

function measuredPayload(
  inventoryOverrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    contractVersion: ONBOARDING_LOCAL_STATE_CONTRACT_VERSION,
    computeTargetId: "ct-01",
    inventory: {
      status: OnboardingInventoryStatus.Measured,
      inventoryRevision: 3,
      parseCompleteness: OnboardingInventoryCompleteness.Complete,
      uploadCompleteness: OnboardingInventoryCompleteness.Partial,
      discoveredBytes: 4096,
      eligibleParseBytes: 4096,
      excludedBytes: 0,
      physicalBytes: 4096,
      attributableRawBytes: 4096,
      enumeratedHarnesses: [OnboardingHarness.Claude, OnboardingHarness.Codex],
      evidence: [
        {
          harness: OnboardingHarness.Claude,
          outcome: OnboardingHarnessOutcome.Measured,
        },
      ],
      ...inventoryOverrides,
    },
    analysisEta: ETA,
  };
}

describe("onboarding local-state wire parse (ISS-8376)", () => {
  test("the contract version is pinned at 2", () => {
    assert.equal(ONBOARDING_LOCAL_STATE_CONTRACT_VERSION, 2);
  });

  test("a well-formed measured payload parses", () => {
    const parsed = parseOnboardingLocalState(measuredPayload());

    assert.notEqual(parsed, null);
    assert.equal(parsed?.inventory.status, OnboardingInventoryStatus.Measured);
    assert.equal(parsed?.computeTargetId, "ct-01");
  });

  test("a malformed session-count list withdraws only the counts, keeping the measurement", () => {
    const parsed = parseOnboardingLocalState(
      measuredPayload({
        sessionsByHarness: [
          { harness: OnboardingHarness.Claude, sessionCount: -1 },
        ],
      })
    );

    assert.equal(parsed?.inventory.status, OnboardingInventoryStatus.Measured);
    if (parsed?.inventory.status !== OnboardingInventoryStatus.Measured) {
      return;
    }
    assert.equal(parsed.inventory.sessionsByHarness, undefined);
    assert.equal(parsed.inventory.discoveredBytes, 4096);
    assert.equal(parsed.inventory.eligibleParseBytes, 4096);
  });

  test("the parse position survives the boundary, and an impossible one withdraws alone (ISS-10624)", () => {
    const carried = parseOnboardingLocalState(
      measuredPayload({ parsedBytes: 1024 })
    );
    assert.equal(carried?.inventory.status, OnboardingInventoryStatus.Measured);
    if (carried?.inventory.status !== OnboardingInventoryStatus.Measured) {
      return;
    }
    // Declared, not incidental: `z.object` strips an undeclared key, so without
    // the schema entry main could send this forever and no renderer would see
    // it.
    assert.equal(carried.inventory.parsedBytes, 1024);

    const impossible = parseOnboardingLocalState(
      measuredPayload({ parsedBytes: -1 })
    );
    assert.equal(
      impossible?.inventory.status,
      OnboardingInventoryStatus.Measured
    );
    if (impossible?.inventory.status !== OnboardingInventoryStatus.Measured) {
      return;
    }
    // The numerator alone is withdrawn: a figure this build cannot believe says
    // nothing about the byte total beside it.
    assert.equal(impossible.inventory.parsedBytes, undefined);
    assert.equal(impossible.inventory.eligibleParseBytes, 4096);
  });

  test("a payload from a main process that sends no parse position still parses whole", () => {
    // VERSION SKEW. The field is additive and optional, so an older main
    // degrades to the byte total and the estimate it already sent — the shape
    // every installed build emits until it updates.
    const parsed = parseOnboardingLocalState(measuredPayload());

    assert.equal(parsed?.inventory.status, OnboardingInventoryStatus.Measured);
    if (parsed?.inventory.status !== OnboardingInventoryStatus.Measured) {
      return;
    }
    assert.equal(parsed.inventory.parsedBytes, undefined);
    assert.equal(parsed.inventory.eligibleParseBytes, 4096);
  });

  test("a duplicate-harness session list withdraws the counts, keeping the measurement", () => {
    // A COLLECTION-level invariant no per-entry check can see: both rows are
    // individually valid. The fold sums its population in one pass, so both
    // would render AND both would land in the stated total — an inflated
    // headline over a duplicated source row. There is no way to tell which of
    // the two is the measurement, so neither is published.
    const parsed = parseOnboardingLocalState(
      measuredPayload({
        sessionsByHarness: [
          { harness: OnboardingHarness.Claude, sessionCount: 40 },
          { harness: OnboardingHarness.Claude, sessionCount: 3 },
        ],
      })
    );

    assert.equal(parsed?.inventory.status, OnboardingInventoryStatus.Measured);
    if (parsed?.inventory.status !== OnboardingInventoryStatus.Measured) {
      return;
    }
    assert.equal(parsed.inventory.sessionsByHarness, undefined);
    assert.equal(parsed.inventory.discoveredBytes, 4096);
  });

  test("two DIFFERENT harnesses in the session list are kept — the control for the duplicate case", () => {
    const parsed = parseOnboardingLocalState(
      measuredPayload({
        sessionsByHarness: [
          { harness: OnboardingHarness.Claude, sessionCount: 40 },
          { harness: OnboardingHarness.Codex, sessionCount: 3 },
        ],
      })
    );

    assert.equal(parsed?.inventory.status, OnboardingInventoryStatus.Measured);
    if (parsed?.inventory.status !== OnboardingInventoryStatus.Measured) {
      return;
    }
    assert.equal(parsed.inventory.sessionsByHarness?.length, 2);
  });

  test("a payload with no session-count field at all still parses — an older build's shape", () => {
    const parsed = parseOnboardingLocalState(measuredPayload());

    assert.equal(parsed?.inventory.status, OnboardingInventoryStatus.Measured);
    if (parsed?.inventory.status !== OnboardingInventoryStatus.Measured) {
      return;
    }
    assert.equal(Object.hasOwn(parsed.inventory, "sessionsByHarness"), false);
    assert.equal(parsed.inventory.discoveredBytes, 4096);
    assert.equal(parsed.inventory.eligibleParseBytes, 4096);
  });

  // The whole impossible set for a byte count, not just the two everyone
  // remembers. Each of these renders as a confident measurement if accepted.
  for (const [label, value] of [
    ["negative", -1],
    ["non-finite", Number.NaN],
    ["fractional", 1.5],
    ["past the safe-integer range", Number.MAX_SAFE_INTEGER + 2],
  ] as const) {
    test(`a ${label} byte count degrades to no measurement, never a clamped one`, () => {
      const parsed = parseOnboardingLocalState(
        measuredPayload({ discoveredBytes: value })
      );

      assert.notEqual(parsed, null, "the envelope is still usable");
      assert.equal(
        parsed?.inventory.status,
        OnboardingInventoryStatus.Unavailable,
        "an impossible byte count must not survive as a rendered total"
      );
      // Degraded, not clamped: a believable number nobody measured is the one
      // outcome worse than reporting nothing.
      assert.equal(
        Object.hasOwn(parsed?.inventory ?? {}, "discoveredBytes"),
        false
      );
    });
  }

  test("an unknown field from a newer main is tolerated, not rejected", () => {
    // Main and renderer ship together, but a renderer loaded from a newer main
    // during an in-place update sees fields it has never heard of. A strict
    // object would reject the WHOLE payload over one of them.
    const parsed = parseOnboardingLocalState({
      ...measuredPayload(),
      somethingTheFutureAdded: { nested: true },
    });

    assert.notEqual(parsed, null);
    assert.equal(parsed?.inventory.status, OnboardingInventoryStatus.Measured);
  });

  test("an older main that omits the optional identity still parses", () => {
    const payload = measuredPayload();
    payload.computeTargetId = undefined;

    const parsed = parseOnboardingLocalState(payload);

    assert.notEqual(parsed, null);
    assert.equal(parsed?.computeTargetId, undefined);
  });

  test("a null identity from a skewed peer degrades to absent, not to a value", () => {
    const parsed = parseOnboardingLocalState({
      ...measuredPayload(),
      computeTargetId: null,
    });

    assert.notEqual(parsed, null);
    assert.equal(Object.hasOwn(parsed ?? {}, "computeTargetId"), false);
  });

  test("an unavailable inventory parses without carrying any count", () => {
    const parsed = parseOnboardingLocalState({
      contractVersion: ONBOARDING_LOCAL_STATE_CONTRACT_VERSION,
      inventory: { status: OnboardingInventoryStatus.Unavailable },
      analysisEta: ETA,
    });

    assert.equal(
      parsed?.inventory.status,
      OnboardingInventoryStatus.Unavailable
    );
  });

  test("a payload from a future contract version is still read, not refused", () => {
    // The version is carried FOR the consumer to switch on. Refusing a payload
    // over it would be the strict-boundary defect in a different costume.
    const parsed = parseOnboardingLocalState({
      ...measuredPayload(),
      contractVersion: ONBOARDING_LOCAL_STATE_CONTRACT_VERSION + 1,
    });

    assert.notEqual(parsed, null);
    assert.equal(
      parsed?.contractVersion,
      ONBOARDING_LOCAL_STATE_CONTRACT_VERSION + 1
    );
  });

  test("a bad inventory withdraws the estimate that came with it", () => {
    // The ETA is DERIVED from the inventory, so an inventory that cannot be
    // believed must not leave a `complete` estimate standing beside it claiming
    // the analysis finished.
    const parsed = parseOnboardingLocalState({
      ...measuredPayload({ discoveredBytes: -1 }),
      analysisEta: { ...ETA, kind: AnalysisEtaKind.Complete },
    });

    assert.equal(
      parsed?.inventory.status,
      OnboardingInventoryStatus.Unavailable
    );
    assert.notEqual(
      parsed?.analysisEta.kind,
      AnalysisEtaKind.Complete,
      "a withdrawn measurement cannot leave a completion claim behind"
    );
  });

  test("salvage never fabricates the half a payload never had", () => {
    // Degrading an envelope that never carried an estimate would invent a
    // valid-looking answer out of garbage.
    assert.equal(
      parseOnboardingLocalState({
        contractVersion: ONBOARDING_LOCAL_STATE_CONTRACT_VERSION,
        inventory: { status: OnboardingInventoryStatus.Measured },
      }),
      null
    );
  });

  test("a measured ETA keeps every optional field across the boundary", () => {
    // A strict object would STRIP these, handing the renderer a three-key husk
    // typed as a full estimate — the ETA is half this payload's reason to exist.
    const parsed = parseOnboardingLocalState({
      ...measuredPayload(),
      analysisEta: {
        contractVersion: ANALYSIS_ETA_CONTRACT_VERSION,
        inventoryRevision: 3,
        kind: AnalysisEtaKind.Measured,
        remainingMs: 42_000,
        rawRemainingMs: 41_000,
        remainingBytes: 1024,
        throughputBytesPerMs: 2.5,
        confidence: "established",
        retainedSampleCount: 12,
        activeElapsedMs: 8000,
      },
    });

    assert.equal(parsed?.analysisEta.remainingMs, 42_000);
    assert.equal(parsed?.analysisEta.remainingBytes, 1024);
    assert.equal(parsed?.analysisEta.confidence, "established");
    assert.equal(parsed?.analysisEta.retainedSampleCount, 12);
  });

  test("an unrecognized ETA kind withdraws the estimate, keeping the inventory", () => {
    // A consumer switches on `kind`, so an arbitrary string reaching a four-way
    // switch is the silent-default hole. But a newer main naming a kind this
    // build has never heard of says nothing about the inventory beside it —
    // rejecting the whole payload would be the strict-boundary defect.
    const parsed = parseOnboardingLocalState({
      ...measuredPayload(),
      analysisEta: { ...ETA, kind: "something-the-future-added" },
    });

    assert.notEqual(parsed, null);
    assert.equal(parsed?.analysisEta.kind, AnalysisEtaKind.Unavailable);
    assert.equal(
      parsed?.inventory.status,
      OnboardingInventoryStatus.Measured,
      "a measurement this build CAN read must survive an estimate it cannot"
    );
  });

  test("a `measured` estimate missing the members it promises is withdrawn", () => {
    // The discriminator is not the contract on its own. `kind: "measured"` is a
    // promise that `remainingMs` and the rest are there to be read, and before
    // the per-kind check this husk reached the renderer typed as a full
    // estimate and would have rendered as a countdown.
    const parsed = parseOnboardingLocalState({
      ...measuredPayload(),
      analysisEta: {
        contractVersion: ANALYSIS_ETA_CONTRACT_VERSION,
        inventoryRevision: 3,
        kind: AnalysisEtaKind.Measured,
      },
    });

    assert.notEqual(parsed, null);
    assert.equal(parsed?.analysisEta.kind, AnalysisEtaKind.Unavailable);
    assert.equal(parsed?.analysisEta.remainingMs, undefined);
    assert.equal(
      parsed?.inventory.status,
      OnboardingInventoryStatus.Measured,
      "the measurement survives an estimate that could not be believed"
    );
  });

  test("a `measured` estimate carrying an impossible number is withdrawn", () => {
    for (const remainingMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const parsed = parseOnboardingLocalState({
        ...measuredPayload(),
        analysisEta: { ...MEASURED_ETA, remainingMs },
      });

      assert.equal(
        parsed?.analysisEta.kind,
        AnalysisEtaKind.Unavailable,
        `remainingMs ${String(remainingMs)} must not reach a countdown`
      );
    }
  });

  test("a well-formed `measured` estimate crosses intact", () => {
    // The counterfactual for the two cases above: the per-kind check must not
    // be withdrawing every measured estimate.
    const parsed = parseOnboardingLocalState({
      ...measuredPayload(),
      analysisEta: MEASURED_ETA,
    });

    assert.equal(parsed?.analysisEta.kind, AnalysisEtaKind.Measured);
    assert.equal(parsed?.analysisEta.remainingMs, 90_000);
  });

  test("a withdrawn estimate keeps the revision that ordered it", () => {
    // The renderer holds the highest ETA revision it has seen and drops
    // anything below it. Resetting a withdrawal to the sentinel would make this
    // payload read as older than the last good one, so the hook would drop it
    // and every later poll — frozen on a stale estimate rather than shown that
    // there is none.
    const parsed = parseOnboardingLocalState({
      ...measuredPayload(),
      analysisEta: { ...ETA, kind: "something-the-future-added" },
    });

    assert.equal(parsed?.analysisEta.inventoryRevision, 3);
  });

  test("an estimate and an inventory naming different sweeps withdraw together", () => {
    // One fact stated twice: the producer rebases the fold onto each new
    // inventory so they cannot diverge. A payload where they differ is skewed
    // or buggy, and neither half can vouch for the other.
    const parsed = parseOnboardingLocalState({
      ...measuredPayload(),
      analysisEta: { ...ETA, inventoryRevision: Number.MAX_SAFE_INTEGER },
    });

    assert.notEqual(parsed, null);
    assert.equal(
      parsed?.inventory.status,
      OnboardingInventoryStatus.Unavailable
    );
    assert.equal(parsed?.analysisEta.kind, AnalysisEtaKind.Unavailable);
    assert.equal(
      parsed?.analysisEta.inventoryRevision,
      0,
      "the sentinel, so the next coherent payload is not read as superseded"
    );
  });

  test("a `kind` naming a prototype member withdraws rather than throwing", () => {
    // The kind is an untrusted string used to select a per-kind schema. A plain
    // object indexed by it resolves `__proto__` to `Object.prototype`, which is
    // truthy and has no `safeParse`.
    const payload = JSON.parse(
      '{"kind":"__proto__","contractVersion":1,"inventoryRevision":3}'
    );

    const parsed = parseOnboardingLocalState({
      ...measuredPayload(),
      analysisEta: payload,
    });

    assert.equal(parsed?.analysisEta.kind, AnalysisEtaKind.Unavailable);
  });

  test("an `unavailable` estimate whose reason is a newer main's still crosses", () => {
    // Presence is the contract — the kind's whole meaning is that the reason
    // says why. The VALUE is not checked against the closed set: withdrawing an
    // unrecognized reason would substitute `progress-indeterminate`, a
    // different and specific claim about the parse lane.
    const parsed = parseOnboardingLocalState({
      ...measuredPayload(),
      analysisEta: {
        ...ETA,
        kind: AnalysisEtaKind.Unavailable,
        reason: "a-reason-the-future-added",
      },
    });

    assert.equal(parsed?.analysisEta.reason, "a-reason-the-future-added");
  });

  test("an `unavailable` estimate with no reason at all is withdrawn", () => {
    const parsed = parseOnboardingLocalState({
      ...measuredPayload(),
      analysisEta: {
        contractVersion: ANALYSIS_ETA_CONTRACT_VERSION,
        inventoryRevision: 3,
        kind: AnalysisEtaKind.Unavailable,
      },
    });

    assert.equal(
      parsed?.analysisEta.reason,
      AnalysisEtaUnavailableReason.ProgressIndeterminate
    );
  });

  test("a non-object and a structurally wrong payload are refused outright", () => {
    assert.equal(parseOnboardingLocalState(null), null);
    assert.equal(parseOnboardingLocalState("nope"), null);
    assert.equal(parseOnboardingLocalState({ contractVersion: 1 }), null);
  });
});
