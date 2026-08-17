import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type CloudReadLaneReadiness,
  CloudSyncBacklogState,
  cloudReadLaneOwesWork,
  cloudReadReadinessFingerprint,
  hasCloudReadDeadLetters,
  isCloudReadBacklogDrained,
  projectCloudReadReadiness,
  resolveCloudSyncBacklog,
  totalCloudReadDeadLettered,
  totalCloudReadItemsRemaining,
  unknownCloudReadReadiness,
} from "../src/shared/cloud-read-readiness-contract.js";
import {
  SYNC_LANE_IDS,
  type SyncLaneBurndown,
  SyncLaneDrainState,
  SyncLaneId,
} from "../src/shared/sync-burndown-contract.js";
import {
  burndownLane,
  burndownSnapshot,
} from "./helpers/sync-burndown-fixtures.js";

const lane = burndownLane;
const snapshot = burndownSnapshot;

describe("projectCloudReadReadiness", () => {
  it("projects a burn-down sample down to what a read-source decision needs", () => {
    const projected = projectCloudReadReadiness({
      importComplete: true,
      snapshot: snapshot([
        lane({
          state: SyncLaneDrainState.Draining,
          itemsRemaining: 200,
          itemsRemainingIsLowerBound: true,
        }),
        lane({ lane: SyncLaneId.TranscriptArchive, deadLetteredCount: 3 }),
      ]),
    });

    assert.equal(projected.sampledAtIso, "2026-08-07T12:00:00.000Z");
    assert.equal(projected.importComplete, true);
    assert.deepEqual(projected.lanes, [
      {
        lane: SyncLaneId.SessionMetadata,
        state: SyncLaneDrainState.Draining,
        itemsRemaining: 200,
        itemsRemainingIsLowerBound: true,
        deadLetteredCount: 0,
        // ISS-5768: carried through so the whole-app aggregate can see the
        // second way a lane fails to prove it owes nothing.
        unmeasuredRows: 0,
        // ISS-6206: no configuration resolver was supplied, so no lane is out
        // of play — the under-claiming default.
        notApplicableReason: null,
      },
      {
        lane: SyncLaneId.TranscriptArchive,
        state: SyncLaneDrainState.Drained,
        itemsRemaining: 0,
        itemsRemainingIsLowerBound: false,
        deadLetteredCount: 3,
        unmeasuredRows: 0,
        notApplicableReason: null,
      },
    ]);
  });

  it("projects an absent sample as UNKNOWN rather than as an empty, drained one", () => {
    const projected = projectCloudReadReadiness({
      importComplete: true,
      snapshot: null,
    });

    // "We have not looked" and "nothing is owed" must never collapse: the
    // second would move the reader onto a cloud that has received nothing.
    assert.equal(projected.sampledAtIso, null);
    assert.equal(projected.importComplete, false);
    assert.deepEqual(projected.lanes, []);
    assert.equal(isCloudReadBacklogDrained(projected), false);
  });
});

describe("isCloudReadBacklogDrained", () => {
  it("answers true only when every lane is `drained`", () => {
    const drained = projectCloudReadReadiness({
      importComplete: true,
      snapshot: snapshot([lane(), lane({ lane: SyncLaneId.TraceComments })]),
    });
    assert.equal(isCloudReadBacklogDrained(drained), true);

    for (const state of [
      SyncLaneDrainState.NeverStarted,
      SyncLaneDrainState.IdleNotRunning,
      SyncLaneDrainState.Draining,
      SyncLaneDrainState.DrainedWithDeadLetters,
      SyncLaneDrainState.RemainingUnknown,
    ]) {
      const blocked = projectCloudReadReadiness({
        importComplete: true,
        snapshot: snapshot([lane(), lane({ state })]),
      });
      assert.equal(
        isCloudReadBacklogDrained(blocked),
        false,
        `${state} must not count as caught up`
      );
    }
  });

  it("answers false for a sample that measured no lanes", () => {
    assert.equal(
      isCloudReadBacklogDrained(
        projectCloudReadReadiness({
          importComplete: true,
          snapshot: snapshot([]),
        })
      ),
      false
    );
  });
});

