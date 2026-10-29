/**
 * @file sync-burndown-dead-lettered-basis.test.ts
 * @description ISS-9744 — `deadLetteredCount` must say WHAT it counted.
 *
 * The field carried two incompatible quantities under one name. The outbox
 * lanes report a point-in-time `GROUP BY status` row count; `component_inventory`
 * reports the length of the durable abandoned-id list on its cursor row; and a
 * lane with no dead-letter state at all reports a structural `0`.
 * A reader who could not tell them apart read the outbox number as "items
 * permanently lost" — which it is not, because a redrive re-pends those rows and
 * the number GOES DOWN (observed 13 -> 7 -> 5 on `invocation_parts`).
 *
 * The non-monotonicity is the proof and is the property this file pins: a count
 * that decreases cannot be a loss tally. A single snapshot cannot tell the two
 * quantities apart, so every case here drives the reporter across CONSECUTIVE
 * samples through its real store shape.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { SyncBurndownStoreSample } from "../src/main/database/sync-burndown-store.js";
import {
  CloudReadDeadLetteredBasis,
  CloudSyncBacklogState,
  resolveCloudSyncBacklog,
  totalCloudReadDeadLettered,
  unknownCloudReadReadiness,
} from "../src/shared/cloud-read-readiness-contract.js";
import {
  classifyLaneDrainState,
  SyncLaneDeadLetteredBasis,
  SyncLaneDrainState,
  SyncLaneId,
  SyncLaneRemainderBasis,
} from "../src/shared/sync-burndown-contract.js";
import {
  burndownLane,
  burndownSnapshot,
  projectConsentedReadiness,
} from "./helpers/sync-burndown-fixtures.js";
import {
  buildHarness,
  COMPONENT_KEY,
  emptySample,
  type LoggedLine,
} from "./sync-burndown-reporter-harness.js";

/** The clause the burn-down line carries for an outbox lane's abandoned rows. */
const OUTBOX_BASIS_RE = /deadLettered=(\d+) \(queue_status_count\)/;

/**
 * The per-lane BURN-DOWN lines, in emission order. Filtered to the lines that
 * actually carry the count: a lane also emits stall and verdict lines, and an
 * `.every()` over those would pass for the wrong reason.
 */
function laneLines(lines: LoggedLine[], lane: string): string[] {
  return lines
    .map((line) => line.message)
    .filter(
      (message) =>
        message.startsWith(`[${lane}]`) && message.includes("deadLettered=")
    );
}

/** Every `deadLettered=N (queue_status_count)` value the lane's lines reported. */
function outboxDeadLetteredSeries(lines: LoggedLine[], lane: string): number[] {
  const series: number[] = [];
  for (const message of laneLines(lines, lane)) {
    const match = OUTBOX_BASIS_RE.exec(message);
    if (match?.[1] !== undefined) {
      series.push(Number(match[1]));
    }
  }
  return series;
}

/**
 * The invocation outbox with a live backlog and `deadLettered` rows. Depth stays
 * FLAT across samples on purpose: the only thing moving is the dead-letter
 * count, so nothing else can explain the series the assertions read.
 */
function invocationSample(deadLettered: number): SyncBurndownStoreSample {
  const sample = emptySample();
  sample.invocationOutbox.pending = 4;
  sample.invocationOutbox.readyPending = 4;
  sample.invocationOutbox.pendingParts = 4;
  sample.invocationOutbox.deadLettered = deadLettered;
  sample.invocationOutbox.oldestPendingSinceIso = "2026-08-06T11:00:00.000Z";
  return sample;
}

/**
 * What the store hands back when a lane has NO source key: the scoped reads
 * never run, so every one of these zeros is a placeholder rather than a
 * measurement — `readSessionOutbox` is skipped, `readInvocationCounts` returns
 * its offline zeros, and `readComponentInventoryCounts` returns a `null`
 * remainder. The routine lane keeps its own source key and still measures,
 * which is what makes the two kinds of `deadLettered=0` comparable in one
 * sample.
 */
function unscopedSample(): SyncBurndownStoreSample {
  const sample = emptySample();
  // ISS-10082: the outbox lanes report the placeholder as a placeholder too, so
  // this fixture models a shape the production store can actually return. Left
  // at `Counted` it pinned the unread session lane at `itemsRemaining: 0` →
  // `Drained`, documenting as correct the very classification ISS-10082 removes.
  sample.sessionOutbox.remainderBasis = SyncLaneRemainderBasis.Unqueried;
  sample.invocationOutbox.remainderBasis = SyncLaneRemainderBasis.Unqueried;
  sample.componentInventory = {
    rowsRemaining: null,
    deadLetteredCount: 0,
    remainderBasis: SyncLaneRemainderBasis.Unqueried,
  };
  return sample;
}

