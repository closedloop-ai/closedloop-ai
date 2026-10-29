/**
 * @file sync-burndown-cursor-stall-steady-drain.test.ts
 * @description ISS-10429 — `detectCursorStall` treats cleared outbox rows as
 * durable progress only while the row holding the watermark (the session
 * lane's in-memory cursor boundary) moves forward. Rulings by Perrin Upcott,
 * 2026-09-16. PR #5915 removed an earlier suppression that trusted the cleared
 * count alone. The service side of the boundary is pinned in
 * `agent-session-sync-cursor-prefix-restart.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { SessionCursorBoundary } from "../src/main/agent-sync/agent-session-sync-cursor-prefix.js";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import { createDesktopSyncLanes } from "../src/main/agent-sync/desktop-sync-lane-composition.js";
import {
  CursorStallVerdict,
  classifyCursorStall,
  detectCursorStall,
  type SyncLaneBurndown,
  SyncLaneId,
} from "../src/shared/sync-burndown-contract.js";
import { fakeDesktopSyncLaneDeps } from "./fake-desktop-sync-lane-deps.js";
import { burndownLane } from "./support/sync-burndown-fixtures.js";
import {
  buildHarness,
  emptySample,
  refillingSessionOutboxSample,
  SESSION_KEY,
} from "./sync-burndown-reporter-harness.js";

/** A session lane that completed work since the previous sample. */
function stallLane(overrides: Partial<SyncLaneBurndown>): SyncLaneBurndown {
  return burndownLane({ workCompletedSincePrevious: 5, ...overrides });
}