describe("readiness totals", () => {
  it("sums what is owed, and reports UNKNOWN when a lane cannot measure its own", () => {
    const measured = projectCloudReadReadiness({
      importComplete: true,
      snapshot: snapshot([
        lane({ itemsRemaining: 12 }),
        lane({ lane: SyncLaneId.InvocationParts, itemsRemaining: 30 }),
      ]),
    });
    assert.equal(totalCloudReadItemsRemaining(measured), 42);

    const unmeasured = projectCloudReadReadiness({
      importComplete: true,
      snapshot: snapshot([
        lane({ itemsRemaining: 12 }),
        lane({
          lane: SyncLaneId.ComponentInventory,
          itemsRemaining: null,
        }),
      ]),
    });
    // A total that silently omitted the unmeasurable lane would be the same
    // reassuring lie as a fabricated zero.
    assert.equal(totalCloudReadItemsRemaining(unmeasured), null);
  });

  it("reports UNKNOWN for a snapshot that measured no lanes, not zero", () => {
    const notSampled = projectCloudReadReadiness({
      importComplete: true,
      snapshot: snapshot([]),
    });
    // "Measured no lanes" is not "owes zero items". Summing the empty list to
    // `0` is the same distinction-collapse `isCloudReadBacklogDrained` refuses
    // one function above.
    assert.equal(totalCloudReadItemsRemaining(notSampled), null);
    assert.equal(isCloudReadBacklogDrained(notSampled), false);
  });

  it("counts and detects abandoned work across lanes", () => {
    const projected = projectCloudReadReadiness({
      importComplete: true,
      snapshot: snapshot([
        lane({ deadLetteredCount: 2 }),
        lane({ lane: SyncLaneId.InvocationParts, deadLetteredCount: 5 }),
      ]),
    });

    assert.equal(totalCloudReadDeadLettered(projected), 7);
    assert.equal(hasCloudReadDeadLetters(projected), true);
    assert.equal(
      hasCloudReadDeadLetters(
        projectCloudReadReadiness({
          importComplete: true,
          snapshot: snapshot([lane()]),
        })
      ),
      false
    );
  });
});

describe("cloudReadReadinessFingerprint", () => {
  it("ignores the sample timestamp so a re-stamped identical sample is not progress", () => {
    const lanes = [
      lane({ state: SyncLaneDrainState.Draining, itemsRemaining: 8 }),
    ];
    const first = projectCloudReadReadiness({
      importComplete: true,
      snapshot: { sampledAtIso: "2026-08-07T12:00:00.000Z", lanes },
    });
    const later = projectCloudReadReadiness({
      importComplete: true,
      snapshot: { sampledAtIso: "2026-08-07T12:30:00.000Z", lanes },
    });

    // ISS-5347: activity is not progress. A moving clock beside a motionless
    // queue must not reset the stall bound.
    assert.equal(
      cloudReadReadinessFingerprint(first),
      cloudReadReadinessFingerprint(later)
    );
  });

  it("changes on every dimension the cutover decision reads", () => {
    const base = projectCloudReadReadiness({
      importComplete: false,
      snapshot: snapshot([
        lane({ state: SyncLaneDrainState.Draining, itemsRemaining: 8 }),
      ]),
    });
    const baseline = cloudReadReadinessFingerprint(base);

    const importDone = projectCloudReadReadiness({
      importComplete: true,
      snapshot: snapshot([
        lane({ state: SyncLaneDrainState.Draining, itemsRemaining: 8 }),
      ]),
    });
    const queueShrank = projectCloudReadReadiness({
      importComplete: false,
      snapshot: snapshot([
        lane({ state: SyncLaneDrainState.Draining, itemsRemaining: 7 }),
      ]),
    });
    const stateMoved = projectCloudReadReadiness({
      importComplete: false,
      snapshot: snapshot([lane({ itemsRemaining: 8 })]),
    });
    const gaveUp = projectCloudReadReadiness({
      importComplete: false,
      snapshot: snapshot([
        lane({
          state: SyncLaneDrainState.Draining,
          itemsRemaining: 8,
          deadLetteredCount: 1,
        }),
      ]),
    });

    for (const [label, projected] of [
      ["import completing", importDone],
      ["the queue shrinking", queueShrank],
      ["a lane state moving", stateMoved],
      ["an item being abandoned", gaveUp],
    ] as const) {
      assert.notEqual(
        cloudReadReadinessFingerprint(projected),
        baseline,
        `${label} must count as movement`
      );
    }
  });

  it("distinguishes an exact remainder from a lower-bound one", () => {
    const exact = projectCloudReadReadiness({
      importComplete: true,
      snapshot: snapshot([
        lane({ state: SyncLaneDrainState.Draining, itemsRemaining: 200 }),
      ]),
    });
    const floor = projectCloudReadReadiness({
      importComplete: true,
      snapshot: snapshot([
        lane({
          state: SyncLaneDrainState.Draining,
          itemsRemaining: 200,
          itemsRemainingIsLowerBound: true,
        }),
      ]),
    });

    assert.notEqual(
      cloudReadReadinessFingerprint(exact),
      cloudReadReadinessFingerprint(floor)
    );
  });
});

