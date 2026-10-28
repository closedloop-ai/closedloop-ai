/**
 * @file onboarding-local-state-source.test.ts
 * @description ISS-8376 — the snapshot source's honesty branches.
 *
 * The source is electron-free precisely so these run under `test:node`: the
 * pre-sweep branch is the one EVERY machine takes for the first seconds of
 * onboarding, and `transcript-sync-lane-absent-status.ts` records why a branch
 * that can only be read and not executed is not covered at all.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  createOnboardingLocalStateSource,
  INVENTORY_PROJECTION_WITNESS,
} from "../src/main/onboarding/onboarding-local-state-source.js";
import {
  type TranscriptByteInventory,
  TranscriptHarnessOutcome,
  TranscriptInventoryCompleteness,
} from "../src/main/transcript-sync/transcript-byte-inventory-types.js";
import { TranscriptSourceHarness } from "../src/main/transcript-sync/transcript-sync-types.js";
import {
  ONBOARDING_INVENTORY_NO_REVISION,
  ONBOARDING_LOCAL_STATE_CONTRACT_VERSION,
  OnboardingHarness,
  OnboardingInventoryStatus,
} from "../src/shared/onboarding-local-state-contract.js";
import {
  AnalysisEtaKind,
  AnalysisEtaUnavailableReason,
} from "../src/shared/transcript-analysis-eta-contract.js";

const NEVER = () =>
  new Promise<TranscriptByteInventory | null>(() => undefined);

function inventoryAt(
  inventoryRevision: number,
  overrides: Partial<TranscriptByteInventory> = {}
): TranscriptByteInventory {
  return {
    inventoryRevision,
    parseCompleteness: TranscriptInventoryCompleteness.Complete,
    uploadCompleteness: TranscriptInventoryCompleteness.Complete,
    evidence: [
      {
        harness: TranscriptSourceHarness.Claude,
        outcome: TranscriptHarnessOutcome.Measured,
      },
    ],
    impairments: [],
    enumeratedHarnesses: [TranscriptSourceHarness.Claude],
    discoveredBytes: 2048,
    eligibleParseBytes: 2048,
    excludedBytes: 0,
    exclusionsByReason: {} as TranscriptByteInventory["exclusionsByReason"],
    physicalBytes: 2048,
    attributableRawBytes: 2048,
    eligibleFiles: [],
    sessionsByHarness: [],
    uploadExclusionsByReason:
      {} as TranscriptByteInventory["uploadExclusionsByReason"],
    ...overrides,
  };
}

function makeSource(
  runSweep: (stateDir: string) => Promise<TranscriptByteInventory | null>,
  getComputeTargetId: () => string | null = () => "ct-01"
) {
  return createOnboardingLocalStateSource({
    transcriptStateDir: () => "/tmp/iss-8376",
    getComputeTargetId,
    runSweep,
  });
}

describe("onboarding local-state source (ISS-8376)", () => {
  test("a read before the sweep lands reports no measurement, never a zero", () => {
    const snapshot = makeSource(NEVER).read();

    assert.equal(
      snapshot.contractVersion,
      ONBOARDING_LOCAL_STATE_CONTRACT_VERSION
    );
    assert.equal(
      snapshot.inventory.status,
      OnboardingInventoryStatus.Unavailable
    );
    // A byte total of 0 here would be a measurement nobody took.
    assert.equal(Object.hasOwn(snapshot.inventory, "discoveredBytes"), false);
    assert.equal(snapshot.analysisEta.kind, AnalysisEtaKind.Unavailable);
    assert.equal(
      snapshot.analysisEta.reason,
      AnalysisEtaUnavailableReason.ProgressIndeterminate
    );
  });

  test("the pre-sweep revision is a sentinel a real inventory always outranks", async () => {
    // The hazard this pins: minting a revision per read would burn the shared
    // monotone counter, and the real inventory would then arrive carrying a
    // LOWER revision than the renderer had already accepted — dropped for ever
    // by the hook's stale-revision guard in `describesCurrentRead`.
    const source = makeSource(async () => inventoryAt(1));

    const before = source.read();
    assert.equal(
      before.analysisEta.inventoryRevision,
      ONBOARDING_INVENTORY_NO_REVISION
    );

    await Promise.resolve();
    await Promise.resolve();
    const after = source.read();

    assert.ok(
      after.analysisEta.inventoryRevision >
        before.analysisEta.inventoryRevision,
      "the real inventory must outrank the pre-sweep sentinel"
    );
  });

  test("the sweep runs at most once, however many times it is read", async () => {
    let sweeps = 0;
    const source = makeSource(() => {
      sweeps += 1;
      return Promise.resolve(inventoryAt(1));
    });

    source.read();
    source.read();
    await Promise.resolve();
    source.read();
    source.read();

    // The sweep costs 638 ms at 10k entries and ~4 s at the cap; a per-read
    // sweep is the whole cost this design exists to pay exactly once.
    assert.equal(sweeps, 1);
  });

  test("a sweep that cannot measure degrades to no measurement, not a zero", async () => {
    const source = makeSource(async () => null);

    source.read();
    await Promise.resolve();
    await Promise.resolve();
    const snapshot = source.read();

    assert.equal(
      snapshot.inventory.status,
      OnboardingInventoryStatus.Unavailable
    );
    assert.equal(snapshot.analysisEta.kind, AnalysisEtaKind.Unavailable);
  });

  test("a sweep that rejects is contained and still answers", async () => {
    const source = makeSource(() => Promise.reject(new Error("worker died")));

    source.read();
    await Promise.resolve();
    await Promise.resolve();
    const snapshot = source.read();

    assert.equal(
      snapshot.inventory.status,
      OnboardingInventoryStatus.Unavailable
    );
  });

  test("a measured sweep is projected, and the two revisions agree", async () => {
    const source = makeSource(async () => inventoryAt(4));

    source.read();
    await Promise.resolve();
    await Promise.resolve();
    const snapshot = source.read();

    assert.equal(snapshot.inventory.status, OnboardingInventoryStatus.Measured);
    if (snapshot.inventory.status !== OnboardingInventoryStatus.Measured) {
      return;
    }
    assert.equal(snapshot.inventory.discoveredBytes, 2048);
    assert.equal(snapshot.inventory.inventoryRevision, 4);
    // The fold closes over the revision for its whole life, so a payload whose
    // inventory and ETA name different sweeps means the fold was never rebased.
    assert.equal(
      snapshot.analysisEta.inventoryRevision,
      snapshot.inventory.inventoryRevision
    );
  });

  test("the measured payload carries exactly the keys the witness names", async () => {
    // Ties the compile-time witness to the RUNTIME payload. The witness alone
    // proves the projection accounts for every producer field; this proves the
    // projection actually emits them, so a key named in the witness and then
    // dropped from `projectInventory` cannot pass unnoticed.
    const source = makeSource(() => Promise.resolve(inventoryAt(1)));
    source.read();
    await Promise.resolve();
    await Promise.resolve();

    const { inventory } = source.read();

    assert.deepEqual(
      Object.keys(inventory)
        .filter((key) => key !== "status")
        .sort(),
      Object.keys(INVENTORY_PROJECTION_WITNESS).sort()
    );
  });

  test("the projection drops the fields that are user data or diagnostic", async () => {
    const source = makeSource(async () => inventoryAt(1));
    source.read();
    await Promise.resolve();
    await Promise.resolve();

    const { inventory } = source.read();

    for (const omitted of [
      "eligibleFiles",
      "impairments",
      "exclusionsByReason",
      "uploadExclusionsByReason",
    ]) {
      assert.equal(
        Object.hasOwn(inventory, omitted),
        false,
        `${omitted} must not cross the wire`
      );
    }
  });

  test("the malformed-reply reporter reaches the sweep runner", async () => {
    // The one hop a stubbed `runSweep` would otherwise hide. Without it the
    // reporter is wired at the composition root, threaded through this source,
    // and dropped here — and the only symptom is a monitor that stays silent
    // while onboarding is permanently unmeasured.
    const reported: string[] = [];
    const source = createOnboardingLocalStateSource({
      transcriptStateDir: () => "/tmp/iss-8376",
      getComputeTargetId: () => "ct-01",
      runSweep: (_stateDir, options) => {
        options.onMalformedReply?.();
        return Promise.resolve(null);
      },
      onMalformedSweepReply: () => reported.push("malformed"),
    });

    source.read();
    await Promise.resolve();

    assert.deepEqual(reported, ["malformed"]);
  });

  test("with no byte-movement producer the estimate is exactly three states", async () => {
    // WITHOUT `readParseProgress` — the shape this source had until ISS-8346
    // gave the fold a producer, and still the shape on any composition that
    // omits the dep. Nothing reports movement, so `measured` is unreachable
    // here and no case in this block may imply otherwise. The wired transport
    // is the sibling block below, which is where a minute count is earned
    // rather than fabricated.
    const served = async (
      overrides: Partial<TranscriptByteInventory>
    ): Promise<string> => {
      const source = makeSource(async () => inventoryAt(1, overrides));
      source.read();
      await Promise.resolve();
      await Promise.resolve();
      return source.read().analysisEta.kind;
    };

    // A lane that measured nothing has no denominator to divide.
    assert.equal(
      await served({
        parseCompleteness: TranscriptInventoryCompleteness.Unavailable,
      }),
      AnalysisEtaKind.Unavailable
    );
    // ISS-8346 ruling 2026-09-04: a lane that measured SOME of the corpus does
    // have a denominator, so it serves the same state a whole lane serves. This
    // is the defect the ruling names — one impaired probe used to drop the
    // estimate sentence, the percentage and the completion title.
    assert.equal(
      await served({
        parseCompleteness: TranscriptInventoryCompleteness.Partial,
      }),
      AnalysisEtaKind.Calculating
    );
    // A REAL completion: the lane is whole and there is nothing to parse.
    assert.equal(
      await served({ eligibleParseBytes: 0 }),
      AnalysisEtaKind.Complete
    );
    // Bytes to parse, no movement reported yet. Distinct from a `remainingMs`
    // of 0 — "we do not know yet" and "there is almost none left" are the two
    // facts the whole ETA ticket exists to keep apart.
    assert.equal(await served({}), AnalysisEtaKind.Calculating);
  });

  test("the projection maps sessionsByHarness through the wire harness vocabulary", async () => {
    const source = makeSource(async () =>
      inventoryAt(1, {
        sessionsByHarness: [
          { harness: TranscriptSourceHarness.Codex, sessionCount: 3 },
        ],
      })
    );

    source.read();
    await Promise.resolve();
    await Promise.resolve();
    const snapshot = source.read();

    assert.equal(snapshot.inventory.status, OnboardingInventoryStatus.Measured);
    if (snapshot.inventory.status !== OnboardingInventoryStatus.Measured) {
      return;
    }
    assert.deepEqual(snapshot.inventory.sessionsByHarness, [
      { harness: OnboardingHarness.Codex, sessionCount: 3 },
    ]);
  });

  test("an absent compute target is omitted, and an attemptId is echoed", () => {
    const source = makeSource(NEVER, () => null);

    const snapshot = source.read("attempt-9");

    assert.equal(Object.hasOwn(snapshot, "computeTargetId"), false);
    assert.equal(snapshot.attemptId, "attempt-9");
  });
});
