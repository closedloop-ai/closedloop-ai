import type { TraceComment } from "@repo/api/src/types/comment";
import { focusManager } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TraceCommentsDataSource } from "../../../data-source/trace-comments-data-source";
import {
  TRACE_COMMENTS_BACKOFF_REFETCH_INTERVAL_MS,
  TRACE_COMMENTS_IDLE_POLLS_BEFORE_BACKOFF,
  TRACE_COMMENTS_READ_TIMEOUT_MS,
  TRACE_COMMENTS_REFETCH_INTERVAL_MS,
} from "../trace-comments-poll-cadence";
import { useTraceComments } from "../use-trace-comments";
import {
  createWrapper,
  forceDocumentHidden,
  makeTraceComment,
  makeTraceCommentReply,
  restoreDocumentVisibility,
} from "./trace-comments-test-helpers";

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

describe("trace comments poll active gating (PRD-536 E5)", () => {
  // Capture the native `document.hidden`/`visibilityState` descriptors once so
  // each test can force a value and `afterEach` can restore the real jsdom
  // getters — otherwise a forced-hidden state leaks into every later test in the
  // environment and masks real visibility behavior.
  const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
  const originalVisibilityState = Object.getOwnPropertyDescriptor(
    document,
    "visibilityState"
  );

  beforeEach(() => {
    // Pin the focus state. `focusManager` is a module-level singleton with a
    // DOM-backed default subscriber, so an incidental jsdom visibility/focus
    // event would otherwise invoke the hook's focus reset mid-test and clear the
    // idle streak these cadence assertions depend on.
    focusManager.setFocused(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    restoreDocumentVisibility(originalHidden, originalVisibilityState);
    // Hand focus tracking back to the default DOM subscriber.
    focusManager.setFocused(undefined);
  });

  function makeListDataSource() {
    const list = vi.fn<TraceCommentsDataSource["list"]>().mockResolvedValue([]);
    const dataSource: TraceCommentsDataSource = {
      scope: "test",
      list,
      create: vi.fn<TraceCommentsDataSource["create"]>(),
      reply: vi.fn<TraceCommentsDataSource["reply"]>(),
      update: vi.fn<TraceCommentsDataSource["update"]>(),
      delete: vi.fn<TraceCommentsDataSource["delete"]>(),
    };
    return { dataSource, list };
  }

  /**
   * Drives an unchanging thread until the idle back-off engages, detecting the
   * crossover rather than assuming a tick count: the first base-interval tick
   * that produces NO poll is the proof back-off is active. Returns the call count
   * at that point so callers assert deltas.
   *
   * The exact crossover tick is pinned separately in the dedicated idle test;
   * here the point is only to reach the backed-off state reliably.
   */
  async function advanceIntoIdleBackOff(
    list: ReturnType<typeof makeListDataSource>["list"]
  ): Promise<number> {
    for (let i = 0; i < TRACE_COMMENTS_IDLE_POLLS_BEFORE_BACKOFF + 10; i += 1) {
      const before = list.mock.calls.length;
      await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
      if (list.mock.calls.length === before) {
        return before;
      }
    }
    throw new Error("idle back-off never engaged");
  }

  it("polls every interval when the rail is active", async () => {
    vi.useFakeTimers();
    const { dataSource, list } = makeListDataSource();

    renderHook(
      () =>
        useTraceComments({
          target: { type: "session", id: "session-1" },
          onJumpToRow: vi.fn(),
          active: true,
        }),
      { wrapper: createWrapper(dataSource) }
    );

    // Initial mount fetch.
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    // The 2s interval fires the poll again.
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it("issues every read with the query's abort signal and the read deadline (ISS-5110)", async () => {
    vi.useFakeTimers();
    const { dataSource, list } = makeListDataSource();

    renderHook(
      () =>
        useTraceComments({
          target: { type: "session", id: "session-1" },
          onJumpToRow: vi.fn(),
          active: true,
        }),
      { wrapper: createWrapper(dataSource) }
    );

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    const [, , options] = list.mock.calls[0];
    expect(options?.timeoutMs).toBe(TRACE_COMMENTS_READ_TIMEOUT_MS);
    // The signal must be the query's own, not a fresh unwired controller: an
    // aborted read has to be one TanStack actually cancels.
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.signal?.aborted).toBe(false);
  });

  it("does a one-shot discovery read but never starts the 2s poll when inactive (FEA-4233)", async () => {
    vi.useFakeTimers();
    const { dataSource, list } = makeListDataSource();

    renderHook(
      () =>
        useTraceComments({
          target: { type: "session", id: "session-1" },
          onJumpToRow: vi.fn(),
          active: false,
        }),
      { wrapper: createWrapper(dataSource) }
    );

    // FEA-4233: the query is enabled on `target.id` (not `active`), so a
    // collapsed/hidden rail still performs a single discovery read — the
    // session-detail surface needs the comment count to decide whether to default
    // an empty rail collapsed. But the recurring 2s interval stays gated on
    // `active`, so an inactive rail never keeps hammering: exactly one read, and
    // it does not grow across three interval windows.
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS * 3);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("keeps polling on a permanently-hidden desktop renderer that never fires visibilitychange (regression: poll must not stall)", async () => {
    vi.useFakeTimers();
    // Simulate an offscreen/CI Electron renderer: `document.hidden` is
    // permanently true and NO `visibilitychange` event is ever dispatched.
    //
    // ISS-5022 deliberately kept document visibility OUT of the cadence
    // decision, so this behaves exactly as it did before: a hidden renderer
    // polls at the base interval like any other. Backing off on `document.hidden`
    // would silently drop a desktop reader who IS looking at the comments to the
    // ceiling forever, since that signal never recovers on this surface.
    forceDocumentHidden(true);
    const { dataSource, list } = makeListDataSource();

    renderHook(
      () =>
        useTraceComments({
          target: { type: "session", id: "session-1" },
          onJumpToRow: vi.fn(),
          active: true,
        }),
      { wrapper: createWrapper(dataSource) }
    );

    // Initial fetch fires even though the renderer is (and stays) hidden.
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    // And the base interval keeps polling with no `visibilitychange` ever firing.
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(3));
  });

  it("backs off to the ceiling once the thread has been unchanged for the idle threshold", async () => {
    vi.useFakeTimers();
    const { dataSource, list } = makeListDataSource();

    renderHook(
      () =>
        useTraceComments({
          target: { type: "session", id: "session-1" },
          onJumpToRow: vi.fn(),
          active: true,
        }),
      { wrapper: createWrapper(dataSource) }
    );

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    // Pin the crossover EXACTLY rather than advancing with slack, so an
    // off-by-one in the hook's own streak bookkeeping fails here (the pure
    // function's boundary is pinned separately in the cadence test).
    //
    // Tick 1 only establishes the baseline signature (streak 0). Tick k leaves
    // the streak at k-1, so it first reaches the threshold on tick
    // THRESHOLD + 1 — and only that tick's result re-aims to the ceiling.
    const ticksToBackOff = TRACE_COMMENTS_IDLE_POLLS_BEFORE_BACKOFF + 1;

    for (let i = 0; i < ticksToBackOff - 1; i += 1) {
      await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
    }
    // One tick short of the threshold the cadence is still the base interval.
    expect(list).toHaveBeenCalledTimes(ticksToBackOff);
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
    expect(list).toHaveBeenCalledTimes(ticksToBackOff + 1);

    // That last result crossed the threshold, so the base interval must no
    // longer fire — this is the whole point of the issue: a session nobody is
    // reading stops costing a request every 2s.
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
    expect(list).toHaveBeenCalledTimes(ticksToBackOff + 1);

    // ...but the thread stays eventually-consistent at the ceiling.
    await vi.advanceTimersByTimeAsync(
      TRACE_COMMENTS_BACKOFF_REFETCH_INTERVAL_MS
    );
    await vi.waitFor(() =>
      expect(list).toHaveBeenCalledTimes(ticksToBackOff + 2)
    );
  });

  it("re-aims a pending backed-off timer to the base interval after a local delete (regression: the tombstone window must not be missed)", async () => {
    vi.useFakeTimers();
    // The create/delete markers live for 3x the BASE interval. If a mutation only
    // reset an idle counter without moving the already-scheduled timer, the
    // confirming poll would land up to the 30s ceiling away — long after the
    // tombstone expired — and a deleted comment could be resurrected.
    const comment = makeTraceComment("Only comment");
    const list = vi
      .fn<TraceCommentsDataSource["list"]>()
      .mockResolvedValue([comment]);
    const dataSource: TraceCommentsDataSource = {
      scope: "test",
      list,
      create: vi.fn<TraceCommentsDataSource["create"]>(),
      reply: vi.fn<TraceCommentsDataSource["reply"]>(),
      update: vi.fn<TraceCommentsDataSource["update"]>(),
      delete: vi
        .fn<TraceCommentsDataSource["delete"]>()
        .mockResolvedValue({ deleted: true }),
    };

    const { result } = renderHook(
      () =>
        useTraceComments({
          target: { type: "session", id: "session-1" },
          onJumpToRow: vi.fn(),
          active: true,
        }),
      { wrapper: createWrapper(dataSource) }
    );

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    // Drive the cadence into back-off with an unchanging list.
    const callsWhileBackedOff = await advanceIntoIdleBackOff(list);

    // A local delete must re-aim the pending timer, not just clear a counter.
    act(() => {
      result.current.deleteTraceComment(comment.id);
    });
    // Let the delete mutation settle so its onSuccess reset has run.
    await vi.waitFor(() => expect(dataSource.delete).toHaveBeenCalled());

    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
    await vi.waitFor(() =>
      expect(list).toHaveBeenCalledTimes(callsWhileBackedOff + 1)
    );
  });

  it("keeps the timer firing when a fetch never settles (regression: a hung request must not park the loop)", async () => {
    vi.useFakeTimers();
    // The old `setInterval` fired regardless of whether the previous fetch
    // resolved. A naive await-then-reschedule loop would park forever on a hung
    // request. The successor is therefore scheduled BEFORE the fetch is fired.
    //
    // The honest invariant: TanStack dedupes a refetch onto an in-flight query,
    // so `list` is NOT re-invoked while one hangs. What must hold is that the
    // TIMER is still alive — proven by the loop firing on its own schedule the
    // moment the hang clears.
    //
    // The release point is deliberately OFF the interval grid (2.5 intervals).
    // Releasing on a multiple would make this test pass against a naive
    // await-then-reschedule loop too: that loop would reschedule from the
    // resolution instant and land on the very same tick, so the two
    // implementations would be indistinguishable. Off-grid, only the
    // pre-scheduling loop can fire at the next grid tick (t=3 intervals); the
    // naive one would not fire until 2.5 + 1 = 3.5 intervals.
    let releaseHungFetch: ((value: TraceComment[]) => void) | undefined;
    const list = vi
      .fn<TraceCommentsDataSource["list"]>()
      .mockImplementationOnce(
        () =>
          new Promise<TraceComment[]>((resolve) => {
            releaseHungFetch = resolve;
          })
      )
      .mockResolvedValue([]);
    const dataSource: TraceCommentsDataSource = {
      scope: "test",
      list,
      create: vi.fn<TraceCommentsDataSource["create"]>(),
      reply: vi.fn<TraceCommentsDataSource["reply"]>(),
      update: vi.fn<TraceCommentsDataSource["update"]>(),
      delete: vi.fn<TraceCommentsDataSource["delete"]>(),
    };

    renderHook(
      () =>
        useTraceComments({
          target: { type: "session", id: "session-1" },
          onJumpToRow: vi.fn(),
          active: true,
        }),
      { wrapper: createWrapper(dataSource) }
    );

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    // Two ticks pass with the first fetch still outstanding. They fire, but
    // TanStack dedupes them onto the in-flight query, so `list` stays at 1.
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS * 2);
    expect(list).toHaveBeenCalledTimes(1);

    // Release mid-interval, off the grid.
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS / 2);
    releaseHungFetch?.([]);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    // The pre-scheduled tick at t=3 intervals is half an interval away and must
    // fire. A parked loop would still be waiting until t=3.5.
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS / 2);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it("stops polling after unmount and does not reschedule from an in-flight fetch", async () => {
    vi.useFakeTimers();
    const { dataSource, list } = makeListDataSource();

    const { unmount } = renderHook(
      () =>
        useTraceComments({
          target: { type: "session", id: "session-1" },
          onJumpToRow: vi.fn(),
          active: true,
        }),
      { wrapper: createWrapper(dataSource) }
    );

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    unmount();
    const callsAtUnmount = list.mock.calls.length;

    // Well past several intervals: the loop is gone, not merely slowed.
    await vi.advanceTimersByTimeAsync(
      TRACE_COMMENTS_BACKOFF_REFETCH_INTERVAL_MS * 2
    );
    expect(list).toHaveBeenCalledTimes(callsAtUnmount);
  });

  it("schedules exactly one poll per tick across a rerender (regression: no duplicate timers)", async () => {
    vi.useFakeTimers();
    const { dataSource, list } = makeListDataSource();

    const { rerender } = renderHook(
      () =>
        useTraceComments({
          target: { type: "session", id: "session-1" },
          onJumpToRow: vi.fn(),
          active: true,
        }),
      { wrapper: createWrapper(dataSource) }
    );

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    // A rerender must not leave a second timer running alongside the first.
    rerender();
    rerender();

    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(3));
  });

  it("re-aims to the base interval when a REMOTE change is discovered during back-off", async () => {
    vi.useFakeTimers();
    // The eventually-consistent guarantee: a comment written on another surface
    // and picked up by a slow ceiling-cadence poll must speed the cadence back
    // up on the spot, not leave the reader a further full ceiling behind.
    const list = vi.fn<TraceCommentsDataSource["list"]>().mockResolvedValue([]);
    const dataSource: TraceCommentsDataSource = {
      scope: "test",
      list,
      create: vi.fn<TraceCommentsDataSource["create"]>(),
      reply: vi.fn<TraceCommentsDataSource["reply"]>(),
      update: vi.fn<TraceCommentsDataSource["update"]>(),
      delete: vi.fn<TraceCommentsDataSource["delete"]>(),
    };

    renderHook(
      () =>
        useTraceComments({
          target: { type: "session", id: "session-1" },
          onJumpToRow: vi.fn(),
          active: true,
        }),
      { wrapper: createWrapper(dataSource) }
    );

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    const callsWhileBackedOff = await advanceIntoIdleBackOff(list);

    // A comment appears on another surface; the next ceiling poll picks it up.
    list.mockResolvedValue([makeTraceComment("From another surface")]);
    await vi.advanceTimersByTimeAsync(
      TRACE_COMMENTS_BACKOFF_REFETCH_INTERVAL_MS
    );
    const callsAfterCeilingPoll = list.mock.calls.length;
    expect(callsAfterCeilingPoll).toBeGreaterThan(callsWhileBackedOff);

    // That changed result must have re-aimed the cadence back to the base
    // interval, so the very next base tick polls instead of waiting out another
    // full ceiling.
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
    expect(list.mock.calls.length).toBeGreaterThan(callsAfterCeilingPoll);
  });

  it("re-aims to the base interval when the reader refocuses the surface", async () => {
    vi.useFakeTimers();
    const { dataSource, list } = makeListDataSource();

    renderHook(
      () =>
        useTraceComments({
          target: { type: "session", id: "session-1" },
          onJumpToRow: vi.fn(),
          active: true,
        }),
      { wrapper: createWrapper(dataSource) }
    );

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    const callsWhileBackedOff = await advanceIntoIdleBackOff(list);

    // Reader comes back to the tab. A backed-off thread must become live again
    // immediately rather than up to a full ceiling later.
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });

    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
    expect(list.mock.calls.length).toBeGreaterThan(callsWhileBackedOff);
  });

  it("keeps polling and does not treat a failing read as a quiet thread", async () => {
    vi.useFakeTimers();
    // `refetch()` RESOLVES with `isError` on an HTTP failure rather than
    // rejecting, so a run of failures must not look like "nothing changed" and
    // march the cadence to the ceiling while the endpoint is broken.
    const list = vi
      .fn<TraceCommentsDataSource["list"]>()
      .mockRejectedValue(new Error("comments endpoint down"));
    const dataSource: TraceCommentsDataSource = {
      scope: "test",
      list,
      create: vi.fn<TraceCommentsDataSource["create"]>(),
      reply: vi.fn<TraceCommentsDataSource["reply"]>(),
      update: vi.fn<TraceCommentsDataSource["update"]>(),
      delete: vi.fn<TraceCommentsDataSource["delete"]>(),
    };

    renderHook(
      () =>
        useTraceComments({
          target: { type: "session", id: "session-1" },
          onJumpToRow: vi.fn(),
          active: true,
        }),
      { wrapper: createWrapper(dataSource) }
    );

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    // Well past the idle threshold, every read failing.
    for (let i = 0; i < TRACE_COMMENTS_IDLE_POLLS_BEFORE_BACKOFF + 5; i += 1) {
      await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
    }
    const callsAfterFailures = list.mock.calls.length;

    // Still polling at the BASE interval: failures never counted as idleness.
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
    expect(list.mock.calls.length).toBeGreaterThan(callsAfterFailures);
  });

  it("does not let an in-flight fetch from a previous target hijack the new target's poll (regression)", async () => {
    vi.useFakeTimers();
    // The effect RE-RUNS (it does not remount) when the target changes. A
    // disposal flag shared across runs would be flipped back to false by the new
    // run, letting the old target's outstanding fetch resolve, clobber the new
    // target's pending timer, and keep polling the abandoned thread instead.
    let releaseFirstTargetPoll: ((value: TraceComment[]) => void) | undefined;
    const list = vi
      .fn<TraceCommentsDataSource["list"]>()
      .mockResolvedValueOnce([])
      .mockImplementationOnce(
        () =>
          new Promise<TraceComment[]>((resolve) => {
            releaseFirstTargetPoll = resolve;
          })
      )
      .mockResolvedValue([]);
    const dataSource: TraceCommentsDataSource = {
      scope: "test",
      list,
      create: vi.fn<TraceCommentsDataSource["create"]>(),
      reply: vi.fn<TraceCommentsDataSource["reply"]>(),
      update: vi.fn<TraceCommentsDataSource["update"]>(),
      delete: vi.fn<TraceCommentsDataSource["delete"]>(),
    };

    const { rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useTraceComments({
          target: { type: "session", id: sessionId },
          onJumpToRow: vi.fn(),
          active: true,
        }),
      {
        wrapper: createWrapper(dataSource),
        initialProps: { sessionId: "session-1" },
      }
    );

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    // Session 1's poll fires and hangs.
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    // Switch to session 2 while session 1's fetch is still outstanding.
    rerender({ sessionId: "session-2" });
    await vi.waitFor(() =>
      expect(list).toHaveBeenCalledWith(
        { type: "session", id: "session-2" },
        undefined,
        expect.objectContaining({ timeoutMs: TRACE_COMMENTS_READ_TIMEOUT_MS })
      )
    );

    // Session 1's stale fetch now resolves. It must not reschedule anything.
    releaseFirstTargetPoll?.([]);
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);

    // Every subsequent poll must target session 2 — the visible thread.
    const callsAfterSwitch = list.mock.calls.slice(2);
    expect(callsAfterSwitch.length).toBeGreaterThan(0);
    for (const call of callsAfterSwitch) {
      expect(call[0]).toEqual({ type: "session", id: "session-2" });
    }
  });

  it.each([
    {
      name: "create",
      invoke: (api: ReturnType<typeof useTraceComments>) =>
        api.submitTraceComment({
          anchor: makeTraceComment("new").anchor,
          body: "new",
        }),
    },
    {
      name: "reply",
      invoke: (api: ReturnType<typeof useTraceComments>) =>
        api.replyToTraceComment("comment-1", { body: "replied" }),
    },
    {
      name: "update",
      invoke: (api: ReturnType<typeof useTraceComments>) =>
        api.updateTraceComment("comment-1", { body: "edited" }),
    },
  ])("re-aims a pending backed-off timer to the base interval after a local $name", async ({
    invoke,
  }) => {
    vi.useFakeTimers();
    // Every local write means the reader is active again, and creates/replies
    // additionally open a 6s marker window the confirming poll must land
    // inside. The delete path has its own dedicated regression above; this
    // covers the other three, which share the same reset.
    const seeded = makeTraceComment("seed", { id: "comment-1" });
    const list = vi
      .fn<TraceCommentsDataSource["list"]>()
      .mockResolvedValue([seeded]);
    const dataSource: TraceCommentsDataSource = {
      scope: "test",
      list,
      create: vi
        .fn<TraceCommentsDataSource["create"]>()
        .mockResolvedValue(makeTraceComment("new", { id: "comment-new" })),
      reply: vi.fn<TraceCommentsDataSource["reply"]>().mockResolvedValue(
        makeTraceComment("seed", {
          id: "comment-1",
          replies: [makeTraceCommentReply("reply-new", "replied")],
        })
      ),
      update: vi
        .fn<TraceCommentsDataSource["update"]>()
        .mockResolvedValue(makeTraceComment("edited", { id: "comment-1" })),
      delete: vi.fn<TraceCommentsDataSource["delete"]>(),
    };

    const { result } = renderHook(
      () =>
        useTraceComments({
          target: { type: "session", id: "session-1" },
          onJumpToRow: vi.fn(),
          active: true,
        }),
      { wrapper: createWrapper(dataSource) }
    );

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    const callsWhileBackedOff = await advanceIntoIdleBackOff(list);

    act(() => {
      invoke(result.current);
    });

    // The next BASE tick must poll — not a full ceiling later.
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
    expect(list.mock.calls.length).toBeGreaterThan(callsWhileBackedOff);
  });

  it("counts a slow FIRST load once, not once per tick (regression: no fabricated idle streak)", async () => {
    vi.useFakeTimers();
    // `refetch()` on a query that is already fetching returns the SAME in-flight
    // promise. Without a single-flight guard every tick would attach another
    // completion handler to it, so one eventual result would be counted once per
    // tick — the first handler setting the signature and each of the rest seeing
    // it unchanged and incrementing the idle streak. A slow first load would then
    // land already backed off, having observed exactly one read.
    let releaseFirstLoad: ((value: TraceComment[]) => void) | undefined;
    const list = vi
      .fn<TraceCommentsDataSource["list"]>()
      .mockImplementationOnce(
        () =>
          new Promise<TraceComment[]>((resolve) => {
            releaseFirstLoad = resolve;
          })
      )
      .mockResolvedValue([]);
    const dataSource: TraceCommentsDataSource = {
      scope: "test",
      list,
      create: vi.fn<TraceCommentsDataSource["create"]>(),
      reply: vi.fn<TraceCommentsDataSource["reply"]>(),
      update: vi.fn<TraceCommentsDataSource["update"]>(),
      delete: vi.fn<TraceCommentsDataSource["delete"]>(),
    };

    renderHook(
      () =>
        useTraceComments({
          target: { type: "session", id: "session-1" },
          onJumpToRow: vi.fn(),
          active: true,
        }),
      { wrapper: createWrapper(dataSource) }
    );

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    // Hold the first load open across many ticks, then release it.
    await vi.advanceTimersByTimeAsync(
      TRACE_COMMENTS_REFETCH_INTERVAL_MS *
        (TRACE_COMMENTS_IDLE_POLLS_BEFORE_BACKOFF + 5)
    );
    releaseFirstLoad?.([]);
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);

    // The cadence must still be at the base interval: a single result cannot
    // have manufactured an idle streak. If it had, this tick would not poll.
    const callsAfterRelease = list.mock.calls.length;
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
    expect(list.mock.calls.length).toBeGreaterThan(callsAfterRelease);
  });

  it("does not stack reads on a hung refetch after a successful load", async () => {
    vi.useFakeTimers();
    // This query does not consume TanStack's abort signal, so a fresh read
    // joining a hung one every 2s would leave the hung HTTP/IPC operation live
    // and pile replacements on top of it.
    let releaseHungRefetch: ((value: TraceComment[]) => void) | undefined;
    const list = vi
      .fn<TraceCommentsDataSource["list"]>()
      .mockResolvedValueOnce([])
      .mockImplementationOnce(
        () =>
          new Promise<TraceComment[]>((resolve) => {
            releaseHungRefetch = resolve;
          })
      )
      .mockResolvedValue([]);
    const dataSource: TraceCommentsDataSource = {
      scope: "test",
      list,
      create: vi.fn<TraceCommentsDataSource["create"]>(),
      reply: vi.fn<TraceCommentsDataSource["reply"]>(),
      update: vi.fn<TraceCommentsDataSource["update"]>(),
      delete: vi.fn<TraceCommentsDataSource["delete"]>(),
    };

    renderHook(
      () =>
        useTraceComments({
          target: { type: "session", id: "session-1" },
          onJumpToRow: vi.fn(),
          active: true,
        }),
      { wrapper: createWrapper(dataSource) }
    );

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    // The first poll after the successful mount read hangs.
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    // Many ticks pass while it is outstanding. None may start another read.
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS * 5);
    expect(list).toHaveBeenCalledTimes(2);

    // Once it clears, polling resumes — the loop was never parked.
    releaseHungRefetch?.([]);
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_REFETCH_INTERVAL_MS);
    await vi.waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(2));
  });
});
