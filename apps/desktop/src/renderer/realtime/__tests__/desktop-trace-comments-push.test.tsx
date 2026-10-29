import { createTraceCommentsWrapper } from "@repo/app/agents/components/detail/__tests__/trace-comments-test-helpers";
import { TRACE_COMMENTS_FALLBACK_POLL_INTERVAL_MS } from "@repo/app/agents/components/detail/trace-comments-poll-cadence";
import { useTraceComments } from "@repo/app/agents/components/detail/use-trace-comments";
import type { TraceCommentsDataSource } from "@repo/app/agents/data-source/trace-comments-data-source";
import { RealtimeStatus } from "@repo/realtime-client/port";
import {
  ChannelKind,
  formatChannelAddress,
} from "@repo/realtime-contract/channels";
import { CommentSignalType } from "@repo/realtime-contract/signals";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DesktopRealtimeApi,
  DesktopRealtimeEventKind,
} from "../../../shared/desktop-realtime-contract";
import { createIpcRealtimePort } from "../ipc-realtime-port";

/**
 * ISS-12275 on the desktop adapter: the session rail's trace comments arrive
 * through the IPC realtime port (Cloud mode), and an empty session's collapsed
 * rail does not poll while that channel is live.
 */
vi.mock("@closedloop-ai/design-system/components/ui/sonner", () => ({
  toast: { error: vi.fn() },
}));

const ORGANIZATION_ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const SESSION_ID = "0190c6c8-0000-7000-8000-0000000000d1";
const CHANNEL = formatChannelAddress(ChannelKind.Comments, ORGANIZATION_ID, [
  SESSION_ID,
]);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("desktop trace comments push (ISS-12275)", () => {
  it("refetches the rail on a signal from main and does not poll a collapsed empty rail while live", async () => {
    const bridge = createBridge();
    const port = createIpcRealtimePort(bridge.api);
    const list = vi.fn<TraceCommentsDataSource["list"]>().mockResolvedValue([]);
    const dataSource: TraceCommentsDataSource = {
      scope: "test",
      list,
      create: vi.fn<TraceCommentsDataSource["create"]>(),
      reply: vi.fn<TraceCommentsDataSource["reply"]>(),
      update: vi.fn<TraceCommentsDataSource["update"]>(),
      delete: vi.fn<TraceCommentsDataSource["delete"]>(),
    };

    const { result } = renderHook(
      () =>
        useTraceComments({
          target: { type: "session", id: SESSION_ID },
          onJumpToRow: vi.fn(),
          active: true,
          expandedWhenEmpty: false,
        }),
      {
        wrapper: createTraceCommentsWrapper(dataSource, {
          port,
          organizationId: ORGANIZATION_ID,
        }),
      }
    );

    await vi.waitFor(() => expect(result.current.hasLoadedComments).toBe(true));
    expect(bridge.api.join).toHaveBeenCalledWith({ channel: CHANNEL });
    bridge.emit(
      { event: DesktopRealtimeEventKind.Status, status: RealtimeStatus.Open },
      { event: DesktopRealtimeEventKind.Joined, channel: CHANNEL }
    );
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    await vi.advanceTimersByTimeAsync(
      TRACE_COMMENTS_FALLBACK_POLL_INTERVAL_MS * 3
    );
    expect(list).toHaveBeenCalledTimes(2);

    bridge.emit({
      event: DesktopRealtimeEventKind.Signal,
      channel: CHANNEL,
      signal: {
        type: CommentSignalType.ThreadCreated,
        data: {
          threadId: "0190c6c8-0000-7000-8000-0000000000c1",
          threadRevision: 1,
        },
      },
    });
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(3));
  });
});

function createBridge() {
  const callbacks = new Set<(event: unknown) => void>();
  const api = {
    join: vi.fn<DesktopRealtimeApi["join"]>(() =>
      Promise.resolve({ status: RealtimeStatus.Connecting, joined: false })
    ),
    leave: vi.fn<DesktopRealtimeApi["leave"]>(() => Promise.resolve()),
    onEvent: vi.fn<DesktopRealtimeApi["onEvent"]>((callback) => {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    }),
  } satisfies DesktopRealtimeApi;
  return {
    api,
    emit(...events: unknown[]) {
      act(() => {
        for (const event of events) {
          for (const callback of [...callbacks]) {
            callback(event);
          }
        }
      });
    },
  };
}
