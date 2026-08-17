/**
 * @file use-ingest-progress-cloud-sync.test.ts
 * @description FEA-2733 — the renderer's projection of the main-process
 * cloud-sync snapshot (`parseCloudSync`) and its mapping to the compact
 * "History Sync" status label/tone (`describeCloudSyncStatus`). Both are pure,
 * so this runs on the renderer (jsdom/vitest) lane without any IPC or render.
 *
 * ISS-5768 — the completeness claim is now driven by the WHOLE-APP backlog
 * (`parseCloudSyncBacklog`), not by the session-lane-only `caughtUp`. The cases
 * that pin that are grouped at the bottom.
 */
import { describe, expect, it } from "vitest";
import {
  type CloudReadReadinessSnapshot,
  type CloudSyncBacklog,
  CloudSyncBacklogState,
  resolveCloudSyncBacklog,
} from "../../../shared/cloud-read-readiness-contract";
import {
  SYNC_LANE_IDS,
  SyncLaneDrainState,
  SyncLaneId,
} from "../../../shared/sync-burndown-contract";
import {
  type CloudSyncProgress,
  describeCloudSyncStatus,
  parseCloudSync,
  parseCloudSyncBacklog,
  parseStrictCloudSyncBacklog,
} from "../use-ingest-progress";

const CAUGHT_UP: CloudSyncProgress = {
  identified: true,
  pendingBackfillSessions: 0,
  pendingIncrementalSessions: 0,
  backfilling: false,
  caughtUp: true,
  deadLetteredSessions: 0,
};

function laneRow(
  overrides: Partial<CloudReadReadinessSnapshot["lanes"][number]>
): CloudReadReadinessSnapshot["lanes"][number] {
  return {
    lane: SyncLaneId.SessionMetadata,
    state: SyncLaneDrainState.Drained,
    itemsRemaining: 0,
    itemsRemainingIsLowerBound: false,
    deadLetteredCount: 0,
    unmeasuredRows: 0,
    ...overrides,
  };
}

/**
 * A readiness snapshot carrying the named lanes, defaults drained, PLUS a
 * settled row for every other lane the burn-down reports.
 *
 * The reporter emits all five lanes on every sample, and ISS-6206's IPC
 * boundary check now requires exactly that set — so a fixture naming one lane
 * is not a smaller real snapshot, it is a malformed one, and a parser test fed
 * one would be asserting against a payload the app can never receive.
 */
function readiness(
  lanes: Partial<CloudReadReadinessSnapshot["lanes"][number]>[]
): CloudReadReadinessSnapshot {
  const named = lanes.map(laneRow);
  const namedIds = new Set(named.map((lane) => lane.lane));
  return {
    sampledAtIso: "2026-08-10T12:00:00.000Z",
    importComplete: true,
    lanes: [
      ...named,
      ...SYNC_LANE_IDS.filter((lane) => !namedIds.has(lane)).map((lane) =>
        laneRow({ lane })
      ),
    ],
  };
}

/** Every lane owes nothing — the only backlog that may render "Up to date". */
const DRAINED: CloudSyncBacklog = resolveCloudSyncBacklog(
  readiness([{ lane: SyncLaneId.SessionMetadata }])
);

/** Nobody has looked yet (older main process, or pre-first-sample). */
const UNKNOWN: CloudSyncBacklog = resolveCloudSyncBacklog(null);

/**
 * The machine in the ISS-5768 report: session lanes drained, component
 * inventory still owing 2,985 rows, one item dead-lettered in the
 * invocation-parts lane — a lane `CloudSyncProgress` has no field for at all.
 */
const MIKES_MACHINE: CloudReadReadinessSnapshot = readiness([
  { lane: SyncLaneId.SessionMetadata },
  {
    lane: SyncLaneId.InvocationParts,
    state: SyncLaneDrainState.DrainedWithDeadLetters,
    deadLetteredCount: 1,
    unmeasuredRows: 0,
  },
  { lane: SyncLaneId.TranscriptArchive },
  {
    lane: SyncLaneId.ComponentInventory,
    state: SyncLaneDrainState.Draining,
    itemsRemaining: 2985,
  },
  { lane: SyncLaneId.TraceComments },
]);