/**
 * ISS-5768 — the whole-app completeness claim.
 *
 * `AgentSessionSyncProgress.caughtUp` measures the session backfill/incremental
 * queues and nothing else, and it was driving a user-facing "Up to date". These
 * pin the aggregate that replaces it, including the property that makes it
 * durable: a lane the code has never heard of is COUNTED, not excluded.
 */
describe("resolveCloudSyncBacklog", () => {
  it("reports the reported machine as outstanding, not drained (2,985 owed, 1 abandoned)", () => {
    // Mike, 2026-08-10: the session lanes were drained (`caughtUp === true`)
    // while the component inventory still owed 2,985 rows and one item was
    // dead-lettered in the invocation-parts lane. This is that snapshot.
    const backlog = resolveCloudSyncBacklog(
      projectCloudReadReadiness({
        importComplete: true,
        snapshot: snapshot([
          lane({ lane: SyncLaneId.SessionMetadata }),
          lane({
            lane: SyncLaneId.InvocationParts,
            state: SyncLaneDrainState.DrainedWithDeadLetters,
            deadLetteredCount: 1,
          }),
          lane({ lane: SyncLaneId.TranscriptArchive }),
          lane({
            lane: SyncLaneId.ComponentInventory,
            state: SyncLaneDrainState.Draining,
            itemsRemaining: 2985,
          }),
          lane({ lane: SyncLaneId.TraceComments }),
        ]),
      })
    );
    assert.equal(backlog.state, CloudSyncBacklogState.Outstanding);
    assert.equal(backlog.itemsRemaining, 2985);
    assert.equal(backlog.deadLetteredCount, 1);
  });

  it("is drained only when every lane owes nothing", () => {
    const backlog = resolveCloudSyncBacklog(
      projectCloudReadReadiness({
        importComplete: true,
        snapshot: snapshot([
          lane({ lane: SyncLaneId.SessionMetadata }),
          lane({ lane: SyncLaneId.ComponentInventory }),
        ]),
      })
    );
    assert.equal(backlog.state, CloudSyncBacklogState.Drained);
    assert.equal(backlog.itemsRemaining, 0);
    assert.equal(backlog.deadLetteredCount, 0);
  });

  it("counts a lane this build has never heard of, by default, when it owes work", () => {
    // The acceptance property. The predicate reads only the three quantities
    // every lane reports, so a lane added later is counted the moment the
    // burn-down measures it. Being excluded must take a deliberate act.
    const unknownLane = lane({
      lane: "a_lane_added_later" as SyncLaneId,
      state: "some_future_state" as SyncLaneDrainState,
      itemsRemaining: 7,
    });
    const backlog = resolveCloudSyncBacklog(
      projectCloudReadReadiness({
        importComplete: true,
        snapshot: snapshot([
          lane({ lane: SyncLaneId.SessionMetadata }),
          unknownLane,
        ]),
      })
    );
    assert.equal(backlog.state, CloudSyncBacklogState.Outstanding);
    assert.equal(backlog.itemsRemaining, 7);
  });

  it("treats an unmeasurable remainder as unknown, never as drained", () => {
    const backlog = resolveCloudSyncBacklog(
      projectCloudReadReadiness({
        importComplete: true,
        snapshot: snapshot([
          lane({ lane: SyncLaneId.SessionMetadata }),
          lane({
            lane: SyncLaneId.ComponentInventory,
            state: SyncLaneDrainState.RemainingUnknown,
            itemsRemaining: null,
          }),
        ]),
      })
    );
    assert.equal(backlog.state, CloudSyncBacklogState.Unknown);
    assert.equal(backlog.itemsRemaining, null);
  });

  it("reports abandoned when nothing is left to attempt but a lane gave up", () => {
    const backlog = resolveCloudSyncBacklog(
      projectCloudReadReadiness({
        importComplete: true,
        snapshot: snapshot([
          lane({
            lane: SyncLaneId.InvocationParts,
            state: SyncLaneDrainState.DrainedWithDeadLetters,
            deadLetteredCount: 3,
          }),
        ]),
      })
    );
    assert.equal(backlog.state, CloudSyncBacklogState.Abandoned);
    assert.equal(backlog.itemsRemaining, 0);
    assert.equal(backlog.deadLetteredCount, 3);
  });

  it("answers unknown — never drained — when nobody has looked", () => {
    // A null snapshot is what an older main process (no `cloudReadReadiness` in
    // its runtime-status payload) degrades to, and an unsampled burn-down is
    // what every launch starts with (ISS-5749). Neither is "nothing is owed".
    for (const unmeasured of [
      null,
      unknownCloudReadReadiness(),
      projectCloudReadReadiness({ importComplete: true, snapshot: null }),
    ]) {
      const backlog = resolveCloudSyncBacklog(unmeasured);
      assert.equal(backlog.state, CloudSyncBacklogState.Unknown);
      assert.equal(backlog.itemsRemaining, null);
    }
  });

  it("does not hold a lane whose gate is shut with a measured empty queue against the app", () => {
    // The opposite lie. Transcript upload disabled, org policy closed: the lane
    // is not running and owes nothing, and reporting it outstanding forever
    // would be its own false claim.
    const backlog = resolveCloudSyncBacklog(
      projectCloudReadReadiness({
        importComplete: true,
        snapshot: snapshot([
          lane({ lane: SyncLaneId.SessionMetadata }),
          lane({
            lane: SyncLaneId.TranscriptArchive,
            state: SyncLaneDrainState.IdleNotRunning,
            itemsRemaining: 0,
          }),
        ]),
      })
    );
    assert.equal(backlog.state, CloudSyncBacklogState.Drained);
  });

  it("marks the total a lower bound when any lane's remainder is a floor", () => {
    const backlog = resolveCloudSyncBacklog(
      projectCloudReadReadiness({
        importComplete: true,
        snapshot: snapshot([
          lane({
            lane: SyncLaneId.InvocationParts,
            state: SyncLaneDrainState.Draining,
            itemsRemaining: 500,
            itemsRemainingIsLowerBound: true,
          }),
        ]),
      })
    );
    assert.equal(backlog.state, CloudSyncBacklogState.Outstanding);
    assert.equal(backlog.itemsRemainingIsLowerBound, true);
  });
});

