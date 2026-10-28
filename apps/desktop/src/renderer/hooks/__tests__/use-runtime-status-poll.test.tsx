import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CloudReadDeadLetteredBasis,
  CloudSyncBacklogState,
} from "../../../shared/cloud-read-readiness-contract";
import {
  SYNC_LANE_IDS,
  SyncLaneDeadLetteredBasis,
  SyncLaneDrainState,
  SyncLaneId,
} from "../../../shared/sync-burndown-contract";
import { describeUndeliverableItems } from "../../components/import-progress-display";
import {
  type CloudSyncProgress,
  describeCloudSyncStatus,
  useCloudSyncBacklog,
  useCloudSyncProgress,
} from "../use-cloud-sync-progress";
import {
  useIngestProgress,
  useMaintenanceProgress,
} from "../use-ingest-progress";

// FEA-2264: useIngestProgress and useMaintenanceProgress subscribe to a single
// shared getRuntimeStatus poll, so a component that reads BOTH (the first-launch
// banner) makes one IPC round-trip per interval rather than one per hook.
describe("shared runtime-status poll", () => {
  let getRuntimeStatus: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    getRuntimeStatus = vi.fn(() =>
      Promise.resolve({
        ingest: { byHarness: [], total: 0, preparing: true, complete: false },
        maintenance: { active: true, phase: "rebuild" },
      })
    );
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { getRuntimeStatus },
      writable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("polls once per interval no matter how many hooks are active", async () => {
    const { unmount } = renderHook(() => {
      useIngestProgress(true);
      useMaintenanceProgress(true);
    });
    // Flush the immediate poll's resolution so its state update is wrapped.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // First subscriber polls immediately; the second reuses the running poll.
    expect(getRuntimeStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(getRuntimeStatus).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(getRuntimeStatus).toHaveBeenCalledTimes(3);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    // No subscribers left, so the interval is torn down and polling stops.
    expect(getRuntimeStatus).toHaveBeenCalledTimes(3);
  });

  it("stops polling when the only active hook deactivates", async () => {
    const { rerender, unmount } = renderHook(
      ({ active }: { active: boolean }) => useIngestProgress(active),
      { initialProps: { active: true } }
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getRuntimeStatus).toHaveBeenCalledTimes(1);

    rerender({ active: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(getRuntimeStatus).toHaveBeenCalledTimes(1);
    unmount();
  });

  // ISS-7603: the two tests above co-mount hooks that both live in
  // `use-ingest-progress.ts`, so after the six-way split they can no longer tell
  // one shared poll from one poll PER MODULE. These two cross the module
  // boundary — `useIngestProgress` from `use-ingest-progress.ts`,
  // `useCloudSyncProgress` from `use-cloud-sync-progress.ts` — so a second
  // `runtimeStatusListeners` set anywhere fails them on the first assertion.
  it("polls once per interval when the active hooks live in different modules", async () => {
    const { unmount } = renderHook(() => {
      useIngestProgress(true);
      useCloudSyncProgress(true);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Two modules, one poll: a duplicated singleton would make this 2.
    expect(getRuntimeStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(getRuntimeStatus).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(getRuntimeStatus).toHaveBeenCalledTimes(3);
    unmount();
  });

  it("keeps polling until the last subscriber leaves, across modules", async () => {
    const ingest = renderHook(() => useIngestProgress(true));
    const cloudSync = renderHook(() => useCloudSyncProgress(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getRuntimeStatus).toHaveBeenCalledTimes(1);

    ingest.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    // The cloud-sync module still holds the poll, so the interval survives the
    // ingest module's teardown.
    expect(getRuntimeStatus).toHaveBeenCalledTimes(2);

    cloudSync.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    // Last subscriber gone: the shared interval is torn down.
    expect(getRuntimeStatus).toHaveBeenCalledTimes(2);
  });
});

// FEA-3256: the Settings "History Sync" cell was frozen because it read a
// one-shot runtime snapshot captured on mount. useCloudSyncProgress must instead
// advance live as the backfill drains across successive polls.
describe("useCloudSyncProgress live updates", () => {
  let getRuntimeStatus: ReturnType<typeof vi.fn>;

  const cloudSync = (pendingBackfillSessions: number): CloudSyncProgress => ({
    identified: true,
    pendingBackfillSessions,
    pendingIncrementalSessions: 0,
    backfilling: pendingBackfillSessions > 0,
    caughtUp: pendingBackfillSessions === 0,
    deadLetteredSessions: 0,
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reflects each poll's payload rather than pinning the mount snapshot", async () => {
    vi.useFakeTimers();
    // A backfill draining 500 → 250 → 0 across three polls.
    const payloads = [cloudSync(500), cloudSync(250), cloudSync(0)];
    let call = 0;
    getRuntimeStatus = vi.fn(() =>
      Promise.resolve({ cloudSync: payloads[Math.min(call++, 2)] })
    );
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { getRuntimeStatus },
      writable: true,
    });

    const { result, unmount } = renderHook(() => useCloudSyncProgress(true));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current?.pendingBackfillSessions).toBe(500);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current?.pendingBackfillSessions).toBe(250);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current?.pendingBackfillSessions).toBe(0);
    expect(result.current?.caughtUp).toBe(true);

    unmount();
  });

  it("does not poll while inactive", async () => {
    vi.useFakeTimers();
    getRuntimeStatus = vi.fn(() =>
      Promise.resolve({ cloudSync: cloudSync(0) })
    );
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { getRuntimeStatus },
      writable: true,
    });

    const { result, unmount } = renderHook(() => useCloudSyncProgress(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(getRuntimeStatus).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
    unmount();
  });
});

/**
 * ISS-5768: `useCloudSyncBacklog` is what makes the History Sync cell and the
 * startup panel tell the truth about whole-app completeness. It is a thin wrapper
 * over the shared poll, and a thin wrapper is exactly the thing that gets
 * replaced by a constant during a refactor — so pin that it actually reads the
 * live `cloudReadReadiness` off the payload, and that it never invents a drained
 * one when the field is absent.
 */
/**
 * A settled row for every lane the burn-down reports, with the named lanes
 * overridden. The reporter emits every lane on every sample, and ISS-6206's
 * boundary check requires every one of them — so a fixture carrying one lane is
 * not a smaller real payload, it is a malformed one.
 */
function fullLaneSet(
  overrides: Partial<Record<SyncLaneId, Record<string, unknown>>> = {}
): readonly Record<string, unknown>[] {
  return SYNC_LANE_IDS.map((lane) => ({
    lane,
    state: SyncLaneDrainState.Drained,
    itemsRemaining: 0,
    itemsRemainingIsLowerBound: false,
    deadLetteredCount: 0,
    unmeasuredRows: 0,
    ...overrides[lane],
  }));
}

describe("useCloudSyncBacklog", () => {
  let getRuntimeStatus: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function installRuntimeStatus(status: unknown): void {
    getRuntimeStatus = vi.fn(() => Promise.resolve(status));
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { getRuntimeStatus },
      writable: true,
    });
  }

  it("resolves the live cloudReadReadiness payload into the whole-app backlog", async () => {
    installRuntimeStatus({
      cloudReadReadiness: {
        sampledAtIso: "2026-08-10T12:00:00.000Z",
        importComplete: true,
        lanes: fullLaneSet({
          [SyncLaneId.ComponentInventory]: {
            state: SyncLaneDrainState.Draining,
            itemsRemaining: 2985,
          },
        }),
      },
    });
    const { result } = renderHook(() => useCloudSyncBacklog(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state).toBe(CloudSyncBacklogState.Outstanding);
    expect(result.current.itemsRemaining).toBe(2985);
  });

  it("returns the unknown backlog — never a drained one — when the field is absent", async () => {
    // An older main process. "Nobody has looked" must not read as "nothing owed".
    installRuntimeStatus({ cloudSync: { identified: true, caughtUp: true } });
    const { result } = renderHook(() => useCloudSyncBacklog(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state).toBe(CloudSyncBacklogState.Unknown);
    expect(result.current.itemsRemaining).toBeNull();
  });

  it("returns the unknown backlog before the first poll resolves", () => {
    installRuntimeStatus({});
    const { result } = renderHook(() => useCloudSyncBacklog(true));
    expect(result.current.state).toBe(CloudSyncBacklogState.Unknown);
  });
});

/**
 * ISS-5768 (whitlockk review on #4809) — a malformed `cloudReadReadiness` must not
 * take the whole shared poll down with it.
 *
 * `getRuntimeStatus()` is typed `Promise<unknown>`, and one payload is fanned out
 * to every status hook in a SINGLE loop. Treating any present object as a full
 * snapshot meant `{ cloudReadReadiness: {} }` threw on `snapshot.lanes.length`,
 * which aborted that loop — so every listener behind this one never saw the
 * payload — and was then swallowed by the poller's own `.catch()`. The visible
 * result was the worst possible one: a History Sync cell frozen on the last good
 * "Up to date" while the app had stopped being able to measure anything.
 */
describe("useCloudSyncBacklog — malformed readiness payloads", () => {
  let getRuntimeStatus: ReturnType<typeof vi.fn>;

  const DRAINED_PAYLOAD = {
    sampledAtIso: "2026-08-10T12:00:00.000Z",
    importComplete: true,
    lanes: fullLaneSet(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function installPayloads(payloads: readonly unknown[]): void {
    let call = 0;
    getRuntimeStatus = vi.fn(() =>
      Promise.resolve(payloads[Math.min(call++, payloads.length - 1)])
    );
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { getRuntimeStatus },
      writable: true,
    });
  }

  it("drops a drained claim it can no longer verify, and still feeds the hooks behind it", async () => {
    // Poll 1 is a real drained snapshot; poll 2 is the version-skewed partial.
    // The backlog hook subscribes FIRST, so before the fix its throw is what
    // stopped the ingest hook below from ever seeing poll 2.
    installPayloads([
      {
        cloudReadReadiness: DRAINED_PAYLOAD,
        ingest: { byHarness: [], total: 10, processed: 4, complete: false },
      },
      {
        cloudReadReadiness: {},
        ingest: { byHarness: [], total: 10, processed: 9, complete: false },
      },
    ]);

    const { result, unmount } = renderHook(() => ({
      backlog: useCloudSyncBacklog(true),
      ingest: useIngestProgress(true),
    }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.backlog.state).toBe(CloudSyncBacklogState.Drained);
    expect(result.current.ingest?.processed).toBe(4);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    // The stale "Up to date" is gone…
    expect(result.current.backlog.state).toBe(CloudSyncBacklogState.Unknown);
    // …and the listener behind it was not starved of the same payload.
    expect(result.current.ingest?.processed).toBe(9);

    unmount();
  });

  it("rejects a snapshot whose counts are not real counts", async () => {
    // A negative remainder is not a smaller backlog; it is a corrupt one. Under
    // the old assertion it flowed straight into the aggregate's arithmetic.
    installPayloads([
      {
        cloudReadReadiness: {
          ...DRAINED_PAYLOAD,
          lanes: [{ ...DRAINED_PAYLOAD.lanes[0], deadLetteredCount: -3 }],
        },
      },
    ]);
    const { result, unmount } = renderHook(() => useCloudSyncBacklog(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state).toBe(CloudSyncBacklogState.Unknown);
    expect(result.current.deadLetteredCount).toBe(0);
    unmount();
  });

  it("accepts the same snapshot once its counts are real", async () => {
    // The counterfactual for both rejections above: identical shape, valid
    // values. Without it they would pass on a parser that rejects everything.
    installPayloads([{ cloudReadReadiness: DRAINED_PAYLOAD }]);
    const { result, unmount } = renderHook(() => useCloudSyncBacklog(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state).toBe(CloudSyncBacklogState.Drained);
    unmount();
  });

  // ISS-9744 (codex review on #6874): the per-lane dead-letter basis is
  // additive, so a main process older than it sends none — `DRAINED_PAYLOAD`
  // above is literally that payload. Two things have to hold at once, and they
  // pull in opposite directions.
  it("degrades an unlabelled dead-letter count to unmeasured without blocking the drain", async () => {
    installPayloads([{ cloudReadReadiness: DRAINED_PAYLOAD }]);
    const { result, unmount } = renderHook(() => useCloudSyncBacklog(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Under-claim the MEASUREMENT: nothing on the wire said what was counted,
    // so the total may not be presented as an exact one.
    expect(result.current.deadLetteredBasis).toBe(
      CloudReadDeadLetteredBasis.Unmeasured
    );
    // …but never under-claim the VERDICT. Gating "up to date" on a label an old
    // build cannot send would leave it permanently unable to settle — a
    // liveness regression bought with a precision fix.
    expect(result.current.state).toBe(CloudSyncBacklogState.Drained);
    unmount();
  });

  it("labels the total measured once the payload says what each lane counted", async () => {
    // The counterfactual for the degrade above: identical payload plus the
    // basis. Without it, a parser that hardcoded `unmeasured` would pass.
    installPayloads([
      {
        cloudReadReadiness: {
          ...DRAINED_PAYLOAD,
          lanes: fullLaneSet(
            Object.fromEntries(
              SYNC_LANE_IDS.map((lane) => [
                lane,
                {
                  deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
                },
              ])
            )
          ),
        },
      },
    ]);
    const { result, unmount } = renderHook(() => useCloudSyncBacklog(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.deadLetteredBasis).toBe(
      CloudReadDeadLetteredBasis.Measured
    );
    unmount();
  });

  // ISS-6206 (whitlockk review on #5050): every all-lanes predicate downstream is an
  // `every`/`some` over `snapshot.lanes`, so a payload missing four of the five
  // lanes satisfied "all drained" and a duplicated lane was summed twice. The
  // types cannot prevent either — this arrives from a `Promise<unknown>` across
  // IPC — so the boundary has to reject the set itself.
  it("refuses to call one drained lane a drained machine", async () => {
    installPayloads([
      {
        cloudReadReadiness: {
          ...DRAINED_PAYLOAD,
          lanes: DRAINED_PAYLOAD.lanes.slice(0, 1),
        },
      },
    ]);
    const { result, unmount } = renderHook(() => useCloudSyncBacklog(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state).toBe(CloudSyncBacklogState.Unknown);
    unmount();
  });

  it("rejects a payload that repeats a lane instead of double-counting it", async () => {
    const duplicated = fullLaneSet({
      [SyncLaneId.ComponentInventory]: {
        state: SyncLaneDrainState.Draining,
        itemsRemaining: 7,
      },
    });
    installPayloads([
      {
        cloudReadReadiness: {
          ...DRAINED_PAYLOAD,
          // Five entries, but one lane twice and another absent — the shape a
          // truncated or version-skewed payload actually takes.
          lanes: [...duplicated.slice(0, 4), duplicated[3]],
        },
      },
    ]);
    const { result, unmount } = renderHook(() => useCloudSyncBacklog(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state).toBe(CloudSyncBacklogState.Unknown);
    // The duplicate never reached the cross-lane arithmetic (it would have read 14).
    expect(result.current.itemsRemaining).toBeNull();
    unmount();
  });
});

/**
 * ISS-9182 / PLN-2061 M4 (#7758 review): the History Sync cell's
 * undeliverable-items sentence goes away on the next shared-poll sample once the
 * withheld acknowledgement clears the row — no remount, no restart. The mapper
 * half is pinned in `use-cloud-sync-progress.test.ts`; this drives the hooks.
 */
describe("the undeliverable-items sentence across one poll", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function statusWithSessionDeadLetters(count: number) {
    return {
      cloudSync: {
        identified: true,
        pendingBackfillSessions: 0,
        pendingIncrementalSessions: 0,
        backfilling: false,
        caughtUp: true,
        deadLetteredSessions: count,
      },
      cloudReadReadiness: {
        sampledAtIso: "2026-08-10T12:00:00.000Z",
        importComplete: true,
        lanes: fullLaneSet(
          count > 0
            ? {
                [SyncLaneId.SessionMetadata]: {
                  state: SyncLaneDrainState.DrainedWithDeadLetters,
                  deadLetteredCount: count,
                },
              }
            : {}
        ),
      },
    };
  }

  it("repaints the cell on the next sample once the row clears", async () => {
    vi.useFakeTimers();
    const getRuntimeStatus = vi
      .fn()
      .mockResolvedValueOnce(statusWithSessionDeadLetters(1))
      .mockResolvedValue(statusWithSessionDeadLetters(0));
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { getRuntimeStatus },
      writable: true,
    });
    const { result, unmount } = renderHook(() =>
      describeCloudSyncStatus(
        useCloudSyncProgress(true),
        useCloudSyncBacklog(true)
      )
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.detail).toBe(describeUndeliverableItems(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(getRuntimeStatus).toHaveBeenCalledTimes(2);
    expect(result.current.detail).not.toContain(describeUndeliverableItems(1));
    expect(result.current).toMatchObject({
      label: "Up to date",
      tone: "success",
    });
    unmount();
  });
});
