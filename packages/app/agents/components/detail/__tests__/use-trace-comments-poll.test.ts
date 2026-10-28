import type { TraceComment } from "@repo/api/src/types/comment";
import { RealtimeStatus } from "@repo/realtime-client/port";
import {
  ChannelKind,
  formatChannelAddress,
} from "@repo/realtime-contract/channels";
import { CommentSignalType } from "@repo/realtime-contract/signals";
import { focusManager } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeRealtimePort } from "../../../../shared/realtime/__tests__/fake-realtime-port";
import type { TraceCommentsDataSource } from "../../../data-source/trace-comments-data-source";
import {
  TRACE_COMMENTS_FALLBACK_POLL_INTERVAL_MS,
  TRACE_COMMENTS_READ_TIMEOUT_MS,
} from "../trace-comments-poll-cadence";
import { useTraceComments } from "../use-trace-comments";
import {
  createTraceCommentsWrapper,
  forceDocumentHidden,
  makeTraceComment,
  restoreDocumentVisibility,
} from "./trace-comments-test-helpers";

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

const ORGANIZATION_ID = "0190c6c8-0000-7000-8000-0000000000a1";
const SESSION_TARGET = { type: "session", id: "session-1" } as const;
const THREAD_CREATED_SIGNAL = {
  type: CommentSignalType.ThreadCreated,
  data: { threadId: "0190c6c8-0000-7000-8000-0000000000c1", threadRevision: 1 },
};
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const FALLBACK_POLLS_IN_FIVE_MINUTES =
  FIVE_MINUTES_MS / TRACE_COMMENTS_FALLBACK_POLL_INTERVAL_MS;

