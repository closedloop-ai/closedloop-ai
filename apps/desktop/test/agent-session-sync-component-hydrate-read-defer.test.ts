/**
 * ISS-10910 (whitlockk review), ISS-11389: a component-lane local read that keeps
 * rejecting — the durable cursor, the cursor page, or the row load — is a
 * lane-wide unavailable DB, so it must take the environmental wall-clock path
 * (`main/sync/AGENTS.md` invariants 4 and 5) instead of re-reading on every
 * tick forever. Drives the REAL lane over fakes that reject on demand; the
 * clock is `Date` only, so the lane-run write chain still settles on real
 * immediates.
 */
import {
  LaneGiveUpSource,
  SyncLane,
  SyncReason,
} from "@closedloop-ai/telemetry-contract/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentComponentSyncLaneOptions } from "../src/main/agent-sync/agent-component-sync-lane-contract.js";
import { AgentComponentSyncLane } from "../src/main/agent-sync/agent-session-sync-component-lane.js";
import {
  type AgentSessionSyncSource,
  buildAgentComponentSyncSourceKey,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import type { PersistedLaneRun } from "../src/main/agent-sync/sync-cursor-state-source.js";
import type { PersistedLaneRunRead } from "../src/main/sync/lane-run-policy.js";
import { reportSyncLaneGaveUp } from "../src/main/telemetry/sync-lane-give-up-telemetry.js";
import { DbStoreOpDeadlineError } from "../src/shared/db-store-op-deadline-error.js";
import {
  LANE_STALL_CEILING_MS,
  LANE_STALL_RETRY_FLOOR_MS,
} from "../src/shared/lane-stall-clock.js";
import {
  acceptedResult,
  laneFailureResult,
  syncedFor,
} from "./agent-session-sync-component-test-utils.js";

// Mocked so the give-up announcement is directly assertable, as in
// `agent-component-lane-give-up.test.ts`.
vi.mock("../src/main/telemetry/sync-lane-give-up-telemetry.js", () => ({
  reportSyncLaneGaveUp: vi.fn(),
  reportSyncLaneReArmed: vi.fn(),
  clearSyncLaneGiveUpAnnouncement: vi.fn(),
}));

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const T0_MS = Date.parse("2026-09-28T08:00:00.000Z");
const TARGET_A = "target-a";
const TARGET_B = "target-b";
const LOAD_OP = "syncSource.loadSyncState";

/** Drain the lane-run write chain (one macrotask hop; see the give-up suite). */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * The real lane over a store whose durable-cursor read, cursor page and row
 * load each reject while their flag holds, and a cloud that fails lane-wide
 * unless `cloudUp`, so every tick that reaches a send charges the same
 * environmental clock.
 */
function makeLane(
  seededRun: PersistedLaneRunRead = {},
  deadLetteredIds: string[] = []
) {
  const control = {
    readFails: true,
    cursorFails: false,
    rowsFail: false,
    drained: false,
    cloudUp: false,
    target: TARGET_A,
    /** Holds the next durable-cursor read open until it settles, then rejects. */
    readHeld: null as Promise<void> | null,
  };
  const reads: string[] = [];
  const cursorReads: string[] = [];
  const sends: string[][] = [];
  const runWrites: { key: string; run: PersistedLaneRun }[] = [];
  const lastSeenAt = new Date(T0_MS - HOUR_MS).toISOString();
  const source = {
    loadSyncState: (key: string) => {
      reads.push(key);
      const held = control.readHeld;
      if (held) {
        control.readHeld = null;
        return held.then(() =>
          Promise.reject(
            new DbStoreOpDeadlineError(LOAD_OP, HOUR_MS, HOUR_MS + 1)
          )
        );
      }
      if (control.readFails) {
        return Promise.reject(
          new DbStoreOpDeadlineError(LOAD_OP, HOUR_MS, HOUR_MS + 1)
        );
      }
      return Promise.resolve({
        observedTopUpdatedAt: null,
        observedIdsAtTopUpdatedAt: [],
        deadLetteredIds,
        ...seededRun,
      });
    },
    recordLaneRun: (key: string, run: PersistedLaneRun) => {
      runWrites.push({ key, run });
    },
  } as unknown as AgentSessionSyncSource;
  const options: AgentComponentSyncLaneOptions = {
    getSource: () => source,
    getSyncComputeTargetId: () => control.target,
    listComponentCursorRows: (sinceTs: string) => {
      cursorReads.push(sinceTs);
      if (control.cursorFails) {
        return Promise.reject(new Error("SQLITE_IOERR: disk I/O error"));
      }
      return Promise.resolve(
        sinceTs === "" && !control.drained
          ? [{ id: "c-a", last_seen_at: lastSeenAt }]
          : []
      );
    },
    loadComponentRows: (ids: string[]) =>
      control.rowsFail
        ? Promise.reject(new Error("SQLITE_IOERR: disk I/O error"))
        : Promise.resolve(ids.map((id) => syncedFor(id, lastSeenAt))),
    sendComponents: (payload) => {
      sends.push(payload.components.map((component) => component.externalId));
      return Promise.resolve(
        control.cloudUp ? acceptedResult() : laneFailureResult()
      );
    },
  };
  const lane = new AgentComponentSyncLane(options, {
    getSourceStateGeneration: () => 1,
    isStarted: () => true,
  });
  /** One tick at `atMs`, settled through the lane-run write chain. */
  const tickAt = async (atMs: number) => {
    vi.setSystemTime(atMs);
    await lane.syncOnce();
    await settle();
  };
  /** What `sync_state.lane_stalled_since` holds: the last write, else the seed. */
  const durableOrigin = () =>
    runWrites.length > 0
      ? runWrites.at(-1)?.run.laneStalledSince
      : (seededRun.laneStalledSince ?? null);
  return {
    lane,
    control,
    reads,
    cursorReads,
    sends,
    runWrites,
    tickAt,
    durableOrigin,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0_MS);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a component-lane cursor read that keeps rejecting (ISS-10910)", () => {
  it("is paced, gives up at the 24h ceiling, and lands the give-up durably once the row answers", async () => {
    const { control, reads, runWrites, tickAt } = makeLane();

    await tickAt(T0_MS);
    await tickAt(T0_MS + MINUTE_MS);
    // Paced: the minute-later tick is inside the first rung and reads nothing.
    expect(reads).toHaveLength(1);

    // The 5s poll, sampled once a minute: nothing gives up inside the ceiling...
    const ceilingMs = T0_MS + LANE_STALL_CEILING_MS;
    for (let at = T0_MS + 2 * MINUTE_MS; at < ceilingMs; at += MINUTE_MS) {
      await tickAt(at);
    }
    expect(reportSyncLaneGaveUp).not.toHaveBeenCalled();
    // ...and a paced read past it does.
    const outageEndMs = ceilingMs + 2 * HOUR_MS;
    for (let at = ceilingMs; at <= outageEndMs; at += MINUTE_MS) {
      await tickAt(at);
    }
    expect(reportSyncLaneGaveUp).toHaveBeenCalledWith(
      expect.objectContaining({
        lane: SyncLane.ComponentInventory,
        reason: SyncReason.LocalReadFailed,
      })
    );
    // Nothing was written while the row could not be consulted.
    expect(runWrites).toEqual([]);

    // The store answers again; the cloud is still down, so the re-armed
    // attempt fails and the give-up is written beside the run it measured.
    control.readFails = false;
    const reArmBoundMs = outageEndMs + LANE_STALL_CEILING_MS;
    for (
      let at = outageEndMs + MINUTE_MS;
      runWrites.length === 0 && at <= reArmBoundMs;
      at += MINUTE_MS
    ) {
      await tickAt(at);
    }
    expect(runWrites.at(-1)?.run).toMatchObject({
      laneStalledSince: new Date(T0_MS).toISOString(),
      laneGaveUpSource: LaneGiveUpSource.EnvironmentalGate,
    });
    expect(runWrites.at(-1)?.run.laneGaveUpAt).not.toBeNull();
  });
});