/**
 * ISS-5768 (synchronizing-susan review): the SECOND way a lane fails to prove it
 * owes nothing.
 *
 * `classifyLaneDrainState` answers `remaining_unknown` on `unmeasuredRows > 0`
 * even when the measured remainder is a clean `0` — rows carrying a status this
 * build cannot classify, which is exactly what a version-skewed or corrupt row
 * looks like. The first cut of the projection dropped that field, so the
 * whole-app aggregate rounded such a lane down to `drained` and the History Sync
 * cell would have said "Up to date" while the `Cloud (partial)` badge (which
 * reads `state` directly) correctly said otherwise — reopening the very
 * "two indicators, one screen, opposite answers" symptom this ticket is named
 * for.
 */
describe("resolveCloudSyncBacklog — unclassifiable rows (ISS-5768)", () => {
  const UNCLASSIFIED_LANE = lane({
    lane: SyncLaneId.InvocationParts,
    // What the burn-down's own classifier answers for this shape.
    state: SyncLaneDrainState.RemainingUnknown,
    itemsRemaining: 0,
    unmeasuredRows: 5,
    deadLetteredCount: 0,
  });

  it("is UNKNOWN, not drained, when a lane holds rows it could not classify", () => {
    const backlog = resolveCloudSyncBacklog(
      projectCloudReadReadiness({
        importComplete: true,
        snapshot: snapshot([
          lane({ lane: SyncLaneId.SessionMetadata }),
          UNCLASSIFIED_LANE,
        ]),
      })
    );
    assert.equal(backlog.state, CloudSyncBacklogState.Unknown);
  });

  it("counts that lane as owing work", () => {
    // The predicate, directly: measured zero remainder, zero dead-letters, and
    // still owed — because unmeasured is not zero.
    assert.equal(cloudReadLaneOwesWork(projectedLane(UNCLASSIFIED_LANE)), true);
  });

  it("still reports drained when the same lane classifies every row", () => {
    // The counterfactual: identical lane with `unmeasuredRows: 0`. Without it the
    // two assertions above could pass on an aggregate that is never drained.
    const backlog = resolveCloudSyncBacklog(
      projectCloudReadReadiness({
        importComplete: true,
        snapshot: snapshot([
          lane({ lane: SyncLaneId.SessionMetadata }),
          lane({
            lane: SyncLaneId.InvocationParts,
            state: SyncLaneDrainState.Drained,
            itemsRemaining: 0,
            unmeasuredRows: 0,
          }),
        ]),
      })
    );
    assert.equal(backlog.state, CloudSyncBacklogState.Drained);
  });

  it("carries unmeasured rows into the stall fingerprint, so classifying them reads as movement", () => {
    const before = cloudReadReadinessFingerprint(
      projectCloudReadReadiness({
        importComplete: true,
        snapshot: snapshot([UNCLASSIFIED_LANE]),
      })
    );
    const after = cloudReadReadinessFingerprint(
      projectCloudReadReadiness({
        importComplete: true,
        snapshot: snapshot([lane({ ...UNCLASSIFIED_LANE, unmeasuredRows: 0 })]),
      })
    );
    assert.notEqual(before, after);
  });
});

