/**
 * ISS-10375 step 1: a readiness payload from a NEWER main process, one that
 * reports a lane this renderer predates, driven through the renderer's
 * production route — `window.desktopApi.getRuntimeStatus` → the shared
 * runtime-status poll → `useCloudSyncBacklog` → the History Sync cell copy.
 *
 * The renderer used to validate an EXACT lane set, so one extra lane failed the
 * whole snapshot and every surface read "Checking…" for as long as the skew
 * lasted. The operator ruled (2026-09-16) that the renderer must tolerate an
 * unknown lane before any main process sends one. Tolerating it must not cost
 * the completeness claim, so the unknown lane is COUNTED by its own reported
 * state: dropping it would let "Up to date" render over work it still owes.
 *
 * Lane ids are literals on purpose. The payload is another build's wire output,
 * and deriving it from this build's `SYNC_LANE_IDS` would let a change to that
 * constant silently change what these cases expect.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CloudSyncBacklog,
  CloudSyncBacklogState,
} from "../../../shared/cloud-read-readiness-contract";
import { DESKTOP_STOPPED_LANE_READINESS_FEATURE_FLAG_KEY } from "../../../shared/stopped-lane-readiness-flag";
import {
  SyncLaneDeadLetteredBasis,
  SyncLaneDrainState,
} from "../../../shared/sync-burndown-contract";
import {
  type CloudSyncProgress,
  describeCloudSyncStatus,
  useCloudSyncBacklog,
} from "../use-cloud-sync-progress";
import { __resetRuntimeStatusPollForTests } from "../use-runtime-status-poll";

// Closed unless a case opens it, which is what ships. Both exports are mocked
// because a subtree reaching for the other variant throws on a missing export.
const enabledFlags = vi.hoisted(() => new Set<string>());
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => enabledFlags.has(key),
  useFeatureFlagEnabledOptional: (key: string) => enabledFlags.has(key),
}));

/** The lanes this build reports, as the wire spells them. */
const CURRENT_LANE_IDS = [
  "session_metadata",
  "invocation_parts",
  "transcript_archive",
  "component_inventory",
] as const;

/** A lane a newer main process could add and this renderer does not know. */
const NEWER_LANE_ID = "future_lane";

const CAUGHT_UP: CloudSyncProgress = {
  identified: true,
  pendingBackfillSessions: 0,
  pendingIncrementalSessions: 0,
  backfilling: false,
  caughtUp: true,
  deadLetteredSessions: 0,
};

type WireLane = Record<string, unknown>;

function wireLane(lane: string, overrides: WireLane = {}): WireLane {
  return {
    lane,
    state: SyncLaneDrainState.Drained,
    resumeBlocked: false,
    itemsRemaining: 0,
    itemsRemainingIsLowerBound: false,
    deadLetteredCount: 0,
    deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
    unmeasuredRows: 0,
    notApplicableReason: null,
    parkedCount: 0,
    ...overrides,
  };
}

/** Every current lane drained, with `overrides` applied by lane id. */
function currentLanes(
  overrides: Partial<Record<(typeof CURRENT_LANE_IDS)[number], WireLane>> = {}
): WireLane[] {
  return CURRENT_LANE_IDS.map((lane) => wireLane(lane, overrides[lane]));
}

function runtimeStatus(lanes: readonly WireLane[]): Record<string, unknown> {
  return {
    cloudSync: CAUGHT_UP,
    cloudReadReadiness: {
      sampledAtIso: "2026-09-16T12:00:00.000Z",
      importComplete: true,
      lanes,
    },
  };
}

/** Serve `status` from the preload and read what the hook resolves it to. */
async function readBacklog(status: unknown): Promise<CloudSyncBacklog> {
  // The poll is module-level and caches its last payload, so a case reading two
  // payloads would get the first one back for the second read.
  __resetRuntimeStatusPollForTests();
  // `ipcRenderer.invoke` hands the renderer a structured clone, never the main
  // process's own object.
  const getRuntimeStatus = vi.fn(() =>
    Promise.resolve(structuredClone(status))
  );
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { getRuntimeStatus },
    writable: true,
  });
  const { result, unmount } = renderHook(() => useCloudSyncBacklog(true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const backlog = result.current;
  unmount();
  // A poll that never ran also resolves the unknown backlog, which would let
  // every rejection case below pass without reading its payload.
  if (getRuntimeStatus.mock.calls.length !== 1) {
    throw new Error("the runtime-status payload was never served");
  }
  return backlog;
}

/**
 * whitlockk review on #7402: `vi.restoreAllMocks()` restores spies, never property
 * descriptors, so `window.desktopApi` installed by a case outlives it and every
 * later file sharing this worker inherits it. Captured before each case and put
 * back after — or removed, when the case installed it on a window that had none.
 */
let desktopApiDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  enabledFlags.clear();
  desktopApiDescriptor = Object.getOwnPropertyDescriptor(window, "desktopApi");
});