describe("the run a failed cursor read opened, once the row answers (ISS-10910)", () => {
  const OLDER_ORIGIN = new Date(T0_MS - 20 * HOUR_MS).toISOString();

  it.each([
    {
      row: "an older run",
      seeded: { laneStalledSince: OLDER_ORIGIN },
      origin: OLDER_ORIGIN,
    },
    {
      row: "no run",
      seeded: {},
      origin: new Date(T0_MS).toISOString(),
    },
  ])(
    "keeps the earlier origin when the row holds $row",
    async ({ seeded, origin }) => {
      const { control, tickAt, durableOrigin } = makeLane(seeded);
      await tickAt(T0_MS);

      control.readFails = false;
      await tickAt(T0_MS + LANE_STALL_RETRY_FLOOR_MS);

      expect(durableOrigin()).toBe(origin);
    }
  );

  it("does not hand a failed read's run to the next compute target", async () => {
    const { control, runWrites, tickAt } = makeLane();
    await tickAt(T0_MS);

    control.readFails = false;
    control.target = TARGET_B;
    const targetBFailureMs = T0_MS + LANE_STALL_RETRY_FLOOR_MS;
    await tickAt(targetBFailureMs);

    expect(runWrites).toHaveLength(1);
    expect(runWrites[0]?.key).toBe(buildAgentComponentSyncSourceKey(TARGET_B));
    expect(runWrites[0]?.run.laneStalledSince).toBe(
      new Date(targetBFailureMs).toISOString()
    );
  });

  it("does not let a read that settles after a reset drop the next target's run", async () => {
    const { lane, control, runWrites, tickAt } = makeLane();
    let releaseStaleRead: () => void = () => undefined;
    control.readHeld = new Promise<void>((resolve) => {
      releaseStaleRead = resolve;
    });
    const staleRun = lane.syncOnce();

    // What `resetSourceState()` does to the lane, then target B's own read
    // fails and opens B's run while A's read is still open.
    lane.clearCursorState();
    lane.clearInFlightState();
    control.target = TARGET_B;
    await tickAt(T0_MS);

    releaseStaleRead();
    await staleRun;
    await settle();

    control.readFails = false;
    await tickAt(T0_MS + LANE_STALL_RETRY_FLOOR_MS);

    expect(runWrites.at(-1)?.key).toBe(
      buildAgentComponentSyncSourceKey(TARGET_B)
    );
    expect(runWrites.at(-1)?.run.laneStalledSince).toBe(
      new Date(T0_MS).toISOString()
    );
  });
});