/** The component lane sweeping with a frozen durable cursor and abandoned ids. */
function componentSample(deadLetteredCount: number): SyncBurndownStoreSample {
  const sample = emptySample();
  sample.componentInventory = {
    rowsRemaining: 12,
    deadLetteredCount,
    remainderBasis: SyncLaneRemainderBasis.Counted,
  };
  sample.cursorsBySourceKey = {
    [COMPONENT_KEY]: {
      sourceKey: COMPONENT_KEY,
      observedTopUpdatedAt: "2026-08-03T20:56:53.196Z",
      observedIdsAtTopUpdatedAt: [],
      deadLetteredIds: [],
      updatedAt: "2026-08-03T20:57:50.000Z",
      dataRevision: 65,
    },
  };
  return sample;
}

describe("ISS-9744: the burn-down states which quantity deadLetteredCount is", () => {
  it("reports an outbox count that FALLS between samples, still labelled a live status count", async () => {
    // The redrive shape. `invocation-sync-validation-redrive.ts` selects
    // `status = 'dead_lettered'` and re-clones those sessions, so rows LEAVE the
    // status and the count drops. A reader told only "15 dead-lettered" concludes
    // 15 items are lost; the basis is what stops that reading.
    const harness = buildHarness({ sample: invocationSample(13) });
    harness.reporter.start();
    await harness.reporter.sampleOnce();
    harness.setSample(invocationSample(7));
    await harness.reporter.sampleOnce();
    harness.setSample(invocationSample(5));
    await harness.reporter.sampleOnce();
    harness.reporter.stop();

    assert.deepEqual(
      outboxDeadLetteredSeries(harness.lines, SyncLaneId.InvocationParts),
      [13, 7, 5],
      "the reported count must follow the population DOWN — a gauge, not a tally"
    );
  });

  it("keeps the outbox basis fixed while the count moves, so the two cannot be confused", async () => {
    // The basis describes the MEASUREMENT, not the value. If it tracked the
    // number it would be decoration; pinning it across a falling series is what
    // makes it a contract a consumer can group by.
    const harness = buildHarness({ sample: invocationSample(13) });
    harness.reporter.start();
    await harness.reporter.sampleOnce();
    harness.setSample(invocationSample(5));
    await harness.reporter.sampleOnce();
    harness.reporter.stop();

    const lines = laneLines(harness.lines, SyncLaneId.InvocationParts);
    assert.equal(lines.length, 2);
    assert.ok(
      lines.every((message) =>
        message.includes(`(${SyncLaneDeadLetteredBasis.QueueStatusCount})`)
      ),
      "both samples must name the same basis"
    );
  });

  it("carries the outbox basis on the MONITORED stall, not only in the log line", async () => {
    // The alert is where the misreading happened: `describeStall` puts this
    // number in the operator sentence. A basis that reaches the log and not the
    // stall sink leaves the dashboard exactly as undimensioned as before.
    const harness = buildHarness({ sample: invocationSample(13) });
    harness.reporter.start();
    // NO_PROGRESS_STALL_SAMPLES consecutive zero-work samples arm the alert, by
    // which point the count has already fallen twice.
    await harness.reporter.sampleOnce();
    harness.setSample(invocationSample(7));
    await harness.reporter.sampleOnce();
    harness.setSample(invocationSample(5));
    await harness.reporter.sampleOnce();
    harness.reporter.stop();

    const stall = harness.stalls.find(
      (report) => report.lane === SyncLaneId.InvocationParts
    );
    assert.ok(stall, "the no-progress stall must reach the monitored sink");
    assert.equal(stall.deadLetteredCount, 5);
    assert.equal(
      stall.deadLetteredBasis,
      SyncLaneDeadLetteredBasis.QueueStatusCount
    );
  });

  it("reports the component lane's durable abandoned-id ledger as its own basis", async () => {
    // The other half of the collapse. This count is `deadLetteredIds.length` off
    // the persisted cursor row, not a status count over a queue table — a
    // different population entirely, which is why summing the two across lanes
    // was adding unlike things.
    const harness = buildHarness({ sample: componentSample(4) });
    harness.reporter.start();
    harness.reporter.recordComponentRecordsSent(50);
    await harness.reporter.sampleOnce();
    harness.reporter.recordComponentRecordsSent(50);
    await harness.reporter.sampleOnce();
    harness.reporter.stop();

    const lines = laneLines(harness.lines, SyncLaneId.ComponentInventory);
    assert.ok(lines.length > 0);
    assert.ok(
      lines.every((message) =>
        message.includes(
          `deadLettered=4 (${SyncLaneDeadLetteredBasis.AbandonedIdLedger})`
        )
      ),
      "the ledger lane must never be labelled a queue status count"
    );

    const stall = harness.stalls.find(
      (report) => report.lane === SyncLaneId.ComponentInventory
    );
    assert.ok(stall, "the cursor stall must reach the monitored sink");
    assert.equal(
      stall.deadLetteredBasis,
      SyncLaneDeadLetteredBasis.AbandonedIdLedger
    );
  });

  it("reports UNMEASURED for a lane whose store read was never scoped to a key", async () => {
    // The offline/unpaired install. With a null source key the store
    // short-circuits before it queries anything and hands back placeholder
    // zeros — labelling those as a queue status count or a durable ledger
    // asserts a read that never happened, on exactly the machine the gate-shut
    // alert is about. `0` here means "nobody looked", not "nothing was
    // abandoned".
    const harness = buildHarness({ sample: unscopedSample() });
    harness.setSourceKeys({ session: null, invocation: null, component: null });
    harness.reporter.start();
    await harness.reporter.sampleOnce();
    harness.reporter.stop();

    for (const lane of [
      SyncLaneId.SessionMetadata,
      SyncLaneId.InvocationParts,
      SyncLaneId.ComponentInventory,
    ]) {
      const lines = laneLines(harness.lines, lane);
      assert.ok(lines.length > 0, `no burn-down line for ${lane}`);
      assert.ok(
        lines.every((message) =>
          message.includes(`(${SyncLaneDeadLetteredBasis.Unmeasured})`)
        ),
        `${lane} must not claim a measurement it never took`
      );
    }
  });

  it("keeps UNMEASURED apart from a lane that looked and counted zero", async () => {
    // Both print `deadLettered=0`, and they are different facts: the session
    // lane QUERIED its outbox and found none dead-lettered, while an unscoped
    // outbox lane may be holding plenty that nobody counted. Collapsing the two
    // is the same class of error the basis exists to end.
    const harness = buildHarness({ sample: unscopedSample() });
    harness.setSourceKeys({ invocation: null });
    harness.reporter.start();
    await harness.reporter.sampleOnce();
    harness.reporter.stop();

    const invocation = laneLines(harness.lines, SyncLaneId.InvocationParts);
    const session = laneLines(harness.lines, SyncLaneId.SessionMetadata);
    assert.ok(invocation.length > 0 && session.length > 0);
    assert.ok(
      invocation.every((message) =>
        message.includes(
          `deadLettered=0 (${SyncLaneDeadLetteredBasis.Unmeasured})`
        )
      )
    );
    assert.ok(
      session.every((message) =>
        message.includes(
          `deadLettered=0 (${SyncLaneDeadLetteredBasis.QueueStatusCount})`
        )
      )
    );
  });
});

