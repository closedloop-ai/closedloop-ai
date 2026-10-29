/**
 * ISS-11283: branch coverage for `AgentComponentSyncLane` over a REAL migrated
 * store (see the lane-local harness). Covers the re-entrant single-flight
 * bounce, the pre-send gate reading a null target, a cursor row that vanishes
 * before its load, a NULL `last_seen_at` row whose persist fails and is
 * re-driven, a persist the caller awaits while it is in flight, a durable
 * dead-letter snapshot written from an epoch position, and the give-up stamp
 * resolving no source.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentComponentSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import {
  createLaneHarness,
  deleteInventoryRow,
  LANE_TARGET,
  seedInventoryRow,
} from "./agent-session-sync-component-lane-cov-iss11283-harness.js";
import {
  acceptedResult,
  flush,
  laneFailureResult,
} from "./agent-session-sync-component-test-utils.js";
import { deferred } from "./deferred.js";
import { type OpenTestPrisma, openTestPrisma } from "./prisma-test-utils.js";

const SOURCE_KEY = buildAgentComponentSyncSourceKey(LANE_TARGET);
const LANE_PREFIX = "component sync lane: ";
const TS_A = "2026-09-01T00:00:00.000Z";

let opened: OpenTestPrisma;

beforeEach(async () => {
  opened = await openTestPrisma();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await opened.close();
});

function loggedMessages(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => String(call[1]));
}

describe("AgentComponentSyncLane single-flight", () => {
  it("bounces a re-entrant syncOnce made before the run handle exists with a resolved promise", async () => {
    await seedInventoryRow(opened, "cmp-1", TS_A);
    let reentrant: Promise<void> | null | undefined;
    let targetReads = 0;
    const harness = createLaneHarness(opened, {
      send: () => Promise.resolve(acceptedResult()),
      target: () => {
        targetReads += 1;
        if (targetReads === 1) {
          reentrant = harness.lane.syncOnce();
        }
        return LANE_TARGET;
      },
    });

    await harness.lane.syncOnce();
    await harness.lane.whenCursorPersistSettled();

    expect(reentrant).toBeInstanceOf(Promise);
    await expect(reentrant).resolves.toBeUndefined();
    expect(harness.cursorReads).toEqual([{ sinceTs: "", sinceId: "" }]);
    expect(harness.sentPayloads).toHaveLength(1);
  });
});

describe("AgentComponentSyncLane pre-send guards", () => {
  it("skips the send when the compute target reads null after the load", async () => {
    await seedInventoryRow(opened, "cmp-1", TS_A);
    const info = vi.spyOn(gatewayLog, "info");
    let target: string | null = LANE_TARGET;
    const send = vi.fn(() => Promise.resolve(acceptedResult()));
    const harness = createLaneHarness(opened, {
      send,
      target: () => target,
      beforeLoad: () => {
        target = null;
        return Promise.resolve();
      },
    });

    await harness.lane.syncOnce();

    expect(send).not.toHaveBeenCalled();
    expect(loggedMessages(info)).toContain(
      `${LANE_PREFIX}egress gate closed or target changed before sending 1 component(s); skipping this batch`
    );
  });

  it("skips the send and keeps the cursor when the row vanished before its load", async () => {
    await seedInventoryRow(opened, "cmp-gone", TS_A);
    const warn = vi.spyOn(gatewayLog, "warn");
    const send = vi.fn(() => Promise.resolve(acceptedResult()));
    const harness = createLaneHarness(opened, {
      send,
      afterCursorRead: async (rows) => {
        for (const row of rows) {
          await deleteInventoryRow(opened, row.id);
        }
      },
    });

    await harness.lane.syncOnce();
    await harness.lane.syncOnce();

    expect(send).not.toHaveBeenCalled();
    expect(loggedMessages(warn)).toContain(
      `${LANE_PREFIX}cursor returned 1 id(s) but row load returned 0 rows`
    );
    expect(harness.cursorReads).toEqual([
      { sinceTs: "", sinceId: "" },
      { sinceTs: "", sinceId: "" },
    ]);
  });
});

describe("AgentComponentSyncLane source-state generation", () => {
  it("drops an accepted batch whose send resolved after the host generation moved", async () => {
    await seedInventoryRow(opened, "cmp-1", TS_A);
    let generation = 1;
    const harness = createLaneHarness(opened, {
      generation: () => generation,
      send: () => {
        generation = 2;
        return Promise.resolve(acceptedResult());
      },
    });
    const advance = vi.spyOn(harness.source, "advanceSyncState");

    await harness.lane.syncOnce();
    await harness.lane.whenCursorPersistSettled();

    expect(harness.sentPayloads).toHaveLength(1);
    expect(advance).not.toHaveBeenCalled();
    expect(harness.lane.hasStaleDurableCursor).toBe(false);
  });
});

describe("AgentComponentSyncLane durable cursor persist", () => {
  it("re-drives a failed persist of a NULL last_seen_at row at the empty-string watermark", async () => {
    await seedInventoryRow(opened, "cmp-null", null);
    const harness = createLaneHarness(opened, {
      send: () => Promise.resolve(acceptedResult()),
    });
    const advance = vi
      .spyOn(harness.source, "advanceSyncState")
      .mockRejectedValueOnce(new Error("db-host exited (code: 0)"));

    await harness.lane.syncOnce();
    await harness.lane.whenCursorPersistSettled();
    expect(harness.lane.hasStaleDurableCursor).toBe(true);

    await harness.lane.syncOnce();
    await harness.lane.whenCursorPersistSettled();

    expect(advance).toHaveBeenCalledTimes(2);
    const [, retried] = advance.mock.calls[1] ?? [];
    expect(retried).toMatchObject({
      observedTopUpdatedAt: "",
      observedIdsAtTopUpdatedAt: ["cmp-null"],
      deadLetteredIds: [],
    });
    expect(harness.lane.hasStaleDurableCursor).toBe(false);
    expect(harness.cursorReads[1]).toEqual({
      sinceTs: "",
      sinceId: "cmp-null",
    });
  });

  it("whenCursorPersistSettled waits for an in-flight durable write", async () => {
    await seedInventoryRow(opened, "cmp-1", TS_A);
    const harness = createLaneHarness(opened, {
      send: () => Promise.resolve(acceptedResult()),
    });
    const realAdvance = harness.source.advanceSyncState?.bind(harness.source);
    const gate = deferred();
    vi.spyOn(harness.source, "advanceSyncState").mockImplementation(
      async (key, state) => {
        await gate.promise;
        await realAdvance?.(key, state);
      }
    );

    await harness.lane.syncOnce();
    let settled = false;
    const waiting = harness.lane.whenCursorPersistSettled().then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    gate.resolve();
    await waiting;

    expect(settled).toBe(true);
    const durable = await harness.source.loadSyncState?.(SOURCE_KEY);
    expect(durable?.observedTopUpdatedAt).toBe(TS_A);
    expect(durable?.observedIdsAtTopUpdatedAt).toEqual(["cmp-1"]);
  });

  it("writes the recovered dead-letter snapshot at the epoch position when the lane never advanced", async () => {
    const harness = createLaneHarness(opened, {
      send: () => Promise.resolve(acceptedResult()),
      afterCursorRead: async (rows) => {
        // A scanner insert lands between the (empty) cursor read and recovery.
        if (rows.length === 0) {
          await seedInventoryRow(opened, "late-1", TS_A);
        }
      },
    });
    await harness.source.advanceSyncState?.(SOURCE_KEY, {
      observedTopUpdatedAt: null,
      observedIdsAtTopUpdatedAt: [],
      deadLetteredIds: ["late-1"],
    });
    const advance = vi.spyOn(harness.source, "advanceSyncState");

    await harness.lane.syncOnce();
    await harness.lane.whenCursorPersistSettled();

    expect(
      harness.sentPayloads.map((p) => p.components.map((c) => c.externalId))
    ).toEqual([["late-1"]]);
    expect(harness.lane.deadLetteredCount).toBe(0);
    expect(advance).toHaveBeenCalledTimes(1);
    const [key, snapshot] = advance.mock.calls[0] ?? [];
    expect(key).toBe(SOURCE_KEY);
    expect(snapshot).toMatchObject({
      observedTopUpdatedAt: "",
      observedIdsAtTopUpdatedAt: [""],
      deadLetteredIds: [],
    });
  });
});

describe("AgentComponentSyncLane give-up stamp source", () => {
  it("names the missing durable lane-run write when no source resolves at reconcile", async () => {
    await seedInventoryRow(opened, "cmp-1", TS_A);
    const warn = vi.spyOn(gatewayLog, "warn");
    const harness = createLaneHarness(opened, {
      send: () => Promise.resolve(laneFailureResult()),
      sourceAvailable: (call) => call === 0,
    });
    const recordLaneRun = vi.spyOn(harness.source, "recordLaneRun");

    await harness.lane.syncOnce();

    expect(recordLaneRun).not.toHaveBeenCalled();
    expect(loggedMessages(warn)).toContain(
      `${LANE_PREFIX}no durable lane run write available; the 24h ceiling is in-memory only and a relaunch restarts it`
    );
  });

  it("writes the lane run through the live source at reconcile", async () => {
    await seedInventoryRow(opened, "cmp-1", TS_A);
    const warn = vi.spyOn(gatewayLog, "warn");
    const harness = createLaneHarness(opened, {
      send: () => Promise.resolve(laneFailureResult()),
    });
    const recordLaneRun = vi.spyOn(harness.source, "recordLaneRun");

    await harness.lane.syncOnce();

    expect(recordLaneRun).toHaveBeenCalledTimes(1);
    const [key, run] = recordLaneRun.mock.calls[0] ?? [];
    expect(key).toBe(SOURCE_KEY);
    expect(run?.laneStalledSince).toEqual(expect.any(String));
    expect(run?.laneGaveUpAt).toBeNull();
    expect(loggedMessages(warn)).not.toContain(
      `${LANE_PREFIX}no durable lane run write available; the 24h ceiling is in-memory only and a relaunch restarts it`
    );
  });
});