/**
 * ISS-5768 (codex review on #4809) — the initial import is a SIXTH source of
 * owed work, and no lane can see it.
 *
 * While the collector is still parsing, history exists on this machine that has
 * not entered any sync queue yet, so every lane can report a clean remainder on
 * a machine that owes the cloud thousands of items. The read-source gate already
 * refuses to cut over on `!importComplete` (`CloudReadCutoverBlocker.
 * ImportPending`); the aggregate that fronts every "Up to date" indicator has to
 * refuse for the same reason, or Settings says "Up to date" while discovery runs.
 */
describe("resolveCloudSyncBacklog — import still discovering (ISS-5768)", () => {
  const CLEAN_LANES = [
    lane({ lane: SyncLaneId.SessionMetadata }),
    lane({ lane: SyncLaneId.ComponentInventory }),
  ];

  it("is UNKNOWN, not drained, while the import is still running", () => {
    const backlog = resolveCloudSyncBacklog(
      projectCloudReadReadiness({
        importComplete: false,
        snapshot: snapshot(CLEAN_LANES),
      })
    );
    assert.equal(backlog.state, CloudSyncBacklogState.Unknown);
  });

  it("is drained once the same lanes are joined by a finished import", () => {
    // The counterfactual: identical lanes, `importComplete: true`. Without it the
    // assertion above would pass on an aggregate that is simply never drained.
    const backlog = resolveCloudSyncBacklog(
      projectCloudReadReadiness({
        importComplete: true,
        snapshot: snapshot(CLEAN_LANES),
      })
    );
    assert.equal(backlog.state, CloudSyncBacklogState.Drained);
  });

  it("refuses ABANDONED while the import runs — that claim says nothing is left to attempt", () => {
    const backlog = resolveCloudSyncBacklog(
      projectCloudReadReadiness({
        importComplete: false,
        snapshot: snapshot([
          lane({ lane: SyncLaneId.SessionMetadata }),
          lane({
            lane: SyncLaneId.InvocationParts,
            state: SyncLaneDrainState.DrainedWithDeadLetters,
            deadLetteredCount: 1,
          }),
        ]),
      })
    );
    assert.equal(backlog.state, CloudSyncBacklogState.Unknown);
    // The abandoned item IS established, so it is still reported.
    assert.equal(backlog.deadLetteredCount, 1);
  });

  it("reports a measured remainder as a FLOOR, since discovery can only add to it", () => {
    const backlog = resolveCloudSyncBacklog(
      projectCloudReadReadiness({
        importComplete: false,
        snapshot: snapshot([
          lane({
            lane: SyncLaneId.ComponentInventory,
            state: SyncLaneDrainState.Draining,
            itemsRemaining: 2985,
          }),
        ]),
      })
    );
    assert.equal(backlog.state, CloudSyncBacklogState.Outstanding);
    assert.equal(backlog.itemsRemaining, 2985);
    assert.equal(backlog.itemsRemainingIsLowerBound, true);
  });
});

