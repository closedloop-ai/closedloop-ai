/**
 * @file onboarding-local-state-byte-movement.test.ts
 * @description ISS-8346 — the onboarding source WITH a byte-movement producer.
 *
 * A sibling of `onboarding-local-state-source.test.ts` rather than more cases in
 * it: that suite pins what the source can say when NOTHING reports movement, and
 * it is already past the file-size smell. This one is the wired transport — the
 * boot import is the parse lane the estimate measures, and the sentence the
 * onboarding screen renders ("estimated to take N minutes") exists only if a
 * number gets here. Every case drives the real fold rather than asserting a call
 * was made.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createOnboardingLocalStateSource } from "../src/main/onboarding/onboarding-local-state-source.js";
import type { TranscriptByteInventory } from "../src/main/transcript-sync/transcript-byte-inventory-types.js";
import { TranscriptSourceHarness } from "../src/main/transcript-sync/transcript-sync-types.js";
import {
  OnboardingInventoryStatus,
  type OnboardingInventoryWire,
  type OnboardingLocalStateWire,
} from "../src/shared/onboarding-local-state-contract.js";
import {
  AnalysisEtaKind,
  AnalysisEtaUnavailableReason,
  AnalysisParserActivity,
} from "../src/shared/transcript-analysis-eta-contract.js";
import {
  inventory as etaInventory,
  testClock,
} from "./transcript-analysis-eta-fixtures.js";

/** The measured arm, so a case reads the numerator without re-narrowing it. */
function measuredInventoryOf(
  snapshot: OnboardingLocalStateWire
): Extract<
  OnboardingInventoryWire,
  { status: typeof OnboardingInventoryStatus.Measured }
> {
  if (snapshot.inventory.status !== OnboardingInventoryStatus.Measured) {
    throw new Error(
      `expected a measured inventory, got ${snapshot.inventory.status}`
    );
  }
  return snapshot.inventory;
}