describe("parseCloudSync", () => {
  it("returns null when the payload is absent or has no cloudSync field", () => {
    // Before the first poll resolves, or on an older main process without the
    // field, the projection degrades to null → indicator hidden (not a
    // spurious "up to date").
    expect(parseCloudSync(null)).toBeNull();
    expect(parseCloudSync("nope")).toBeNull();
    expect(parseCloudSync({})).toBeNull();
    expect(parseCloudSync({ cloudSync: null })).toBeNull();
  });

  it("returns the cloud-sync projection verbatim for a well-formed snapshot", () => {
    const cloudSync = {
      identified: true,
      pendingBackfillSessions: 12,
      pendingIncrementalSessions: 3,
      backfilling: true,
      caughtUp: false,
      deadLetteredSessions: 1,
    };
    expect(parseCloudSync({ cloudSync })).toEqual(cloudSync);
  });

  it("preserves deadLetteredComponents through the projection (ISS-4542 — not dropped between the runtime-status payload and the cell)", () => {
    // shafty023 review: the pure mapper test can pass even if the component
    // dead-letter count is lost in the projection from the raw runtime-status
    // payload. Assert the field survives `parseCloudSync` verbatim.
    const cloudSync = {
      identified: true,
      pendingBackfillSessions: 0,
      pendingIncrementalSessions: 0,
      backfilling: false,
      caughtUp: true,
      deadLetteredSessions: 0,
      deadLetteredComponents: 1,
    };
    const parsed = parseCloudSync({ cloudSync });
    expect(parsed?.deadLetteredComponents).toBe(1);
  });

  it("caught-up runtime-status payload with deadLetteredComponents drives the cell to 'Synced with issues' end-to-end (ISS-4542)", () => {
    // shafty023 review: cover the FULL projection→cell path a launched-app test
    // would exercise (parse then describe from ONE raw runtime-status payload),
    // so a caught-up status carrying a component dead-letter can never render a
    // clean "Up to date".
    const status = {
      cloudSync: {
        identified: true,
        pendingBackfillSessions: 0,
        pendingIncrementalSessions: 0,
        backfilling: false,
        caughtUp: true,
        deadLetteredSessions: 0,
        deadLetteredComponents: 1,
      },
      cloudReadReadiness: readiness([{ lane: SyncLaneId.SessionMetadata }]),
    };
    const cell = describeCloudSyncStatus(
      parseCloudSync(status),
      parseCloudSyncBacklog(status)
    );
    expect(cell.label).toBe("Synced with issues");
    expect(cell.tone).toBe("warning");
    expect(cell.detail).toContain("1 item");
  });
});

describe("parseCloudSyncBacklog", () => {
  it("resolves an absent cloudReadReadiness field to unknown, never drained", () => {
    // An older main process omits the field. "Nobody has looked" and "nothing
    // is owed" are the two answers this ticket exists to keep apart.
    for (const payload of [null, "nope", {}, { cloudReadReadiness: null }]) {
      expect(parseCloudSyncBacklog(payload).state).toBe(
        CloudSyncBacklogState.Unknown
      );
    }
  });

  it("resolves a sampled snapshot into the whole-app totals", () => {
    const backlog = parseCloudSyncBacklog({
      cloudReadReadiness: MIKES_MACHINE,
    });
    expect(backlog.state).toBe(CloudSyncBacklogState.Outstanding);
    expect(backlog.itemsRemaining).toBe(2985);
    expect(backlog.deadLetteredCount).toBe(1);
  });
});