afterEach(() => {
  __resetRuntimeStatusPollForTests();
  if (desktopApiDescriptor) {
    Object.defineProperty(window, "desktopApi", desktopApiDescriptor);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a readiness payload from a newer main process (ISS-10375)", () => {
  it("still reads a current-shape payload as caught up", async () => {
    const backlog = await readBacklog(runtimeStatus(currentLanes()));

    expect(backlog.state).toBe(CloudSyncBacklogState.Drained);
    expect(describeCloudSyncStatus(CAUGHT_UP, backlog).label).toBe(
      "Up to date"
    );
  });

  it("admits a lane it does not know, and settles only on that lane's own drained state", async () => {
    const backlog = await readBacklog(
      runtimeStatus([...currentLanes(), wireLane(NEWER_LANE_ID)])
    );

    expect(backlog.state).toBe(CloudSyncBacklogState.Drained);
    expect(backlog.itemsRemaining).toBe(0);
    expect(describeCloudSyncStatus(CAUGHT_UP, backlog).label).toBe(
      "Up to date"
    );
  });

  it("counts the unknown lane's owed work instead of dropping it", async () => {
    const backlog = await readBacklog(
      runtimeStatus([
        ...currentLanes(),
        wireLane(NEWER_LANE_ID, {
          state: SyncLaneDrainState.Draining,
          itemsRemaining: 4,
        }),
      ])
    );

    // Dropping the lane would read Drained here: the known lanes are.
    expect(backlog.state).toBe(CloudSyncBacklogState.Outstanding);
    expect(backlog.itemsRemaining).toBe(4);
    expect(describeCloudSyncStatus(CAUGHT_UP, backlog)).toMatchObject({
      label: "Syncing (4 left)",
      tone: "pending",
    });
  });

  it("holds the verdict at Checking… while the unknown lane cannot size its remainder", async () => {
    const backlog = await readBacklog(
      runtimeStatus([
        ...currentLanes(),
        wireLane(NEWER_LANE_ID, {
          state: SyncLaneDrainState.RemainingUnknown,
          itemsRemaining: null,
        }),
      ])
    );

    expect(backlog.state).toBe(CloudSyncBacklogState.Unknown);
    expect(backlog.itemsRemaining).toBeNull();
    expect(describeCloudSyncStatus(CAUGHT_UP, backlog).label).toBe("Checking…");
  });

  it("reports what the unknown lane gave up on", async () => {
    const backlog = await readBacklog(
      runtimeStatus([
        ...currentLanes(),
        wireLane(NEWER_LANE_ID, {
          state: SyncLaneDrainState.DrainedWithDeadLetters,
          deadLetteredCount: 2,
        }),
      ])
    );

    expect(backlog.state).toBe(CloudSyncBacklogState.Abandoned);
    expect(backlog.deadLetteredCount).toBe(2);
    const cell = describeCloudSyncStatus(CAUGHT_UP, backlog);
    expect(cell.label).toBe("Synced with issues");
    expect(cell.detail).toContain("2 items could not be uploaded");
  });

  it("names the unknown lane's remainder in the generic unit, after the lanes it knows", async () => {
    enabledFlags.add(DESKTOP_STOPPED_LANE_READINESS_FEATURE_FLAG_KEY);
    // The unknown lane comes FIRST on the wire; the breakdown must still lead
    // with the lanes this build can order.
    const backlog = await readBacklog(
      runtimeStatus([
        wireLane(NEWER_LANE_ID, {
          state: SyncLaneDrainState.Draining,
          itemsRemaining: 4,
        }),
        ...currentLanes({
          component_inventory: {
            state: SyncLaneDrainState.Draining,
            itemsRemaining: 3,
          },
        }),
      ])
    );

    expect(backlog.laneRemainders).toEqual([
      {
        lane: "component_inventory",
        itemsRemaining: 3,
        itemsRemainingIsLowerBound: false,
      },
      {
        lane: NEWER_LANE_ID,
        itemsRemaining: 4,
        itemsRemainingIsLowerBound: false,
      },
    ]);
    expect(describeCloudSyncStatus(CAUGHT_UP, backlog)).toMatchObject({
      label: "Syncing (3 activity records and 4 items left)",
      detail:
        "3 activity records and 4 items still to upload to your workspace.",
    });
  });

  it("does not call the machine caught up while the unknown lane has never run", async () => {
    enabledFlags.add(DESKTOP_STOPPED_LANE_READINESS_FEATURE_FLAG_KEY);
    const backlog = await readBacklog(
      runtimeStatus([
        ...currentLanes(),
        wireLane(NEWER_LANE_ID, { state: SyncLaneDrainState.NeverStarted }),
      ])
    );

    expect(backlog.state).toBe(CloudSyncBacklogState.Unknown);
    expect(describeCloudSyncStatus(CAUGHT_UP, backlog).label).toBe("Checking…");
  });

  /**
   * davetho review on #7402: the same payload on the SHIPPED default, where
   * `stoppedLaneReadiness` is closed.
   *
   * With that gate closed a lane that never ran and measured nothing settles
   * `drained`, because `cloudReadLaneOwesWork` is deliberately state-agnostic —
   * that gate IS the staged product change that stops a stopped lane rounding
   * the aggregate up, and this PR neither opened that hole nor may close it for
   * one lane. The operator ruled (2026-09-16) that an unknown lane is counted by
   * its OWN reported state, so it has to settle exactly as the known lane in the
   * identical state does. Both halves are read in one case so a change that
   * splits them fails here rather than growing a second rule for a lane whose
   * only unknown is its name.
   */
  it("settles a never-started unknown lane exactly as a never-started known one, with the shipped flag off", async () => {
    const unknownLaneStopped = await readBacklog(
      runtimeStatus([
        ...currentLanes(),
        wireLane(NEWER_LANE_ID, { state: SyncLaneDrainState.NeverStarted }),
      ])
    );
    const knownLaneStopped = await readBacklog(
      runtimeStatus(
        currentLanes({
          component_inventory: { state: SyncLaneDrainState.NeverStarted },
        })
      )
    );

    expect(unknownLaneStopped.state).toBe(knownLaneStopped.state);
    expect(unknownLaneStopped.state).toBe(CloudSyncBacklogState.Drained);
  });
});

/**
 * The tolerance is for a lane ALONGSIDE the known set, not a loosening of the
 * set. Each of these resolves to the unknown backlog, which a parser rejecting
 * everything would also do — the first two cases above are their counterfactual.
 */
describe("what the renderer still rejects from a newer main process (ISS-10375)", () => {
  it("an unknown lane standing in for a missing known lane", async () => {
    const backlog = await readBacklog(
      runtimeStatus([
        ...currentLanes().filter((lane) => lane.lane !== "component_inventory"),
        wireLane(NEWER_LANE_ID),
      ])
    );

    expect(backlog.state).toBe(CloudSyncBacklogState.Unknown);
  });

  it("an unknown lane reported twice, rather than summing it twice", async () => {
    const owing = wireLane(NEWER_LANE_ID, {
      state: SyncLaneDrainState.Draining,
      itemsRemaining: 4,
    });
    const backlog = await readBacklog(
      runtimeStatus([...currentLanes(), owing, owing])
    );

    expect(backlog.state).toBe(CloudSyncBacklogState.Unknown);
    expect(backlog.itemsRemaining).toBeNull();
  });

  it("an unknown lane whose state its own counts cannot produce", async () => {
    const backlog = await readBacklog(
      runtimeStatus([
        ...currentLanes(),
        wireLane(NEWER_LANE_ID, {
          state: SyncLaneDrainState.Draining,
          itemsRemaining: 0,
        }),
      ])
    );

    expect(backlog.state).toBe(CloudSyncBacklogState.Unknown);
  });

  it("a drain state this build does not know", async () => {
    const backlog = await readBacklog(
      runtimeStatus([
        ...currentLanes(),
        wireLane(NEWER_LANE_ID, { state: "paused_by_newer_build" }),
      ])
    );

    expect(backlog.state).toBe(CloudSyncBacklogState.Unknown);
  });

  /**
   * davetho review on #7402: the blank check must not normalize the id.
   * `z.string().trim()` rewrote `" session_metadata "` into the canonical id
   * before the known-set check ran, so a payload that never carried
   * `session_metadata` satisfied the exact-known-lane requirement and — every
   * other lane drained — reached "Up to date". A padded id is an id this build
   * does not know, and it cannot stand in for the lane it resembles.
   */
  it("a known lane id carrying whitespace, in place of the lane it resembles", async () => {
    const backlog = await readBacklog(
      runtimeStatus([
        ...currentLanes().filter((lane) => lane.lane !== "session_metadata"),
        wireLane(" session_metadata "),
      ])
    );

    expect(backlog.state).toBe(CloudSyncBacklogState.Unknown);
  });

  it.each([
    ["an empty", ""],
    ["a whitespace-only", "  "],
  ])("%s lane id", async (_label, laneId) => {
    const backlog = await readBacklog(
      runtimeStatus([...currentLanes(), wireLane(laneId)])
    );

    expect(backlog.state).toBe(CloudSyncBacklogState.Unknown);
  });
});