describe("a component-lane read that keeps rejecting after hydration (ISS-11389)", () => {
  const PASS_MS = 5 * MINUTE_MS;

  it.each([
    { arm: "cursor-read-failed", flag: "cursorFails", drained: false },
    { arm: "load-rows-failed", flag: "rowsFail", drained: false },
    // A drained cursor re-attempts a due dead letter, through the same row load.
    { arm: "dead-letter-load-failed", flag: "rowsFail", drained: true },
  ] as const)(
    "$arm is paced, gives up naming the cause, and the answered send clears the run",
    async ({ flag, drained }) => {
      const { control, cursorReads, sends, runWrites, tickAt, durableOrigin } =
        makeLane({}, drained ? ["c-dead"] : []);
      control.readFails = false;
      control.cloudUp = true;
      control.drained = drained;
      control[flag] = true;

      await tickAt(T0_MS);
      expect(durableOrigin()).toBe(new Date(T0_MS).toISOString());
      await tickAt(T0_MS + MINUTE_MS);
      // Paced: the minute-later tick is inside the first rung and reads nothing.
      expect(cursorReads).toHaveLength(1);

      const outageEndMs = T0_MS + LANE_STALL_CEILING_MS + 2 * HOUR_MS;
      for (let at = T0_MS + PASS_MS; at <= outageEndMs; at += PASS_MS) {
        await tickAt(at);
      }
      expect(reportSyncLaneGaveUp).toHaveBeenCalledWith(
        expect.objectContaining({
          lane: SyncLane.ComponentInventory,
          reason: SyncReason.LocalReadFailed,
        })
      );
      expect(runWrites.at(-1)?.run).toMatchObject({
        laneStalledSince: new Date(T0_MS).toISOString(),
        laneGaveUpReason: SyncReason.LocalReadFailed,
      });

      // Stops on the tick that sends, so the clear is that send's and not a
      // later drained tick's.
      control[flag] = false;
      const recoveryBoundMs = outageEndMs + 2 * HOUR_MS;
      for (
        let at = outageEndMs + PASS_MS;
        sends.length === 0 && at <= recoveryBoundMs;
        at += PASS_MS
      ) {
        await tickAt(at);
      }
      expect(sends).toEqual([[drained ? "c-dead" : "c-a"]]);
      expect(runWrites.at(-1)?.run).toMatchObject({
        laneStalledSince: null,
        laneGaveUpAt: null,
      });
    }
  );
});