describe("describeCloudSyncStatus", () => {
  it("is a muted dash when there is no snapshot or no cloud identity", () => {
    expect(describeCloudSyncStatus(null, DRAINED)).toMatchObject({
      label: "—",
      tone: "muted",
    });
    expect(
      describeCloudSyncStatus({ ...CAUGHT_UP, identified: false }, DRAINED)
    ).toMatchObject({ label: "—", tone: "muted" });
  });

  it("shows the whole-app remaining count while a walk drains", () => {
    const status = describeCloudSyncStatus(
      {
        ...CAUGHT_UP,
        caughtUp: false,
        backfilling: true,
        pendingBackfillSessions: 42,
      },
      resolveCloudSyncBacklog(
        readiness([
          {
            lane: SyncLaneId.SessionMetadata,
            state: SyncLaneDrainState.Draining,
            itemsRemaining: 42,
          },
        ])
      )
    );
    expect(status.tone).toBe("pending");
    expect(status.label).toBe("Syncing (42 left)");
    expect(status.detail).toContain(
      "42 items still to upload to your workspace"
    );
  });

  it("tints the in-progress label a warning when items are already dead-lettered", () => {
    // Review (mikeangstadt): a poison row on a long walk must not hide behind a
    // clean "Syncing (N)" until the terminal summary — surface it mid-backfill.
    const status = describeCloudSyncStatus(
      {
        ...CAUGHT_UP,
        caughtUp: false,
        backfilling: true,
        pendingBackfillSessions: 42,
        deadLetteredSessions: 3,
      },
      resolveCloudSyncBacklog(
        readiness([
          {
            lane: SyncLaneId.SessionMetadata,
            state: SyncLaneDrainState.Draining,
            itemsRemaining: 42,
            deadLetteredCount: 3,
            unmeasuredRows: 0,
          },
        ])
      )
    );
    expect(status.tone).toBe("warning");
    expect(status.label).toBe("Syncing (42 left)");
    expect(status.detail).toContain("3 items could not be uploaded");
  });

  it("settles to 'Up to date' only when every lane owes nothing", () => {
    expect(describeCloudSyncStatus(CAUGHT_UP, DRAINED)).toMatchObject({
      label: "Up to date",
      tone: "success",
    });
  });

  it("warns when nothing is left to attempt but a lane gave up", () => {
    const status = describeCloudSyncStatus(
      CAUGHT_UP,
      resolveCloudSyncBacklog(
        readiness([
          {
            lane: SyncLaneId.SessionMetadata,
            state: SyncLaneDrainState.DrainedWithDeadLetters,
            deadLetteredCount: 2,
            unmeasuredRows: 0,
          },
        ])
      )
    );
    expect(status.tone).toBe("warning");
    expect(status.label).toBe("Synced with issues");
    expect(status.detail).toContain("2 items could not be uploaded");
  });

  it("marks a lower-bound remainder as a floor rather than an exact count", () => {
    const status = describeCloudSyncStatus(
      { ...CAUGHT_UP, caughtUp: false },
      resolveCloudSyncBacklog(
        readiness([
          {
            lane: SyncLaneId.InvocationParts,
            state: SyncLaneDrainState.Draining,
            itemsRemaining: 1499,
            itemsRemainingIsLowerBound: true,
          },
        ])
      )
    );
    expect(status.label).toBe("Syncing (1,499+ left)");
    expect(status.detail).toContain("at least 1,499 items");
  });

  it("says 'Checking…' — never 'Up to date' — when nobody has measured yet", () => {
    // The first ~60s of every launch (ISS-5749), and any older main process
    // that omits `cloudReadReadiness`. An uncomputable state is named, not
    // rendered as its happy value.
    expect(describeCloudSyncStatus(CAUGHT_UP, UNKNOWN)).toMatchObject({
      label: "Checking…",
      tone: "muted",
    });
  });

  it("still warns about a dead-letter it knows of even when the backlog is unmeasured", () => {
    // The per-lane counts are live per poll; the backlog is the burn-down's last
    // 60s sample. An abandoned item known to either source must surface.
    const status = describeCloudSyncStatus(
      { ...CAUGHT_UP, deadLetteredSessions: 2 },
      UNKNOWN
    );
    expect(status.tone).toBe("warning");
    expect(status.detail).toContain("2 items could not be uploaded");
    // NOT "Synced with issues": "Synced" is a completeness claim, and this is
    // the branch where completeness is exactly what is unestablished. Saying it
    // here would be the ISS-5768 defect moved one branch over.
    expect(status.label).toBe("Sync issues");
    expect(status.detail).toContain("Still checking whether the rest");
  });
});

/**
 * ISS-5768 — the reported contradiction, as one screen.
 *
 * Two indicators, one machine, opposite answers: the `Cloud (partial)` badge
 * read the whole-app aggregate and said 2,985 items were still on the device
 * with 1 abandoned, while the History Sync cell read the session lane alone and
 * said "Up to date".
 */