/**
 * ISS-9744 (codex review on #6874) — the basis has to SURVIVE the renderer
 * projection, and a cross-lane total has to reconcile the bases rather than
 * inherit one.
 *
 * A distinction that holds in `sync-burndown-contract.ts` and dies in
 * `cloud-read-readiness-contract.ts` is not a distinction any reader ever sees:
 * `projectLane` is the only thing between the lane's own answer and the
 * whole-app number the Connection Status cell prints.
 *
 * Every case here is MULTI-LANE on purpose. One lane cannot tell a preserved
 * basis from a hardcoded one — with a single row, "carry the lane's value" and
 * "always say queue_status_count" produce identical output — so a single-lane
 * case would stay green against the exact regression this pins.
 */
describe("ISS-9744: the readiness projection preserves the dead-letter basis", () => {
  it("carries EACH lane's own basis through, not one lane's answer for all", () => {
    const projected = projectConsentedReadiness({
      importComplete: true,
      snapshot: burndownSnapshot([
        burndownLane({
          lane: SyncLaneId.InvocationParts,
          state: SyncLaneDrainState.DrainedWithDeadLetters,
          deadLetteredCount: 5,
          deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
        }),
        burndownLane({
          lane: SyncLaneId.ComponentInventory,
          state: SyncLaneDrainState.DrainedWithDeadLetters,
          deadLetteredCount: 4,
          deadLetteredBasis: SyncLaneDeadLetteredBasis.AbandonedIdLedger,
        }),
        burndownLane({
          lane: SyncLaneId.TranscriptArchive,
          deadLetteredBasis: SyncLaneDeadLetteredBasis.NoDeadLetterState,
        }),
      ]),
    });

    assert.deepEqual(
      projected.lanes.map((lane) => [lane.lane, lane.deadLetteredBasis]),
      [
        [
          SyncLaneId.InvocationParts,
          SyncLaneDeadLetteredBasis.QueueStatusCount,
        ],
        [
          SyncLaneId.ComponentInventory,
          SyncLaneDeadLetteredBasis.AbandonedIdLedger,
        ],
        [
          SyncLaneId.TranscriptArchive,
          SyncLaneDeadLetteredBasis.NoDeadLetterState,
        ],
      ],
      "the projection must not relabel a lane's count as a population it never counted"
    );
  });

  it("reports a structural zero beside an UNREAD lane as a floor, not a measured total", () => {
    // The reconciliation this whole thread is about. One lane reports the
    // structural basis, so its `0` is certain; the unpaired session lane was
    // never queried, so its `0` is a placeholder. Summed, that is `0` — and it
    // is NOT the structural zero the first lane reported. There may be abandoned
    // rows in the lane nobody looked at. (The lane id here is a stand-in: no
    // production lane emits this basis, but the projection's rule is about the
    // BASIS, not about which lane carried it.)
    const projected = projectConsentedReadiness({
      importComplete: true,
      snapshot: burndownSnapshot([
        burndownLane({
          lane: SyncLaneId.SessionMetadata,
          state: SyncLaneDrainState.IdleNotRunning,
          deadLetteredBasis: SyncLaneDeadLetteredBasis.Unmeasured,
        }),
        burndownLane({
          lane: SyncLaneId.TranscriptArchive,
          deadLetteredBasis: SyncLaneDeadLetteredBasis.NoDeadLetterState,
        }),
      ]),
    });

    assert.deepEqual(totalCloudReadDeadLettered(projected), {
      count: 0,
      basis: CloudReadDeadLetteredBasis.PartiallyUnmeasured,
    });
  });

  it("marks a positive total a FLOOR when one lane was never read", () => {
    // The measured lane genuinely abandoned 5. The unread lane may have
    // abandoned any number at all, so `5` is the most that can be stood behind
    // — and presenting it as the whole answer is the plausible-but-wrong number
    // the basis exists to stop.
    const projected = projectConsentedReadiness({
      importComplete: true,
      snapshot: burndownSnapshot([
        burndownLane({
          lane: SyncLaneId.InvocationParts,
          state: SyncLaneDrainState.DrainedWithDeadLetters,
          deadLetteredCount: 5,
          deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
        }),
        burndownLane({
          lane: SyncLaneId.ComponentInventory,
          state: SyncLaneDrainState.IdleNotRunning,
          deadLetteredBasis: SyncLaneDeadLetteredBasis.Unmeasured,
        }),
      ]),
    });

    assert.deepEqual(totalCloudReadDeadLettered(projected), {
      count: 5,
      basis: CloudReadDeadLetteredBasis.PartiallyUnmeasured,
    });
  });

  it("calls a total MEASURED only when every lane established its contribution", () => {
    // Both measured populations plus a lane with no give-up state. Nothing here
    // is a placeholder, so the total is exact — the case that must stay
    // distinguishable from the two above for the label to mean anything.
    const projected = projectConsentedReadiness({
      importComplete: true,
      snapshot: burndownSnapshot([
        burndownLane({
          lane: SyncLaneId.InvocationParts,
          state: SyncLaneDrainState.DrainedWithDeadLetters,
          deadLetteredCount: 5,
          deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
        }),
        burndownLane({
          lane: SyncLaneId.ComponentInventory,
          state: SyncLaneDrainState.DrainedWithDeadLetters,
          deadLetteredCount: 4,
          deadLetteredBasis: SyncLaneDeadLetteredBasis.AbandonedIdLedger,
        }),
        burndownLane({
          lane: SyncLaneId.TranscriptArchive,
          deadLetteredBasis: SyncLaneDeadLetteredBasis.NoDeadLetterState,
        }),
      ]),
    });

    assert.deepEqual(totalCloudReadDeadLettered(projected), {
      count: 9,
      basis: CloudReadDeadLetteredBasis.Measured,
    });
  });

  it("reports UNMEASURED when no lane established anything", () => {
    const allUnread = projectConsentedReadiness({
      importComplete: true,
      snapshot: burndownSnapshot([
        burndownLane({
          lane: SyncLaneId.SessionMetadata,
          state: SyncLaneDrainState.IdleNotRunning,
          deadLetteredBasis: SyncLaneDeadLetteredBasis.Unmeasured,
        }),
        burndownLane({
          lane: SyncLaneId.InvocationParts,
          state: SyncLaneDrainState.IdleNotRunning,
          deadLetteredBasis: SyncLaneDeadLetteredBasis.Unmeasured,
        }),
      ]),
    });

    assert.deepEqual(totalCloudReadDeadLettered(allUnread), {
      count: 0,
      basis: CloudReadDeadLetteredBasis.Unmeasured,
    });
    // The pre-first-sample snapshot falls out of the same rule: nothing was
    // established, so its `0` is a placeholder rather than "nothing was
    // abandoned" — the empty-list refusal `totalCloudReadItemsRemaining`
    // already makes for the remainder.
    assert.deepEqual(totalCloudReadDeadLettered(unknownCloudReadReadiness()), {
      count: 0,
      basis: CloudReadDeadLetteredBasis.Unmeasured,
    });
  });

  it("hands the reconciled basis to the whole-app backlog beside the count", () => {
    // `CloudSyncBacklog.deadLetteredCount` is what the Connection Status cell
    // prints. The basis has to arrive with it or the aggregate is exactly as
    // undimensioned as the bare lane field was.
    const backlog = resolveCloudSyncBacklog(
      projectConsentedReadiness({
        importComplete: true,
        snapshot: burndownSnapshot([
          burndownLane({
            lane: SyncLaneId.InvocationParts,
            state: SyncLaneDrainState.DrainedWithDeadLetters,
            deadLetteredCount: 1,
            deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
          }),
          burndownLane({
            lane: SyncLaneId.ComponentInventory,
            state: SyncLaneDrainState.IdleNotRunning,
            deadLetteredBasis: SyncLaneDeadLetteredBasis.Unmeasured,
          }),
        ]),
      })
    );

    assert.equal(backlog.deadLetteredCount, 1);
    assert.equal(
      backlog.deadLetteredBasis,
      CloudReadDeadLetteredBasis.PartiallyUnmeasured
    );
  });

  it("keeps the basis ALONE out of the drain verdict, so an unlabelled build still settles", () => {
    // Version skew: an older main process populates no basis, the IPC boundary
    // degrades every lane to `unmeasured`, and the backlog must still be able to
    // reach `drained`. Gating the verdict on measuredness would trade a
    // precision loss for a liveness one — a build that can never report caught
    // up, which is the opposite failure and the worse one.
    //
    // ISS-9807 sharpened what "not gated" means: the BASIS never gates the
    // aggregate; the lane's own CLASSIFICATION does. These lanes carry the
    // `drained` the older build classified, so they settle. A lane this build
    // classifies `remaining_unknown` on an unmeasured basis is the case below.
    const backlog = resolveCloudSyncBacklog(
      projectConsentedReadiness({
        importComplete: true,
        snapshot: burndownSnapshot([
          burndownLane({
            lane: SyncLaneId.SessionMetadata,
            deadLetteredBasis: SyncLaneDeadLetteredBasis.Unmeasured,
          }),
          burndownLane({
            lane: SyncLaneId.InvocationParts,
            deadLetteredBasis: SyncLaneDeadLetteredBasis.Unmeasured,
          }),
        ]),
      }),
      { strictLaneReadiness: true }
    );

    assert.equal(backlog.state, CloudSyncBacklogState.Drained);
    assert.equal(
      backlog.deadLetteredBasis,
      CloudReadDeadLetteredBasis.Unmeasured
    );
  });
});

