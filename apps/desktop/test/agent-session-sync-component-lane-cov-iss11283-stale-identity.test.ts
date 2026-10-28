/**
 * ISS-11283: branch coverage for the `AgentComponentSyncLane` drained-cursor
 * path when the compute target switches mid-tick. A superseded run must not
 * charge (or clear) the environmental clock: the dead-letter recovery send that
 * throws or reports a lane failure after the switch leaves the lane NOT
 * deferred, and a drained tick that sees the switch leaves an open run open.
 * Store, cursor, and loader are real (see the lane-local harness); only the
 * transport is faked.
 */
import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentSyncSendResult } from "../src/main/agent-sync/agent-component-sync-dead-letter.js";
import { buildAgentComponentSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { LANE_STALL_CEILING_MS } from "../src/shared/lane-stall-clock.js";
import {
  createLaneHarness,
  deleteInventoryRow,
  LANE_TARGET,
  type LaneHarness,
  seedInventoryRow,
} from "./agent-session-sync-component-lane-cov-iss11283-harness.js";
import {
  acceptedResult,
  laneFailureResult,
} from "./agent-session-sync-component-test-utils.js";
import { type OpenTestPrisma, openTestPrisma } from "./prisma-test-utils.js";

const SOURCE_KEY = buildAgentComponentSyncSourceKey(LANE_TARGET);
const OTHER_TARGET = "target-iss11283-other";
const WATERMARK = "2026-09-01T00:00:00.000Z";
const DEAD_LETTER_SEEN_AT = "2026-08-01T00:00:00.000Z";
const LANE_WIDE_FOR_RE = /lane-wide for (\d+)s\)$/;
const T0 = new Date("2026-09-20T12:00:00.000Z");
const TEN_MINUTES_MS = 10 * 60 * 1000;

let opened: OpenTestPrisma;

beforeEach(async () => {
  opened = await openTestPrisma();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await opened.close();
});

/**
 * A lane whose cursor is drained past a seeded dead letter, so the only send it
 * makes is the recovery re-attempt of `dl-1`.
 */
async function drainedLaneWithDueDeadLetter(
  send: (switchTarget: () => void) => Promise<ComponentSyncSendResult>
): Promise<{ harness: LaneHarness; setTarget: (t: string) => void }> {
  await seedInventoryRow(opened, "dl-1", DEAD_LETTER_SEEN_AT);
  let target = LANE_TARGET;
  const harness = createLaneHarness(opened, {
    target: () => target,
    send: () =>
      send(() => {
        target = OTHER_TARGET;
      }),
  });
  await harness.source.advanceSyncState?.(SOURCE_KEY, {
    observedTopUpdatedAt: WATERMARK,
    observedIdsAtTopUpdatedAt: ["zz-last"],
    deadLetteredIds: ["dl-1"],
  });
  return {
    harness,
    setTarget: (t) => {
      target = t;
    },
  };
}

describe("AgentComponentSyncLane dead-letter recovery across a target switch", () => {
  it("defers the next tick when a CURRENT recovery send reports a lane failure", async () => {
    const { harness } = await drainedLaneWithDueDeadLetter(() =>
      Promise.resolve(laneFailureResult())
    );

    await harness.lane.syncOnce();
    await harness.lane.syncOnce();

    expect(harness.sentPayloads).toHaveLength(1);
    expect(harness.cursorReads).toEqual([
      { sinceTs: WATERMARK, sinceId: "zz-last" },
    ]);
  });

  it("does not charge the clock when the target switched during a recovery send that reported a lane failure", async () => {
    const { harness, setTarget } = await drainedLaneWithDueDeadLetter(
      (switchTarget) => {
        switchTarget();
        return Promise.resolve(laneFailureResult());
      }
    );

    await harness.lane.syncOnce();
    setTarget(LANE_TARGET);
    await harness.lane.syncOnce();

    expect(
      harness.sentPayloads.map((p) => p.components.map((c) => c.externalId))
    ).toEqual([["dl-1"], ["dl-1"]]);
    expect(harness.cursorReads).toHaveLength(2);
  });

  it("does not charge the clock when the target switched during a recovery send that threw", async () => {
    const warn = vi.spyOn(gatewayLog, "warn");
    const { harness, setTarget } = await drainedLaneWithDueDeadLetter(
      (switchTarget) => {
        switchTarget();
        return Promise.reject(new Error("socket hang up"));
      }
    );

    await harness.lane.syncOnce();
    setTarget(LANE_TARGET);
    await harness.lane.syncOnce();

    expect(harness.sentPayloads).toHaveLength(2);
    expect(harness.cursorReads).toHaveLength(2);
    expect(warn.mock.calls.map((call) => String(call[1]))).toContain(
      "component sync lane: dead-letter re-attempt threw for 1 component(s): socket hang up; lane-wide, not counting against the row's retry budget"
    );
  });

  it("defers the next tick when a CURRENT recovery send throws", async () => {
    const { harness } = await drainedLaneWithDueDeadLetter(() =>
      Promise.reject(new Error("socket hang up"))
    );

    await harness.lane.syncOnce();
    await harness.lane.syncOnce();

    expect(harness.sentPayloads).toHaveLength(1);
    expect(harness.cursorReads).toHaveLength(1);
  });
});