describe("ISS-5768: no indicator may claim complete while any lane owes work", () => {
  it("does not read 'Up to date' with the session lanes drained and the component inventory still owing", () => {
    const backlog = resolveCloudSyncBacklog(MIKES_MACHINE);
    const status = describeCloudSyncStatus(
      // Exactly the reported state: `caughtUp` true, both per-lane dead-letter
      // counts zero, because the abandoned item is in a lane this payload
      // cannot represent.
      { ...CAUGHT_UP, caughtUp: true, deadLetteredComponents: 0 },
      backlog
    );
    expect(status.label).not.toBe("Up to date");
    expect(status.tone).not.toBe("success");
    expect(status.label).toBe("Syncing (2,985 left)");
  });

  it("quotes the same count the cutover badge quotes, so the two cannot disagree", () => {
    const backlog = resolveCloudSyncBacklog(MIKES_MACHINE);
    const status = describeCloudSyncStatus({ ...CAUGHT_UP }, backlog);
    // The badge's own numbers, from the same aggregate.
    expect(backlog.itemsRemaining).toBe(2985);
    expect(backlog.deadLetteredCount).toBe(1);
    expect(status.detail).toContain(
      "2,985 items still to upload to your workspace"
    );
    expect(status.detail).toContain("1 item could not be uploaded");
  });

  it("surfaces a dead-letter from a lane CloudSyncProgress has no field for", () => {
    // The invocation-parts, transcript-archive and trace-comment lanes have no
    // representation in `CloudSyncProgress`. Before ISS-5768 an item abandoned
    // in any of them rendered a clean "Up to date".
    for (const lane of [
      SyncLaneId.InvocationParts,
      SyncLaneId.TranscriptArchive,
      SyncLaneId.TraceComments,
    ]) {
      const status = describeCloudSyncStatus(
        CAUGHT_UP,
        resolveCloudSyncBacklog(
          readiness([
            { lane: SyncLaneId.SessionMetadata },
            {
              lane,
              state: SyncLaneDrainState.DrainedWithDeadLetters,
              deadLetteredCount: 1,
              unmeasuredRows: 0,
            },
          ])
        )
      );
      expect(status.label).toBe("Synced with issues");
      expect(status.tone).toBe("warning");
    }
  });

  it("counts a lane added later by default rather than silently excluding it", () => {
    const status = describeCloudSyncStatus(
      CAUGHT_UP,
      resolveCloudSyncBacklog(
        readiness([
          { lane: SyncLaneId.SessionMetadata },
          {
            lane: "a_lane_added_later" as SyncLaneId,
            state: "some_future_state" as SyncLaneDrainState,
            itemsRemaining: 9,
          },
        ])
      )
    );
    expect(status.label).toBe("Syncing (9 left)");
    expect(status.tone).toBe("pending");
  });
});

/**
 * ISS-6206 — the History Sync cell must not call a lane that never ran "Up to
 * date", and must not print one cross-lane total whose units do not add up.
 * Both behaviors ride the closed-by-default `stoppedLaneReadiness` Labs gate,
 * which these cases exercise by resolving the backlog with and without it.
 */