describe("detectCursorStall — ISS-10429: cleared rows count only while the cursor boundary moves", () => {
  // The steady drain: depth flat at 120, cursor value unchanged, 40 rows
  // deleted in the window. The table's oldest row moved forward in every case
  // below, so the verdict turns on the boundary alone.
  const previous = stallLane({
    itemsRemaining: 120,
    workCompletedSincePrevious: 0,
    oldestPendingSinceIso: "2026-08-06T11:00:00.000Z",
    cursorBoundaryValue: "2026-08-06T10:00:00.000Z",
  });
  function steadyDrain(overrides: Partial<SyncLaneBurndown>) {
    return stallLane({
      itemsRemaining: 120,
      queueRowsClearedSincePrevious: 40,
      oldestPendingSinceIso: "2026-08-06T11:01:00.000Z",
      cursorBoundaryValue: "2026-08-06T10:01:00.000Z",
      ...overrides,
    });
  }

  it("stays quiet when rows cleared and the boundary moved forward", () => {
    assert.equal(
      detectCursorStall({ previous, current: steadyDrain({}) }),
      false
    );
  });

  it("still stalls when rows cleared and the table moved but the boundary did not", () => {
    // The gap: the row holding the watermark has no table row, so the table
    // minimum moves past it while it stays stuck.
    const current = steadyDrain({
      cursorBoundaryValue: "2026-08-06T10:00:00.000Z",
    });
    assert.equal(detectCursorStall({ previous, current }), true);
  });

  it("stays quiet when the boundary moved even though the table minimum did not", () => {
    const current = steadyDrain({
      oldestPendingSinceIso: "2026-08-06T11:00:00.000Z",
    });
    assert.equal(detectCursorStall({ previous, current }), false);
  });

  it("still stalls when the boundary moved BACKWARDS", () => {
    // An older row joined the queues; the row that was waiting may still be.
    const current = steadyDrain({
      cursorBoundaryValue: "2026-08-06T09:59:00.000Z",
    });
    assert.equal(detectCursorStall({ previous, current }), true);
  });

  it("keeps today's verdict when the boundary is unknown on either side", () => {
    const previousAbsent = { ...previous };
    Reflect.deleteProperty(previousAbsent, "cursorBoundaryValue");
    const currentAbsent = steadyDrain({});
    Reflect.deleteProperty(currentAbsent, "cursorBoundaryValue");
    const cases: [string, SyncLaneBurndown, SyncLaneBurndown][] = [
      ["previous absent", previousAbsent, steadyDrain({})],
      [
        "previous null",
        { ...previous, cursorBoundaryValue: null },
        steadyDrain({}),
      ],
      ["current absent", previous, currentAbsent],
      ["current null", previous, steadyDrain({ cursorBoundaryValue: null })],
    ];
    for (const [label, before, after] of cases) {
      assert.equal(
        detectCursorStall({ previous: before, current: after }),
        true,
        label
      );
    }
  });

  it("keeps today's verdict when the cleared count is unknown or not a positive safe integer", () => {
    const absent = steadyDrain({});
    Reflect.deleteProperty(absent, "queueRowsClearedSincePrevious");
    const cases: [string, SyncLaneBurndown][] = [
      ["absent", absent],
      ["null", steadyDrain({ queueRowsClearedSincePrevious: null })],
      ["0", steadyDrain({ queueRowsClearedSincePrevious: 0 })],
      ["-3", steadyDrain({ queueRowsClearedSincePrevious: -3 })],
      [
        "Infinity",
        steadyDrain({
          queueRowsClearedSincePrevious: Number.POSITIVE_INFINITY,
        }),
      ],
      ["NaN", steadyDrain({ queueRowsClearedSincePrevious: Number.NaN })],
      ["1.5", steadyDrain({ queueRowsClearedSincePrevious: 1.5 })],
      ["2 ** 53", steadyDrain({ queueRowsClearedSincePrevious: 2 ** 53 })],
    ];
    for (const [label, current] of cases) {
      assert.equal(
        detectCursorStall({ previous, current }),
        true,
        `cleared=${label}`
      );
    }
  });

  it("keeps the backfill exemption: a shrinking queue is quiet even when the boundary did not move", () => {
    const current = steadyDrain({
      itemsRemaining: 80,
      cursorBoundaryValue: "2026-08-06T10:00:00.000Z",
    });
    assert.equal(detectCursorStall({ previous, current }), false);
  });

  it("keeps the never-persisted case: a lane with no cursor still stalls during a steady drain", () => {
    const neverPersisted = {
      durableCursorValue: null,
      durableCursorWrittenAtIso: null,
    };
    assert.equal(
      detectCursorStall({
        previous: { ...previous, ...neverPersisted },
        current: steadyDrain(neverPersisted),
      }),
      true
    );
  });

  it("classifies a steady drain as exempt, and a moved cursor as recovered", () => {
    assert.equal(
      classifyCursorStall({ previous, current: steadyDrain({}) }),
      CursorStallVerdict.SteadyDrain
    );
    assert.equal(
      classifyCursorStall({
        previous,
        current: steadyDrain({
          durableCursorValue: "2026-08-06T10:04:00.000Z",
        }),
      }),
      CursorStallVerdict.Clear,
      "the cursor moved, so this is a recovery even while the drain continues"
    );
    assert.equal(
      classifyCursorStall({
        previous,
        current: steadyDrain({
          cursorBoundaryValue: "2026-08-06T10:00:00.000Z",
        }),
      }),
      CursorStallVerdict.Stalled
    );
  });

  it("treats a queue that emptied as progress, and an already-empty one as not", () => {
    // N → 0 reaches `false` through the shrinking-queue check. With nothing
    // owed there is no boundary, so 0 → 0 cannot suppress on the count alone.
    const empty = {
      itemsRemaining: 0,
      oldestPendingSinceIso: null,
      cursorBoundaryValue: null,
    };
    assert.equal(
      detectCursorStall({ previous, current: steadyDrain(empty) }),
      false,
      "120 → 0"
    );
    assert.equal(
      detectCursorStall({
        previous: { ...previous, ...empty },
        current: steadyDrain(empty),
      }),
      true,
      "0 → 0"
    );
  });
});