describe("AgentComponentSyncLane drained tick across a target switch", () => {
  async function runOpenRunScenario(switchOnDrainedTick: boolean): Promise<{
    seconds: number[];
    harness: LaneHarness;
  }> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const warn = vi.spyOn(gatewayLog, "warn");
    await seedInventoryRow(opened, "cmp-a", WATERMARK);
    let target = LANE_TARGET;
    let switchDuringRead = false;
    const harness = createLaneHarness(opened, {
      target: () => target,
      send: () => Promise.resolve(laneFailureResult()),
      afterCursorRead: (rows) => {
        if (switchDuringRead && rows.length === 0) {
          target = OTHER_TARGET;
        }
        return Promise.resolve();
      },
    });

    await harness.lane.syncOnce();
    await deleteInventoryRow(opened, "cmp-a");
    vi.setSystemTime(T0.getTime() + TEN_MINUTES_MS);
    switchDuringRead = switchOnDrainedTick;
    await harness.lane.syncOnce();
    switchDuringRead = false;
    target = LANE_TARGET;
    await seedInventoryRow(opened, "cmp-b", "2026-09-02T00:00:00.000Z");
    await harness.lane.syncOnce();

    return { seconds: laneWideSeconds(warn), harness };
  }

  it("keeps the open environmental run when the drained tick's identity was superseded", async () => {
    const { seconds, harness } = await runOpenRunScenario(true);

    expect(harness.cursorReads).toHaveLength(3);
    expect(seconds).toEqual([0, TEN_MINUTES_MS / 1000]);
  });

  it("closes the environmental run when a current drained tick answers nothing", async () => {
    const { seconds, harness } = await runOpenRunScenario(false);

    expect(harness.cursorReads).toHaveLength(3);
    expect(seconds).toEqual([0, 0]);
    expect(harness.sentPayloads).toHaveLength(2);
  });
});

describe("AgentComponentSyncLane recovery answers on a current identity", () => {
  it("closes the open environmental run when a later recovery send is accepted", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const warn = vi.spyOn(gatewayLog, "warn");
    const results = [
      laneFailureResult(),
      acceptedResult(),
      laneFailureResult(),
    ];
    const { harness } = await drainedLaneWithDueDeadLetter(() =>
      Promise.resolve(results.shift() ?? acceptedResult())
    );

    await harness.lane.syncOnce();
    vi.setSystemTime(T0.getTime() + TEN_MINUTES_MS);
    await harness.lane.syncOnce();
    await harness.lane.whenCursorPersistSettled();
    await seedInventoryRow(opened, "zz-new", "2026-09-02T00:00:00.000Z");
    await harness.lane.syncOnce();

    expect(
      harness.sentPayloads.map((p) => p.components.map((c) => c.externalId))
    ).toEqual([["dl-1"], ["dl-1"], ["zz-new"]]);
    expect(laneWideSeconds(warn)).toEqual([0]);
  });

  it("records the recovery send's own lane-failure reason when the run gives up", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const { harness } = await drainedLaneWithDueDeadLetter(() =>
      Promise.resolve({
        ...laneFailureResult(),
        reason: SyncReason.RateLimited,
      })
    );
    const recordLaneRun = vi.spyOn(harness.source, "recordLaneRun");

    await harness.lane.syncOnce();
    vi.setSystemTime(T0.getTime() + LANE_STALL_CEILING_MS);
    await harness.lane.syncOnce();

    const gaveUp = recordLaneRun.mock.calls
      .map(([, run]) => run)
      .find((run) => run.laneGaveUpAt !== null);
    expect(gaveUp?.laneGaveUpReason).toBe(SyncReason.RateLimited);
    expect(harness.sentPayloads).toHaveLength(2);
  });
});

function laneWideSeconds(warn: { mock: { calls: unknown[][] } }): number[] {
  return warn.mock.calls
    .map((call) => LANE_WIDE_FOR_RE.exec(String(call[1]))?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);
}