describe("describeCloudSyncStatus — stopped lanes and mixed units (ISS-6206)", () => {
  const STRICT = { strictLaneReadiness: true };

  it("stops saying 'Up to date' when a lane never started", () => {
    const backlog = resolveCloudSyncBacklog(
      readiness([
        { lane: SyncLaneId.SessionMetadata },
        {
          lane: SyncLaneId.TranscriptArchive,
          state: SyncLaneDrainState.NeverStarted,
        },
      ]),
      STRICT
    );

    expect(backlog.state).toBe(CloudSyncBacklogState.Unknown);
    expect(describeCloudSyncStatus(CAUGHT_UP, backlog)).toMatchObject({
      label: "Checking…",
    });
  });

  it("stops saying 'Up to date' when a lane's gate is shut", () => {
    const backlog = resolveCloudSyncBacklog(
      readiness([
        { lane: SyncLaneId.SessionMetadata },
        {
          lane: SyncLaneId.TraceComments,
          state: SyncLaneDrainState.IdleNotRunning,
        },
      ]),
      STRICT
    );

    expect(describeCloudSyncStatus(CAUGHT_UP, backlog).label).not.toBe(
      "Up to date"
    );
  });

  it("still says 'Up to date' when every lane genuinely drained", () => {
    // The counterfactual guard: the fix must not make the cell permanently
    // unable to report a caught-up machine.
    const backlog = resolveCloudSyncBacklog(
      readiness([
        { lane: SyncLaneId.SessionMetadata },
        { lane: SyncLaneId.TranscriptArchive },
      ]),
      STRICT
    );

    expect(describeCloudSyncStatus(CAUGHT_UP, backlog)).toMatchObject({
      label: "Up to date",
    });
  });

  it("reports a mixed-unit backlog per lane instead of one summed total", () => {
    const backlog = resolveCloudSyncBacklog(
      readiness([
        {
          lane: SyncLaneId.SessionMetadata,
          state: SyncLaneDrainState.Draining,
          itemsRemaining: 2900,
        },
        {
          lane: SyncLaneId.TranscriptArchive,
          state: SyncLaneDrainState.Draining,
          itemsRemaining: 12,
        },
      ]),
      STRICT
    );
    const status = describeCloudSyncStatus(CAUGHT_UP, backlog);

    expect(status.label).toBe(
      "Syncing (2,900 sessions and 12 transcripts left)"
    );
    expect(status.detail).toContain("2,900 sessions and 12 transcripts");
    // 2,900 outbox rows plus 12 transcript files is not "2,912" of anything.
    expect(status.label).not.toContain("2,912");
    expect(status.detail).not.toContain("2,912");
  });

  it("hedges every lane's count while the import is still discovering history", () => {
    // ISS-6206 (wongk review on #5050). `resolveImportPendingBacklog` set the
    // floor on the AGGREGATE only, but both renderers prefer `laneRemainders`
    // once strict mode populates it — so the hedge never reached the copy that
    // was actually shown, and the cell printed a flat "2,985 activity records"
    // while discovery was still finding more.
    const backlog = resolveCloudSyncBacklog(
      {
        ...readiness([
          {
            lane: SyncLaneId.ComponentInventory,
            state: SyncLaneDrainState.Draining,
            itemsRemaining: 2985,
          },
        ]),
        importComplete: false,
      },
      STRICT
    );
    const status = describeCloudSyncStatus(CAUGHT_UP, backlog);

    expect(
      backlog.laneRemainders.every(
        (lane) => lane.itemsRemainingIsLowerBound === true
      )
    ).toBe(true);
    expect(status.label).toBe("Syncing (at least 2,985 activity records left)");
    expect(status.detail).toContain("at least 2,985 activity records");
  });

  it("drops the hedge once the import has finished discovering", () => {
    // The counterfactual: the floor must be the import's doing, not permanent.
    const backlog = resolveCloudSyncBacklog(
      readiness([
        {
          lane: SyncLaneId.ComponentInventory,
          state: SyncLaneDrainState.Draining,
          itemsRemaining: 2985,
        },
      ]),
      STRICT
    );

    expect(describeCloudSyncStatus(CAUGHT_UP, backlog).label).toBe(
      "Syncing (2,985 activity records left)"
    );
  });

  it("keeps the pre-ISS-6206 total when the Labs gate is closed", () => {
    // The flag-off half. This fails if the new copy is applied unconditionally.
    const backlog = resolveCloudSyncBacklog(
      readiness([
        {
          lane: SyncLaneId.SessionMetadata,
          state: SyncLaneDrainState.Draining,
          itemsRemaining: 2900,
        },
        {
          lane: SyncLaneId.TranscriptArchive,
          state: SyncLaneDrainState.Draining,
          itemsRemaining: 12,
        },
      ])
    );

    expect(describeCloudSyncStatus(CAUGHT_UP, backlog).label).toBe(
      "Syncing (2,912 left)"
    );
  });
});