describe("SyncBurndownReporter — ISS-10429: the session lane's cursor boundary", () => {
  it("ISS-10429: stays silent while the cursor boundary moves, then alerts when it sticks", async () => {
    // Same flat depth and parked cursor as above. The table's oldest row moves
    // forward on every sample; only the in-memory boundary decides. It moves
    // between the first two samples, then stops while the table keeps moving,
    // which is a stuck row with no table row (a lost enqueue write).
    let boundary: SessionCursorBoundary | null = {
      sourceKey: SESSION_KEY,
      value: "2026-08-06T10:00:00.000Z",
    };
    const harness = buildHarness({
      sample: refillingSessionOutboxSample(120, "2026-08-06T11:00:00.000Z"),
      readSessionCursorBoundary: () => boundary,
    });
    const sessionStalls = () =>
      harness.stalls.filter(
        (stall) => stall.lane === SyncLaneId.SessionMetadata
      );
    const batch = {
      accepted: true,
      payloadBytes: 4096,
      durablyClearedRows: 40,
    };
    harness.reporter.start();
    harness.reporter.recordSessionBatch(batch);
    await harness.reporter.sampleOnce();

    harness.setSample(
      refillingSessionOutboxSample(120, "2026-08-06T11:01:00.000Z")
    );
    boundary = { sourceKey: SESSION_KEY, value: "2026-08-06T10:01:00.000Z" };
    harness.reporter.recordSessionBatch(batch);
    await harness.reporter.sampleOnce();
    const sessionLane = harness.reporter
      .getLatestSnapshot()
      ?.lanes.find((lane) => lane.lane === SyncLaneId.SessionMetadata);
    assert.equal(sessionLane?.cursorBoundaryValue, "2026-08-06T10:01:00.000Z");
    assert.equal(sessionStalls().length, 0, "a steady drain is not a stall");

    harness.setSample(
      refillingSessionOutboxSample(120, "2026-08-06T11:02:00.000Z")
    );
    harness.reporter.recordSessionBatch(batch);
    await harness.reporter.sampleOnce();
    harness.reporter.stop();
    assert.equal(
      sessionStalls().length,
      1,
      "the boundary stopped moving, so the lane is stalled on that row"
    );
  });

  describe("the episode latch across steady-drain samples", () => {
    const B0 = "2026-08-06T10:00:00.000Z";
    const B1 = "2026-08-06T10:01:00.000Z";
    const OLDER = "2026-08-06T09:59:00.000Z";

    /** One pass per boundary value: 40 rows cleared, depth and cursor flat. */
    async function alertsAfter(boundaries: string[]): Promise<number> {
      let boundary: SessionCursorBoundary | null = null;
      const harness = buildHarness({
        sample: refillingSessionOutboxSample(120),
        readSessionCursorBoundary: () => boundary,
      });
      harness.reporter.start();
      for (const value of boundaries) {
        boundary = { sourceKey: SESSION_KEY, value };
        harness.reporter.recordSessionBatch({
          accepted: true,
          payloadBytes: 4096,
          durablyClearedRows: 40,
        });
        await harness.reporter.sampleOnce();
      }
      harness.reporter.stop();
      return harness.stalls.filter(
        (stall) => stall.lane === SyncLaneId.SessionMetadata
      ).length;
    }

    it("pages again when a DIFFERENT row sticks after the paged one left", async () => {
      // B0 sticks and pages; the boundary passes it (the paged row left);
      // then B1 sticks. That is a new stuck row and must page.
      assert.equal(await alertsAfter([B0, B0, B1, B1]), 2);
    });

    it("does not re-page when the boundary only returns to the paged row", async () => {
      // B0 sticks and pages; an older row joins (the boundary drops); it drains
      // and the boundary returns to B0 and sticks there. B0 may never have
      // left, so this is the same episode.
      assert.equal(await alertsAfter([B0, B0, OLDER, B0, B0]), 1);
    });

    it("re-arms once the cursor itself moved", async () => {
      let boundary: SessionCursorBoundary | null = {
        sourceKey: SESSION_KEY,
        value: B0,
      };
      const harness = buildHarness({
        sample: refillingSessionOutboxSample(120),
        readSessionCursorBoundary: () => boundary,
      });
      const pass = async () => {
        harness.reporter.recordSessionBatch({
          accepted: true,
          payloadBytes: 4096,
          durablyClearedRows: 40,
        });
        await harness.reporter.sampleOnce();
      };
      harness.reporter.start();
      await pass();
      await pass();
      const advanced = refillingSessionOutboxSample(120);
      const sessionCursor = advanced.cursorsBySourceKey[SESSION_KEY];
      if (sessionCursor) {
        sessionCursor.observedTopUpdatedAt = "2026-08-06T09:30:00.000Z";
      }
      harness.setSample(advanced);
      boundary = { sourceKey: SESSION_KEY, value: B0 };
      await pass();
      await pass();
      harness.reporter.stop();
      assert.equal(
        harness.stalls.filter(
          (stall) => stall.lane === SyncLaneId.SessionMetadata
        ).length,
        2
      );
    });
  });

  it("ISS-10429: ignores a boundary read under another identity", async () => {
    // The boundary moves, but it belongs to a different source key from the
    // one this sample counted, so it is unknown and cannot suppress.
    let boundary: SessionCursorBoundary | null = {
      sourceKey: "agent_sessions:ct-other",
      value: "2026-08-06T10:00:00.000Z",
    };
    const harness = buildHarness({
      sample: refillingSessionOutboxSample(120),
      readSessionCursorBoundary: () => boundary,
    });
    const batch = {
      accepted: true,
      payloadBytes: 4096,
      durablyClearedRows: 40,
    };
    harness.reporter.start();
    harness.reporter.recordSessionBatch(batch);
    await harness.reporter.sampleOnce();
    boundary = {
      sourceKey: "agent_sessions:ct-other",
      value: "2026-08-06T10:01:00.000Z",
    };
    harness.reporter.recordSessionBatch(batch);
    await harness.reporter.sampleOnce();
    const sessionLane = harness.reporter
      .getLatestSnapshot()
      ?.lanes.find((lane) => lane.lane === SyncLaneId.SessionMetadata);
    harness.reporter.stop();

    assert.strictEqual(sessionLane?.cursorBoundaryValue, null);
    assert.equal(
      harness.stalls.filter(
        (stall) => stall.lane === SyncLaneId.SessionMetadata
      ).length,
      1
    );
  });
});

describe("createDesktopSyncLanes — ISS-10429: the reporter reads the session service's boundary", () => {
  it("publishes the boundary the composed session service names", async () => {
    // `SESSION_KEY` is `agent_sessions:ct-1`, the key this composition derives
    // for compute target `ct-1`.
    const source = {
      readSyncBurndown: () => Promise.resolve(emptySample()),
    } as unknown as AgentSessionSyncSource;
    const lanes = createDesktopSyncLanes(
      fakeDesktopSyncLaneDeps({
        getSyncComputeTargetId: () => "ct-1",
        getSyncSource: () => source,
      })
    );
    lanes.agentSessionSync.readCursorBoundary = () => ({
      sourceKey: SESSION_KEY,
      value: "2026-08-06T10:00:00.000Z",
    });
    const reporter = lanes.syncBurndownReporter;
    reporter.start();
    try {
      await reporter.sampleOnce();
      const sessionLane = reporter
        .getLatestSnapshot()
        ?.lanes.find((lane) => lane.lane === SyncLaneId.SessionMetadata);
      assert.equal(
        sessionLane?.cursorBoundaryValue,
        "2026-08-06T10:00:00.000Z"
      );
    } finally {
      reporter.stop();
    }
  });
});