describe("onboarding local-state source: byte movement (ISS-8346)", () => {
  const CORPUS_BYTES = 10_000_000;
  /** Seven samples at 400 B/ms clears the sample, span and volume floors. */
  const SAMPLE_COUNT = 7;
  const SAMPLE_BYTES = 200_000;
  const SAMPLE_MS = 500;

  async function drivenSource(
    overrides: Partial<TranscriptByteInventory> = {}
  ) {
    const clock = testClock();
    const inventory: TranscriptByteInventory = {
      ...etaInventory({ eligibleParseBytes: CORPUS_BYTES }),
      ...overrides,
    };
    const askedWith: (readonly TranscriptSourceHarness[])[] = [];
    let remainingBytes: number | null = inventory.eligibleParseBytes;
    let activity: AnalysisParserActivity = AnalysisParserActivity.Running;
    const source = createOnboardingLocalStateSource({
      analysisEtaDeps: { clock: clock.clock },
      getComputeTargetId: () => "ct-01",
      readParseProgress: (harnesses) => {
        askedWith.push(harnesses);
        return { activity, remainingBytes };
      },
      runSweep: async () => inventory,
      transcriptStateDir: () => "/tmp/iss-8346",
    });
    source.read();
    await Promise.resolve();
    await Promise.resolve();
    return {
      askedWith,
      /** One read at the current remainder; the fold's anchor comes from it. */
      read: () => source.read(),
      /** Advance the clock and land `SAMPLE_BYTES` of parsed transcript. */
      step: () => {
        clock.advance(SAMPLE_MS);
        if (remainingBytes !== null) {
          remainingBytes -= SAMPLE_BYTES;
        }
        return source.read();
      },
      setActivity: (next: AnalysisParserActivity) => {
        activity = next;
      },
      setRemaining: (next: number | null) => {
        remainingBytes = next;
      },
    };
  }

  test("a machine mid-import earns a measured minute count", async () => {
    // THE DEFECT, pinned: before this wiring the fold had no `report` caller at
    // all, so an eight-minute live run saw the store's analyzed count climb by
    // 425 sessions while the estimate never left `calculating`.
    const driven = await drivenSource();

    assert.equal(driven.read().analysisEta.kind, AnalysisEtaKind.Calculating);
    let snapshot = driven.read();
    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      snapshot = driven.step();
    }

    assert.equal(snapshot.analysisEta.kind, AnalysisEtaKind.Measured);
    if (snapshot.analysisEta.kind !== AnalysisEtaKind.Measured) {
      return;
    }
    assert.equal(
      snapshot.analysisEta.remainingBytes,
      CORPUS_BYTES - SAMPLE_COUNT * SAMPLE_BYTES,
      "the remainder is the corpus minus what the importer actually landed"
    );
    const { remainingMs } = snapshot.analysisEta;
    assert.ok(
      typeof remainingMs === "number" && remainingMs > 0,
      `a stated estimate is a real duration: ${JSON.stringify(snapshot.analysisEta)}`
    );
  });

  test("the estimate completes once the importer has nothing left to parse", async () => {
    const driven = await drivenSource();
    driven.read();

    driven.setRemaining(0);

    assert.equal(driven.read().analysisEta.kind, AnalysisEtaKind.Complete);
  });

  test("an already-imported machine completes without ever being measured", async () => {
    // No pass opens because no source is pending, so the producer answers 0 from
    // its first read. There is no movement to sample and none is needed.
    const driven = await drivenSource();
    driven.setRemaining(0);

    assert.equal(driven.read().analysisEta.kind, AnalysisEtaKind.Complete);
  });

  test("a remainder nobody measured withdraws the estimate instead of completing it", async () => {
    // The false completion this whole path is built to refuse: `null` means the
    // producer could not state a number, NOT that there is nothing left.
    const driven = await drivenSource();
    driven.read();

    driven.setRemaining(null);
    const snapshot = driven.read();

    assert.equal(snapshot.analysisEta.kind, AnalysisEtaKind.Unavailable);
    assert.equal(
      snapshot.analysisEta.reason,
      AnalysisEtaUnavailableReason.ProgressIndeterminate
    );
  });

  test("the estimate recovers once a withdrawn remainder becomes measurable", async () => {
    // THE ORDINARY BOOT SEQUENCE, and the one a latched withdrawal would break:
    // the onboarding screen is read before the collectors open a pass, so the
    // first answers are `null`. The estimate must still reach a minute count
    // once the import starts reporting.
    const driven = await drivenSource();
    driven.setRemaining(null);
    assert.equal(driven.read().analysisEta.kind, AnalysisEtaKind.Unavailable);

    driven.setRemaining(CORPUS_BYTES);
    assert.equal(driven.read().analysisEta.kind, AnalysisEtaKind.Calculating);

    let snapshot = driven.read();
    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      snapshot = driven.step();
    }

    assert.equal(snapshot.analysisEta.kind, AnalysisEtaKind.Measured);
  });

  test("the inventory carries the parse lane's own position from the first read, while the estimate is still calculating (ISS-10624)", async () => {
    // THE DEFECT, pinned on the PRODUCER side: the numerator used to leave this
    // process only as `AnalysisEtaWire.remainingBytes`, which only a `measured`
    // estimate carries — so for the whole calculating window the renderer held
    // `eligibleParseBytes` and nothing to divide into it, and the onboarding
    // bar hatched indefinitely over a percentage that was computable all along.
    const driven = await drivenSource();

    const first = driven.read();
    assert.equal(first.analysisEta.kind, AnalysisEtaKind.Calculating);
    assert.equal(measuredInventoryOf(first).parsedBytes, 0);

    const moved = driven.step();
    // Still no TIME, and now a real position: that pair is the whole point.
    assert.equal(moved.analysisEta.kind, AnalysisEtaKind.Calculating);
    assert.equal(measuredInventoryOf(moved).parsedBytes, SAMPLE_BYTES);
    assert.equal(measuredInventoryOf(moved).eligibleParseBytes, CORPUS_BYTES);
  });

  test("no position is transported when the lane cannot state one", async () => {
    // Absence means NOT REPORTED on the receiving side, so a stale high-water
    // number here would re-state a position the lane just declined to state,
    // and a `0` would claim the importer has done nothing.
    const driven = await drivenSource();
    driven.step();
    assert.equal(measuredInventoryOf(driven.read()).parsedBytes, SAMPLE_BYTES);

    driven.setRemaining(null);
    const withdrawn = driven.read();

    assert.equal(
      Object.hasOwn(measuredInventoryOf(withdrawn), "parsedBytes"),
      false
    );
  });

  test("a paused import stops the countdown and says so", async () => {
    const driven = await drivenSource();
    driven.read();

    driven.setActivity(AnalysisParserActivity.Paused);
    const snapshot = driven.read();

    assert.equal(snapshot.analysisEta.kind, AnalysisEtaKind.Unavailable);
    assert.equal(
      snapshot.analysisEta.reason,
      AnalysisEtaUnavailableReason.Paused
    );
  });

  test("a failed import stops the countdown and says so", async () => {
    const driven = await drivenSource();
    driven.read();

    driven.setActivity(AnalysisParserActivity.Failed);
    const snapshot = driven.read();

    assert.equal(snapshot.analysisEta.kind, AnalysisEtaKind.Unavailable);
    assert.equal(
      snapshot.analysisEta.reason,
      AnalysisEtaUnavailableReason.Failed
    );
  });

  test("the producer is asked only about the harnesses the sweep counted", async () => {
    // A harness outside the inventory — Cursor, Copilot — would subtract bytes
    // from a total that never included them and push the parsed figure past the
    // corpus, which the countability guard then withdraws entirely.
    const driven = await drivenSource({
      enumeratedHarnesses: [
        TranscriptSourceHarness.Claude,
        TranscriptSourceHarness.Codex,
      ],
    });
    driven.read();

    assert.ok(driven.askedWith.length > 0, "the producer was asked at all");
    for (const harnesses of driven.askedWith) {
      assert.deepEqual(
        [...harnesses],
        [TranscriptSourceHarness.Claude, TranscriptSourceHarness.Codex]
      );
    }
  });

  test("a remainder larger than the corpus never reports negative progress", async () => {
    // The two figures come from different enumerations, so the importer can
    // legitimately have more bytes pending than the sweep measured. That is a
    // disagreement, not a negative amount of work.
    const driven = await drivenSource();

    driven.setRemaining(CORPUS_BYTES * 2);
    const snapshot = driven.read();

    assert.equal(snapshot.analysisEta.kind, AnalysisEtaKind.Calculating);
  });

  test("progress never walks backwards when the pending set grows", async () => {
    // A cooperative re-entry that discovers new files RAISES the remainder. The
    // parse lane's high-water mark is what keeps the bar from reversing, and it
    // is why this source reports through that fold instead of dividing here.
    const driven = await drivenSource();
    driven.read();
    driven.setRemaining(CORPUS_BYTES / 2);
    const halfway = driven.read();

    driven.setRemaining(CORPUS_BYTES - 1);
    const afterDiscovery = driven.read();

    assert.equal(halfway.analysisEta.kind, AnalysisEtaKind.Calculating);
    assert.equal(afterDiscovery.analysisEta.kind, AnalysisEtaKind.Calculating);
    assert.equal(
      afterDiscovery.analysisEta.inventoryRevision,
      halfway.analysisEta.inventoryRevision
    );
  });
});