function makeListDataSource(
  list = vi.fn<TraceCommentsDataSource["list"]>().mockResolvedValue([])
) {
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

function openRealtime() {
  const realtime = createFakeRealtimePort();
  realtime.setStatus(RealtimeStatus.Open);
  return realtime;
}

describe("trace comments live updates (ISS-12275)", () => {
  const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
  const originalVisibilityState = Object.getOwnPropertyDescriptor(
    document,
    "visibilityState"
  );

  beforeEach(() => {
    // `focusManager` is a module-level singleton with a DOM-backed default
    // subscriber; pin it so an incidental jsdom event cannot refetch mid-test.
    focusManager.setFocused(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    restoreDocumentVisibility(originalHidden, originalVisibilityState);
    focusManager.setFocused(undefined);
  });

  it("makes at most the fallback-poll count of reads in a 5-minute idle view with the rail expanded", async () => {
    vi.useFakeTimers();
    const { dataSource, list } = makeListDataSource();

    renderHook(
      () =>
        useTraceComments({
          target: SESSION_TARGET,
          onJumpToRow: vi.fn(),
          active: true,
        }),
      { wrapper: createTraceCommentsWrapper(dataSource, openRealtimeArgs()) }
    );

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS);

    expect(list.mock.calls.length - 1).toBeLessThanOrEqual(
      FALLBACK_POLLS_IN_FIVE_MINUTES
    );
    // The fallback is still a live poll, not just an absence of reads.
    expect(list.mock.calls.length - 1).toBe(FALLBACK_POLLS_IN_FIVE_MINUTES);
  });

  it("issues every read with the query's abort signal and the read deadline (ISS-5110)", async () => {
    vi.useFakeTimers();
    const { dataSource, list } = makeListDataSource();

    renderHook(
      () =>
        useTraceComments({
          target: SESSION_TARGET,
          onJumpToRow: vi.fn(),
          active: true,
        }),
      { wrapper: createTraceCommentsWrapper(dataSource) }
    );

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    const [, , options] = list.mock.calls[0];
    expect(options?.timeoutMs).toBe(TRACE_COMMENTS_READ_TIMEOUT_MS);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.signal?.aborted).toBe(false);
  });

  it("does a one-shot discovery read but never polls when the reader collapsed the rail (FEA-4233)", async () => {
    vi.useFakeTimers();
    const { dataSource, list } = makeListDataSource();

    renderHook(
      () =>
        useTraceComments({
          target: SESSION_TARGET,
          onJumpToRow: vi.fn(),
          active: false,
        }),
      { wrapper: createTraceCommentsWrapper(dataSource) }
    );

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("shows a comment another user posted when its signal arrives, with no poll on a collapsed empty rail", async () => {
    vi.useFakeTimers();
    const fromAnotherUser = makeTraceComment("From another user");
    const { dataSource, list } = makeListDataSource(
      vi
        .fn<TraceCommentsDataSource["list"]>()
        .mockResolvedValueOnce([])
        .mockResolvedValue([fromAnotherUser])
    );
    const realtime = openRealtime();

    const { result } = renderHook(
      () =>
        useTraceComments({
          target: SESSION_TARGET,
          onJumpToRow: vi.fn(),
          active: true,
          expandedWhenEmpty: false,
        }),
      {
        wrapper: createTraceCommentsWrapper(dataSource, {
          port: realtime.port,
          organizationId: ORGANIZATION_ID,
        }),
      }
    );

    await vi.waitFor(() => expect(result.current.hasLoadedComments).toBe(true));
    expect(realtime.joins.map(({ channel }) => channel)).toEqual([
      formatChannelAddress(ChannelKind.Comments, ORGANIZATION_ID, [
        SESSION_TARGET.id,
      ]),
    ]);
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS);
    expect(list).toHaveBeenCalledTimes(1);

    act(() => realtime.onlyListener().onSignal(THREAD_CREATED_SIGNAL));

    await vi.waitFor(() =>
      expect(result.current.comments[0]?.body).toBe(fromAnotherUser.body)
    );
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("retries a failed signal reload on a collapsed empty rail while the channel stays live", async () => {
    vi.useFakeTimers();
    const fromAnotherUser = makeTraceComment("From another user");
    const { dataSource, list } = makeListDataSource(
      vi
        .fn<TraceCommentsDataSource["list"]>()
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error("read deadline exceeded"))
        .mockResolvedValue([fromAnotherUser])
    );
    const realtime = openRealtime();

    const { result } = renderHook(
      () =>
        useTraceComments({
          target: SESSION_TARGET,
          onJumpToRow: vi.fn(),
          active: true,
          expandedWhenEmpty: false,
        }),
      {
        wrapper: createTraceCommentsWrapper(dataSource, {
          port: realtime.port,
          organizationId: ORGANIZATION_ID,
        }),
      }
    );

    await vi.waitFor(() => expect(result.current.hasLoadedComments).toBe(true));
    act(() => realtime.onlyListener().onSignal(THREAD_CREATED_SIGNAL));
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(result.current.comments).toEqual([]);
    expect(realtime.port.status()).toBe(RealtimeStatus.Open);

    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_FALLBACK_POLL_INTERVAL_MS);
    expect(list).toHaveBeenCalledTimes(3);
    await vi.waitFor(() =>
      expect(result.current.comments[0]?.body).toBe(fromAnotherUser.body)
    );
  });

  it("retries a failed signal reload on a collapsed empty rail only until a read succeeds", async () => {
    vi.useFakeTimers();
    const { dataSource, list } = makeListDataSource(
      vi
        .fn<TraceCommentsDataSource["list"]>()
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error("read deadline exceeded"))
        .mockResolvedValue([])
    );
    const realtime = openRealtime();

    const { result } = renderHook(
      () =>
        useTraceComments({
          target: SESSION_TARGET,
          onJumpToRow: vi.fn(),
          active: true,
          expandedWhenEmpty: false,
        }),
      {
        wrapper: createTraceCommentsWrapper(dataSource, {
          port: realtime.port,
          organizationId: ORGANIZATION_ID,
        }),
      }
    );

    await vi.waitFor(() => expect(result.current.hasLoadedComments).toBe(true));
    act(() => realtime.onlyListener().onSignal(THREAD_CREATED_SIGNAL));
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_FALLBACK_POLL_INTERVAL_MS);
    expect(list).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("joins no comments channel and makes no read when the collection is disabled (PLN-2162 M6)", async () => {
    vi.useFakeTimers();
    const { dataSource, list } = makeListDataSource();
    const realtime = openRealtime();

    renderHook(
      () =>
        useTraceComments({
          target: SESSION_TARGET,
          onJumpToRow: vi.fn(),
          active: true,
          enabled: false,
        }),
      {
        wrapper: createTraceCommentsWrapper(dataSource, {
          port: realtime.port,
          organizationId: ORGANIZATION_ID,
        }),
      }
    );

    await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS);
    expect(realtime.joins).toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });

  it("reloads a collapsed empty rail through the event stream's not-live poll when no realtime client is mounted (PRD-536 E5)", async () => {
    vi.useFakeTimers();
    const { dataSource, list } = makeListDataSource();

    renderHook(
      () =>
        useTraceComments({
          target: SESSION_TARGET,
          onJumpToRow: vi.fn(),
          active: true,
          expandedWhenEmpty: false,
        }),
      { wrapper: createTraceCommentsWrapper(dataSource) }
    );

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_FALLBACK_POLL_INTERVAL_MS);
    expect(list.mock.calls.length).toBeGreaterThan(1);
  });

  it("reloads a collapsed empty rail when the port polls a channel that is not live, and leaves an expanded rail to its 30s interval", async () => {
    vi.useFakeTimers();
    const collapsed = makeListDataSource();
    const expanded = makeListDataSource();
    const collapsedRealtime = createFakeRealtimePort();
    const expandedRealtime = createFakeRealtimePort();

    for (const [source, realtime, expandedWhenEmpty] of [
      [collapsed, collapsedRealtime, false],
      [expanded, expandedRealtime, true],
    ] as const) {
      const view = renderHook(
        () =>
          useTraceComments({
            target: SESSION_TARGET,
            onJumpToRow: vi.fn(),
            active: true,
            expandedWhenEmpty,
          }),
        {
          wrapper: createTraceCommentsWrapper(source.dataSource, {
            port: realtime.port,
            organizationId: ORGANIZATION_ID,
          }),
        }
      );
      await vi.waitFor(() =>
        expect(view.result.current.hasLoadedComments).toBe(true)
      );
    }

    await act(async () => {
      await collapsedRealtime.onlyListener().poll?.();
      await expandedRealtime.onlyListener().poll?.();
    });

    expect(collapsed.list).toHaveBeenCalledTimes(2);
    expect(expanded.list).toHaveBeenCalledTimes(1);
  });

  it("does not reload a rail the reader collapsed when the port polls", async () => {
    vi.useFakeTimers();
    const { dataSource, list } = makeListDataSource();
    const realtime = createFakeRealtimePort();

    const { result } = renderHook(
      () =>
        useTraceComments({
          target: SESSION_TARGET,
          onJumpToRow: vi.fn(),
          active: false,
        }),
      {
        wrapper: createTraceCommentsWrapper(dataSource, {
          port: realtime.port,
          organizationId: ORGANIZATION_ID,
        }),
      }
    );

    await vi.waitFor(() => expect(result.current.hasLoadedComments).toBe(true));
    await act(async () => {
      await realtime.onlyListener().poll?.();
    });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("polls a rail that defaults collapsed once comments make it expand", async () => {
    vi.useFakeTimers();
    const { dataSource, list } = makeListDataSource(
      vi
        .fn<TraceCommentsDataSource["list"]>()
        .mockResolvedValue([makeTraceComment("Existing")])
    );
    const realtime = openRealtime();

    renderHook(
      () =>
        useTraceComments({
          target: SESSION_TARGET,
          onJumpToRow: vi.fn(),
          active: true,
          expandedWhenEmpty: false,
        }),
      {
        wrapper: createTraceCommentsWrapper(dataSource, {
          port: realtime.port,
          organizationId: ORGANIZATION_ID,
        }),
      }
    );

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_FALLBACK_POLL_INTERVAL_MS);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("refetches once on focus without resetting the fallback cadence", async () => {
    vi.useFakeTimers();
    const { dataSource, list } = makeListDataSource();

    renderHook(
      () =>
        useTraceComments({
          target: SESSION_TARGET,
          onJumpToRow: vi.fn(),
          active: true,
        }),
      { wrapper: createTraceCommentsWrapper(dataSource) }
    );
    // The fallback interval starts in the mount commit.
    const firstTickAt = Date.now() + TRACE_COMMENTS_FALLBACK_POLL_INTERVAL_MS;

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(
      TRACE_COMMENTS_FALLBACK_POLL_INTERVAL_MS / 3
    );

    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    // No faster cadence after focus: nothing until the original 30s tick.
    await vi.advanceTimersByTimeAsync(firstTickAt - Date.now() - 1);
    expect(list).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("keeps polling on a permanently-hidden desktop renderer that never fires visibilitychange", async () => {
    vi.useFakeTimers();
    forceDocumentHidden(true);
    const { dataSource, list } = makeListDataSource();

    renderHook(
      () =>
        useTraceComments({
          target: SESSION_TARGET,
          onJumpToRow: vi.fn(),
          active: true,
        }),
      { wrapper: createTraceCommentsWrapper(dataSource) }
    );

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_FALLBACK_POLL_INTERVAL_MS);
    expect(list).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_FALLBACK_POLL_INTERVAL_MS);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("stops polling after unmount", async () => {
    vi.useFakeTimers();
    const { dataSource, list } = makeListDataSource();

    const { unmount } = renderHook(
      () =>
        useTraceComments({
          target: SESSION_TARGET,
          onJumpToRow: vi.fn(),
          active: true,
        }),
      { wrapper: createTraceCommentsWrapper(dataSource) }
    );

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    unmount();
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("does not stack reads on a hung poll, and resumes once it settles", async () => {
    vi.useFakeTimers();
    let releaseHungRefetch: ((value: TraceComment[]) => void) | undefined;
    const { dataSource, list } = makeListDataSource(
      vi
        .fn<TraceCommentsDataSource["list"]>()
        .mockResolvedValueOnce([])
        .mockImplementationOnce(
          () =>
            new Promise<TraceComment[]>((resolve) => {
              releaseHungRefetch = resolve;
            })
        )
        .mockResolvedValue([])
    );

    renderHook(
      () =>
        useTraceComments({
          target: SESSION_TARGET,
          onJumpToRow: vi.fn(),
          active: true,
        }),
      { wrapper: createTraceCommentsWrapper(dataSource) }
    );

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_FALLBACK_POLL_INTERVAL_MS);
    expect(list).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(
      TRACE_COMMENTS_FALLBACK_POLL_INTERVAL_MS * 3
    );
    expect(list).toHaveBeenCalledTimes(2);

    releaseHungRefetch?.([]);
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_FALLBACK_POLL_INTERVAL_MS);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("polls only the current target after the target changes", async () => {
    vi.useFakeTimers();
    const { dataSource, list } = makeListDataSource();

    const { rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useTraceComments({
          target: { type: "session", id: sessionId },
          onJumpToRow: vi.fn(),
          active: true,
        }),
      {
        wrapper: createTraceCommentsWrapper(dataSource),
        initialProps: { sessionId: "session-1" },
      }
    );

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    rerender({ sessionId: "session-2" });
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_FALLBACK_POLL_INTERVAL_MS);
    const afterSwitch = list.mock.calls.slice(1);
    expect(afterSwitch.length).toBe(2);
    for (const call of afterSwitch) {
      expect(call[0]).toEqual({ type: "session", id: "session-2" });
    }
  });
});

function openRealtimeArgs() {
  return { port: openRealtime().port, organizationId: ORGANIZATION_ID };
}