describe("describeCloudSyncStatus — no lane is unreachable under the cap (ISS-6206 review)", () => {
  // shafty023 review on #5050: the label used to name the two LARGEST lanes,
  // which ranked a transcript-file count against an activity-row count as if
  // they were the same quantity. The order is canonical now, so the cap can
  // land on any lane — which makes it load-bearing that the DETAIL names every
  // lane, and that is what this asserts.
  const MIXED_UNIT_LANES = [
    {
      lane: SyncLaneId.SessionMetadata,
      state: SyncLaneDrainState.Draining,
      itemsRemaining: 3,
    },
    {
      lane: SyncLaneId.TranscriptArchive,
      state: SyncLaneDrainState.Draining,
      itemsRemaining: 7,
    },
    {
      lane: SyncLaneId.ComponentInventory,
      state: SyncLaneDrainState.Draining,
      itemsRemaining: 2985,
    },
  ];

  it("caps the label in canonical lane order", () => {
    const backlog = resolveCloudSyncBacklog(readiness(MIXED_UNIT_LANES), {
      strictLaneReadiness: true,
    });

    expect(describeCloudSyncStatus(CAUGHT_UP, backlog).label).toBe(
      // wongk review on #5050: "and 1 other kind", not "and 1 more" — the
      // collapsed clause counts lanes, and it sat between two item counts where
      // a bare "1" read as one more item on a lane owing 2,985.
      "Syncing (3 sessions, 7 transcripts and 1 other kind left)"
    );
  });

  it("names the collapsed lane in full in the detail", () => {
    const backlog = resolveCloudSyncBacklog(readiness(MIXED_UNIT_LANES), {
      strictLaneReadiness: true,
    });

    expect(describeCloudSyncStatus(CAUGHT_UP, backlog).detail).toContain(
      "2,985 activity records"
    );
  });
});

/**
 * ISS-6206 (wongk review on #5050): the IPC schema must reject state/count
 * combinations `classifyLaneDrainState` can never emit.
 *
 * Each of these validates field by field, so before the cross-field rule they
 * reached the aggregate's zero-total branch and came back as a SETTLED
 * `laneReadinessUnattested` — the marker that tells startup it may stop waiting
 * and dismiss. A payload we cannot trust must degrade to the PENDING unknown
 * instead, which never dismisses anything.
 */
describe("parseStrictCloudSyncBacklog — impossible lanes never settle", () => {
  it("rejects draining with nothing remaining", () => {
    const backlog = parseStrictCloudSyncBacklog({
      cloudReadReadiness: readiness([
        { state: SyncLaneDrainState.Draining, itemsRemaining: 0 },
      ]),
    });

    expect(backlog.state).toBe(CloudSyncBacklogState.Unknown);
    expect(backlog.laneReadinessUnattested).toBe(false);
    // A rejected payload resolves the `null` snapshot, whose total is unknown.
    // An accepted one would have measured a real `0` here, so this is what
    // separates "refused" from "accepted and found empty".
    expect(backlog.itemsRemaining).toBeNull();
  });

  it("rejects remaining_unknown with a measured zero and no unmeasured rows", () => {
    const backlog = parseStrictCloudSyncBacklog({
      cloudReadReadiness: readiness([
        {
          itemsRemaining: 0,
          state: SyncLaneDrainState.RemainingUnknown,
          unmeasuredRows: 0,
        },
      ]),
    });

    expect(backlog.state).toBe(CloudSyncBacklogState.Unknown);
    expect(backlog.laneReadinessUnattested).toBe(false);
    expect(backlog.itemsRemaining).toBeNull();
  });

  it("accepts remaining_unknown once something is genuinely unmeasured", () => {
    // The counterfactual: the same state, with the condition that actually
    // produces it. Without this the two rejections above would pass on a
    // validator that refuses `remaining_unknown` outright.
    const backlog = parseStrictCloudSyncBacklog({
      cloudReadReadiness: readiness([
        {
          itemsRemaining: 0,
          state: SyncLaneDrainState.RemainingUnknown,
          unmeasuredRows: 3,
        },
      ]),
    });

    // Accepted: the lane's own measured remainder survives as a real `0`, and
    // the aggregate answers `unknown` because of the unclassified rows rather
    // than because the payload was refused.
    expect(backlog.state).toBe(CloudSyncBacklogState.Unknown);
    expect(backlog.itemsRemaining).toBe(0);
  });

  it("still leaves a stopped lane free to carry any counts", () => {
    // `classifyLaneDrainState` answers never_started/idle_not_running from
    // liveness and returns before it reads a count, so a shut gate holding a
    // real queue is a legitimate payload and must survive the schema.
    const backlog = parseStrictCloudSyncBacklog({
      cloudReadReadiness: readiness([
        {
          itemsRemaining: 41,
          state: SyncLaneDrainState.IdleNotRunning,
        },
      ]),
    });

    expect(backlog.state).toBe(CloudSyncBacklogState.Outstanding);
    expect(backlog.itemsRemaining).toBe(41);
  });
});