/** The projected shape `cloudReadLaneOwesWork` actually receives. */
function projectedLane(source: SyncLaneBurndown): CloudReadLaneReadiness {
  const projected = projectCloudReadReadiness({
    importComplete: true,
    snapshot: snapshot([source]),
  }).lanes[0];
  if (!projected) {
    throw new Error("projection must yield the lane");
  }
  return projected;
}

describe("resolveCloudSyncBacklog — stopped lanes (ISS-6206)", () => {
  const STRICT = { strictLaneReadiness: true };

  it("refuses to call a never_started lane drained on a measured zero", () => {
    // The lane has never looked, so its clean zero is not evidence of anything.
    // Rounding it up to `drained` is what let the UI say "Up to date" about a
    // lane that never ran.
    const backlog = resolveCloudSyncBacklog(
      projectCloudReadReadiness({
        importComplete: true,
        snapshot: snapshot([
          lane(),
          lane({
            lane: SyncLaneId.TranscriptArchive,
            state: SyncLaneDrainState.NeverStarted,
          }),
        ]),
      }),
      STRICT
    );

    assert.equal(backlog.state, CloudSyncBacklogState.Unknown);
  });

  it("refuses to call an idle_not_running lane drained on a measured zero", () => {
    // Its gate is shut, so it has stopped trying rather than caught up. It is
    // still not reported as `outstanding` — nothing is measurably owed — which
    // is exactly why `unknown` is the state that fits.
    const backlog = resolveCloudSyncBacklog(
      projectCloudReadReadiness({
        importComplete: true,
        snapshot: snapshot([
          lane(),
          lane({
            lane: SyncLaneId.TraceComments,
            state: SyncLaneDrainState.IdleNotRunning,
          }),
        ]),
      }),
      STRICT
    );

    assert.equal(backlog.state, CloudSyncBacklogState.Unknown);
    assert.equal(
      backlog.itemsRemaining,
      0,
      "the measured remainder is still reported — only the completeness claim is withheld"
    );
  });

  it("still reports drained when every lane is canonically drained", () => {
    // The counterfactual guard on the two tests above: without this, the fix
    // could pass by making every snapshot unverified, which would mean the app
    // could never say it was caught up at all.
    const backlog = resolveCloudSyncBacklog(
      projectCloudReadReadiness({
        importComplete: true,
        snapshot: snapshot([
          lane(),
          lane({ lane: SyncLaneId.TranscriptArchive }),
        ]),
      }),
      STRICT
    );

    assert.equal(backlog.state, CloudSyncBacklogState.Drained);
  });

  it("does not let a dead letter carry a stopped lane into abandoned", () => {
    // ISS-6206 (wongk review on #5050): the guard used to sit INSIDE the
    // `!lanes.some(cloudReadLaneOwesWork)` door, and `cloudReadLaneOwesWork` is
    // true on `deadLetteredCount > 0`. One dead letter therefore skipped the
    // guard entirely and fell through to `abandoned` — the OTHER terminal claim,
    // asserting on a machine whose transcript lane never ran that there is
    // nothing left to deliver. This module's own contract says a lane-clean
    // machine is `unknown`, "never `drained` or `abandoned` — both of those are
    // terminal claims".
    const backlog = resolveCloudSyncBacklog(
      projectCloudReadReadiness({
        importComplete: true,
        snapshot: snapshot([
          lane({
            state: SyncLaneDrainState.DrainedWithDeadLetters,
            deadLetteredCount: 1,
          }),
          lane({
            lane: SyncLaneId.TranscriptArchive,
            state: SyncLaneDrainState.NeverStarted,
          }),
        ]),
      }),
      STRICT
    );

    assert.equal(backlog.state, CloudSyncBacklogState.Unknown);
    assert.equal(
      backlog.deadLetteredCount,
      1,
      "the abandoned item is still reported — only the terminal claim is withheld"
    );
    // shafty023 review on #5050: and it is NOT marked settled. Both lanes fell
    // short for reasons a sample observed rather than reasons this app's
    // configuration carries, so waiting can still resolve them.
    assert.equal(backlog.laneReadinessUnattested, false);
  });

  it("calls a shortfall of only dead letters abandoned, not still-checking", () => {
    // ISS-6206 (wongk review on #5050): every lane has FINISHED — four drained,
    // one gave up — so nothing about this snapshot can improve. Held in the
    // strict pending branch it rendered "1 item couldn't sync. Still checking
    // whether the rest of your history is synced." permanently, and the same
    // snapshot without the strict flag already answered `abandoned`.
    const deadLetteredOnly = projectCloudReadReadiness({
      importComplete: true,
      snapshot: snapshot([
        lane({
          state: SyncLaneDrainState.DrainedWithDeadLetters,
          deadLetteredCount: 1,
        }),
        ...SYNC_LANE_IDS.filter(
          (laneId) => laneId !== SyncLaneId.SessionMetadata
        ).map((laneId) => lane({ lane: laneId })),
      ]),
    });

    assert.equal(
      resolveCloudSyncBacklog(deadLetteredOnly, STRICT).state,
      CloudSyncBacklogState.Abandoned
    );
    // The two paths over one snapshot must agree that it has settled.
    assert.equal(
      resolveCloudSyncBacklog(deadLetteredOnly).state,
      CloudSyncBacklogState.Abandoned
    );
  });

  it("keeps a merely-stopped lane pending even beside a finished one", () => {
    // The boundary the case above must not cross, asserted from the other side:
    // swap one drained lane for a stopped one and the verdict goes back to
    // `unknown`, because that lane's gate reopens on its own.
    const stoppedSibling = projectCloudReadReadiness({
      importComplete: true,
      snapshot: snapshot([
        lane({
          state: SyncLaneDrainState.DrainedWithDeadLetters,
          deadLetteredCount: 1,
        }),
        lane({
          lane: SyncLaneId.TranscriptArchive,
          state: SyncLaneDrainState.IdleNotRunning,
        }),
      ]),
    });

    assert.equal(
      resolveCloudSyncBacklog(stoppedSibling, STRICT).state,
      CloudSyncBacklogState.Unknown
    );
  });

  it("marks only the unattestable unknown, never a pending one", () => {
    // The discriminator's counterfactual. A snapshot nobody has sampled is also
    // `unknown`, but waiting genuinely resolves it — so a progress surface that
    // reads `laneReadinessUnattested` to decide it may stop waiting must not see
    // it set here, or it stops waiting on every launch.
    assert.equal(
      resolveCloudSyncBacklog(null, STRICT).laneReadinessUnattested,
      false
    );
    assert.equal(
      resolveCloudSyncBacklog(
        projectCloudReadReadiness({
          importComplete: false,
          snapshot: snapshot([
            lane(),
            lane({ lane: SyncLaneId.TraceComments }),
          ]),
        }),
        STRICT
      ).laneReadinessUnattested,
      false
    );
  });

  it("leaves the pre-ISS-6206 behavior in place when strict readiness is not requested", () => {
    // The desktop Labs gate is closed by default, so an un-opted-in build must
    // resolve exactly as it did before. This is the flag-off half of the fix,
    // and it fails if the guard is applied unconditionally.
    const stopped = projectCloudReadReadiness({
      importComplete: true,
      snapshot: snapshot([
        lane(),
        lane({
          lane: SyncLaneId.TranscriptArchive,
          state: SyncLaneDrainState.NeverStarted,
        }),
      ]),
    });

    assert.equal(
      resolveCloudSyncBacklog(stopped).state,
      CloudSyncBacklogState.Drained
    );
    assert.deepEqual(resolveCloudSyncBacklog(stopped).laneRemainders, []);
  });

  it("reports a mixed-unit backlog as per-lane counts, never one summed total", () => {
    // 2,900 outbox ROWS and 12 transcript FILES do not add up to "2,912 items".
    // The breakdown keeps each count with the lane whose unit it is.
    const backlog = resolveCloudSyncBacklog(
      projectCloudReadReadiness({
        importComplete: true,
        snapshot: snapshot([
          lane({ state: SyncLaneDrainState.Draining, itemsRemaining: 2900 }),
          lane({
            lane: SyncLaneId.TranscriptArchive,
            state: SyncLaneDrainState.Draining,
            itemsRemaining: 12,
            itemsRemainingIsLowerBound: true,
          }),
          lane({ lane: SyncLaneId.TraceComments }),
        ]),
      }),
      STRICT
    );

    assert.equal(backlog.state, CloudSyncBacklogState.Outstanding);
    assert.deepEqual(backlog.laneRemainders, [
      {
        lane: SyncLaneId.SessionMetadata,
        itemsRemaining: 2900,
        itemsRemainingIsLowerBound: false,
      },
      {
        lane: SyncLaneId.TranscriptArchive,
        itemsRemaining: 12,
        itemsRemainingIsLowerBound: true,
      },
    ]);
  });
});