describe("ISS-9807: a lane the store never read cannot reach drained", () => {
  /** Every count a gate-open, empty, healthy lane reports, with only the basis varying. */
  function emptyOpenLane(deadLetteredBasis: SyncLaneDeadLetteredBasis | null) {
    return {
      started: true,
      gateOpen: true,
      resumeBlocked: false,
      itemsRemaining: 0,
      deadLetteredCount: 0,
      deadLetteredBasis,
      unmeasuredRows: 0,
    };
  }

  it("classifies an UNMEASURED lane remaining_unknown, and a measured one drained", () => {
    // COUNTERFACTUAL: drop the basis branch from `classifyLaneDrainState` and
    // the first assertion reads `drained` — a placeholder zero rounded up to
    // "caught up" on exactly the machine the gate-shut alert is about.
    assert.equal(
      classifyLaneDrainState(
        emptyOpenLane(SyncLaneDeadLetteredBasis.Unmeasured)
      ),
      SyncLaneDrainState.RemainingUnknown
    );
    // The sibling in the opposite state, so a refusal cannot be read as proof:
    // every MEASURED basis — including the structural zero — still drains.
    for (const basis of [
      SyncLaneDeadLetteredBasis.QueueStatusCount,
      SyncLaneDeadLetteredBasis.AbandonedIdLedger,
      SyncLaneDeadLetteredBasis.NoDeadLetterState,
    ]) {
      assert.equal(
        classifyLaneDrainState(emptyOpenLane(basis)),
        SyncLaneDrainState.Drained,
        `${basis} is a measurement and must still drain`
      );
    }
    // `null` is the IPC boundary's "the payload predates the field" and
    // re-derives as that build did — the rule is skipped, not tripped.
    assert.equal(
      classifyLaneDrainState(emptyOpenLane(null)),
      SyncLaneDrainState.Drained
    );
  });

  it("reaches the lane through the reporter: a gate-open lane with no source key is remaining_unknown", async () => {
    // The production wiring — the reporter hands its own basis to the
    // classifier — and the exact population ISS-9807 names: a lane whose gate
    // is OPEN while its store read was never scoped to a key. Its line must
    // not carry the fully-synced verdict.
    const harness = buildHarness({ sample: unscopedSample() });
    harness.setSourceKeys({ session: null, invocation: null, component: null });
    harness.reporter.start();
    await harness.reporter.sampleOnce();
    harness.reporter.stop();

    const session = harness.lines
      .map((line) => line.message)
      .filter((message) =>
        message.startsWith(`[${SyncLaneId.SessionMetadata}]`)
      );
    assert.ok(session.length > 0, "no line for the session lane");
    assert.ok(
      session.every((message) => !message.includes("fully synced to cloud")),
      "a lane nobody read must not be reported fully synced"
    );
  });

  it("refuses the whole-app drained verdict, on the default AND strict paths, on one unmeasured lane", () => {
    // Four measured, drained lanes beside ONE this build classified
    // `remaining_unknown` on an unmeasured basis. A total of `0` and four clean
    // bills of health must not round the fifth up.
    //
    // COUNTERFACTUAL: drop `cloudReadLaneUnmeasured` from the aggregate's
    // zero-total door and the default path answers `drained`.
    const snapshot = projectConsentedReadiness({
      importComplete: true,
      snapshot: burndownSnapshot([
        burndownLane({
          lane: SyncLaneId.SessionMetadata,
          state: SyncLaneDrainState.RemainingUnknown,
          deadLetteredBasis: SyncLaneDeadLetteredBasis.Unmeasured,
        }),
        burndownLane({ lane: SyncLaneId.InvocationParts }),
        burndownLane({ lane: SyncLaneId.TranscriptArchive }),
        burndownLane({ lane: SyncLaneId.ComponentInventory }),
      ]),
    });

    for (const strictLaneReadiness of [false, true]) {
      const backlog = resolveCloudSyncBacklog(snapshot, {
        strictLaneReadiness,
      });
      assert.equal(
        backlog.state,
        CloudSyncBacklogState.Unknown,
        `strict=${strictLaneReadiness}: a never-read lane is unknown, not drained`
      );
      assert.notEqual(backlog.state, CloudSyncBacklogState.Drained);
    }
    // And the same four lanes with the first MEASURED do drain, so the refusal
    // above is the basis's doing and not the fixture's.
    const measured = projectConsentedReadiness({
      importComplete: true,
      snapshot: burndownSnapshot([
        burndownLane({ lane: SyncLaneId.SessionMetadata }),
        burndownLane({ lane: SyncLaneId.InvocationParts }),
        burndownLane({ lane: SyncLaneId.TranscriptArchive }),
        burndownLane({ lane: SyncLaneId.ComponentInventory }),
      ]),
    });
    assert.equal(
      resolveCloudSyncBacklog(measured).state,
      CloudSyncBacklogState.Drained
    );
  });
});
