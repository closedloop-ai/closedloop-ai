import { RealtimeStatus } from "@repo/realtime-client/port";
import { focusManager } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeRealtimePort } from "../../../../shared/realtime/__tests__/fake-realtime-port";
import type { TraceCommentsDataSource } from "../../../data-source/trace-comments-data-source";
import { TRACE_COMMENTS_FALLBACK_POLL_INTERVAL_MS } from "../trace-comments-poll-cadence";
import { useCommentsRailState } from "../use-comments-rail-state";
import { createTraceCommentsWrapper } from "./trace-comments-test-helpers";

/**
 * ISS-12275: the session rail's production wiring into the live updates. An
 * empty session's rail sits on its collapsed handle (FEA-4233), so with push
 * live it reads once and then waits for signals; revealing it starts the 30s
 * fallback poll (Marisol Ashgrove ruling, PRD-792 open question 1).
 */
vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: vi.fn() },
}));

const ORGANIZATION_ID = "0190c6c8-0000-7000-8000-0000000000a1";
const FIVE_MINUTES_MS = 5 * 60 * 1000;

beforeEach(() => {
  focusManager.setFocused(true);
});

afterEach(() => {
  vi.useRealTimers();
  focusManager.setFocused(undefined);
});

describe("useCommentsRailState live updates (ISS-12275)", () => {
  it("does not poll an empty session's collapsed rail while push is live, and polls once the reader expands it", async () => {
    vi.useFakeTimers();
    const list = vi.fn<TraceCommentsDataSource["list"]>().mockResolvedValue([]);
    const dataSource: TraceCommentsDataSource = {
      scope: "test",
      list,
      create: vi.fn<TraceCommentsDataSource["create"]>(),
      reply: vi.fn<TraceCommentsDataSource["reply"]>(),
      update: vi.fn<TraceCommentsDataSource["update"]>(),
      delete: vi.fn<TraceCommentsDataSource["delete"]>(),
    };
    const realtime = createFakeRealtimePort();
    realtime.setStatus(RealtimeStatus.Open);

    const { result } = renderHook(
      () =>
        useCommentsRailState({
          sessionId: "session-1",
          jumpToRow: vi.fn(),
          commentsRailOpen: true,
          commentsCollapsed: false,
          onCommentsCollapsedChange: vi.fn(),
        }),
      {
        wrapper: createTraceCommentsWrapper(dataSource, {
          port: realtime.port,
          organizationId: ORGANIZATION_ID,
        }),
      }
    );

    await vi.waitFor(() => expect(result.current.hasLoadedComments).toBe(true));
    expect(result.current.commentsRailCollapsed).toBe(true);
    expect(realtime.joins).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS);
    expect(list).toHaveBeenCalledTimes(1);

    act(() => result.current.expandCommentsRail());
    expect(result.current.commentsRailCollapsed).toBe(false);
    await vi.advanceTimersByTimeAsync(TRACE_COMMENTS_FALLBACK_POLL_INTERVAL_MS);
    expect(list).toHaveBeenCalledTimes(2);
  });
});