describe("cloudSyncLaneRemainders — ordering (ISS-6206 review)", () => {
  // shafty023 review on #5050: the previous expectation here was
  // largest-remainder-first, which compared counts across lanes that measure
  // different units — 7 transcript FILES ranked below 2,985 activity ROWS as if
  // the two were the same quantity. That is the dimensionless comparison this
  // ticket removed from the aggregate, so the expectation itself was wrong, not
  // merely unmet: the order is now the burn-down's canonical lane sequence.
  function remaindersFor(
    lanes: readonly SyncLaneBurndown[]
  ): readonly SyncLaneId[] {
    return resolveCloudSyncBacklog(
      projectCloudReadReadiness({
        importComplete: true,
        snapshot: snapshot(lanes),
      }),
      { strictLaneReadiness: true }
    ).laneRemainders.map((remainder) => remainder.lane);
  }

  it("orders lanes canonically, not by a count whose units do not compare", () => {
    assert.deepEqual(
      remaindersFor([
        lane({ state: SyncLaneDrainState.Draining, itemsRemaining: 3 }),
        lane({
          lane: SyncLaneId.TranscriptArchive,
          state: SyncLaneDrainState.Draining,
          itemsRemaining: 7,
        }),
        lane({
          lane: SyncLaneId.ComponentInventory,
          state: SyncLaneDrainState.Draining,
          itemsRemaining: 2985,
        }),
      ]),
      [
        SyncLaneId.SessionMetadata,
        SyncLaneId.TranscriptArchive,
        SyncLaneId.ComponentInventory,
      ],
      "lanes must be listed in SYNC_LANE_IDS order, not remainder order"
    );
  });

  it("does not reshuffle when two unrelated lane counts cross", () => {
    // The churn the review named: the same two lanes, the only difference being
    // which raw number is bigger. A size-ordered breakdown swaps the clauses
    // between samples; a canonical one cannot.
    const before = remaindersFor([
      lane({ state: SyncLaneDrainState.Draining, itemsRemaining: 101 }),
      lane({
        lane: SyncLaneId.TranscriptArchive,
        state: SyncLaneDrainState.Draining,
        itemsRemaining: 100,
      }),
    ]);
    const after = remaindersFor([
      lane({ state: SyncLaneDrainState.Draining, itemsRemaining: 99 }),
      lane({
        lane: SyncLaneId.TranscriptArchive,
        state: SyncLaneDrainState.Draining,
        itemsRemaining: 100,
      }),
    ]);

    assert.deepEqual(before, after);
    assert.deepEqual(before, [
      SyncLaneId.SessionMetadata,
      SyncLaneId.TranscriptArchive,
    ]);
  });

  it("orders canonically even when the payload arrives out of emission order", () => {
    // The snapshot crosses an IPC boundary, so lane order in the payload is not
    // guaranteed. Canonical means canonical, not "whatever order it came in".
    assert.deepEqual(
      remaindersFor([
        lane({
          lane: SyncLaneId.TraceComments,
          state: SyncLaneDrainState.Draining,
          itemsRemaining: 3,
        }),
        lane({
          lane: SyncLaneId.ComponentInventory,
          state: SyncLaneDrainState.Draining,
          itemsRemaining: 2,
        }),
        lane({ state: SyncLaneDrainState.Draining, itemsRemaining: 1 }),
      ]),
      [
        SyncLaneId.SessionMetadata,
        SyncLaneId.ComponentInventory,
        SyncLaneId.TraceComments,
      ]
    );
  });
});
