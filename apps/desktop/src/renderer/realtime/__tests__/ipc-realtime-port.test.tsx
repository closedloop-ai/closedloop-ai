import { useRealtimeClient } from "@repo/app/shared/realtime/realtime-provider";
import {
  type RealtimeChannelListener,
  RealtimeStatus,
} from "@repo/realtime-client/port";
import {
  ChannelKind,
  formatChannelAddress,
} from "@repo/realtime-contract/channels";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import { CommentSignalType } from "@repo/realtime-contract/signals";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DesktopRealtimeApi,
  DesktopRealtimeEventKind,
} from "../../../shared/desktop-realtime-contract";
import { DesktopRealtimeProvider } from "../desktop-realtime-provider";
import { createIpcRealtimePort } from "../ipc-realtime-port";

const CHANNEL = formatChannelAddress(
  ChannelKind.Comments,
  "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
  ["artifact-1"]
);
const FIRST_POLL_MS = 2000;
/** The poll backoff doubles after the first poll. */
const SECOND_POLL_MS = 4000;

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("createIpcRealtimePort (PLN-2162 M4)", () => {
  it("polls until main reports the join acknowledged on an open socket, and again once it degrades", async () => {
    const bridge = createBridge();
    const port = createIpcRealtimePort(bridge.api);
    const listener = createListener();
    port.join(CHANNEL, listener);
    await settle();

    await vi.advanceTimersByTimeAsync(FIRST_POLL_MS);
    expect(listener.poll).toHaveBeenCalledTimes(1);

    // Acknowledged before the socket was welcomed: not live yet.
    bridge.emit({ event: DesktopRealtimeEventKind.Joined, channel: CHANNEL });
    expect(listener.onResync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SECOND_POLL_MS);
    expect(listener.poll).toHaveBeenCalledTimes(2);

    bridge.emit({
      event: DesktopRealtimeEventKind.Status,
      status: RealtimeStatus.Open,
    });
    expect(port.status()).toBe(RealtimeStatus.Open);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listener.poll).toHaveBeenCalledTimes(2);

    bridge.emit({
      event: DesktopRealtimeEventKind.Status,
      status: RealtimeStatus.Degraded,
    });
    await vi.advanceTimersByTimeAsync(FIRST_POLL_MS);
    expect(listener.poll).toHaveBeenCalledTimes(3);
  });

  it("joins a channel in main once for two consumers, and leaves it after the last", async () => {
    const bridge = createBridge();
    const port = createIpcRealtimePort(bridge.api);

    const leaveFirst = port.join(CHANNEL, createListener());
    const leaveSecond = port.join(CHANNEL, createListener());
    leaveFirst();
    await settle();
    expect(bridge.api.join).toHaveBeenCalledTimes(1);
    expect(bridge.api.leave).not.toHaveBeenCalled();

    leaveSecond();
    expect(bridge.api.leave).toHaveBeenCalledWith({ channel: CHANNEL });
  });

  it("routes signals to the channel's listeners and reports a refusal", async () => {
    const bridge = createBridge();
    const port = createIpcRealtimePort(bridge.api);
    const listener = createListener();
    port.join(CHANNEL, listener);
    await settle();

    bridge.emit(
      {
        event: DesktopRealtimeEventKind.Signal,
        channel: CHANNEL,
        signal: {
          type: CommentSignalType.ThreadCreated,
          data: { threadId: "t" },
        },
      },
      {
        event: DesktopRealtimeEventKind.Error,
        channel: CHANNEL,
        code: RealtimeErrorCode.Forbidden,
      }
    );

    expect(listener.onSignal).toHaveBeenCalledWith({
      type: CommentSignalType.ThreadCreated,
      data: { threadId: "t" },
    });
    expect(listener.onError).toHaveBeenCalledWith(RealtimeErrorCode.Forbidden);
  });

  it("drops an event that fails its schema", async () => {
    const bridge = createBridge();
    const port = createIpcRealtimePort(bridge.api);
    const listener = createListener();
    port.join(CHANNEL, listener);
    await settle();

    bridge.emit(
      { event: DesktopRealtimeEventKind.Signal, channel: CHANNEL },
      { event: "unknown", channel: CHANNEL },
      { event: DesktopRealtimeEventKind.Status, status: "sideways" }
    );

    expect(listener.onSignal).not.toHaveBeenCalled();
    expect(port.status()).toBe(RealtimeStatus.Connecting);
  });

  it("keeps polling, without throwing, when main has no realtime handler", async () => {
    const bridge = createBridge({
      join: vi.fn(() =>
        Promise.reject(
          new Error("No handler registered for 'desktop:realtime:join'")
        )
      ),
    });
    const port = createIpcRealtimePort(bridge.api);
    const listener = createListener();

    port.join(CHANNEL, listener);
    await vi.advanceTimersByTimeAsync(FIRST_POLL_MS);

    expect(listener.poll).toHaveBeenCalledTimes(1);
  });
});

describe("DesktopRealtimeProvider (PLN-2162 M4)", () => {
  it("provides nothing outside Cloud mode, or under a preload with no realtime bridge", async () => {
    const bridge = createBridge();
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { realtime: bridge.api },
    });
    const local = renderHook(() => useRealtimeClient(), {
      wrapper: providerWrapper(false),
    });
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {},
    });
    const olderPreload = renderHook(() => useRealtimeClient(), {
      wrapper: providerWrapper(true),
    });
    await settle();

    expect(local.result.current).toBeNull();
    expect(olderPreload.result.current).toBeNull();
    expect(bridge.api.onEvent).not.toHaveBeenCalled();
  });
});

function providerWrapper(enabled: boolean) {
  return ({ children }: { children: ReactNode }) => (
    <DesktopRealtimeProvider enabled={enabled}>
      {children}
    </DesktopRealtimeProvider>
  );
}

function createBridge(overrides: Partial<DesktopRealtimeApi> = {}) {
  const callbacks = new Set<(event: unknown) => void>();
  const api = {
    join: vi.fn(() =>
      Promise.resolve({ status: RealtimeStatus.Connecting, joined: false })
    ),
    leave: vi.fn(() => Promise.resolve()),
    onEvent: vi.fn((callback: (event: unknown) => void) => {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    }),
    ...overrides,
  };
  return {
    api,
    /** Delivers each event, in order, as main's pushes. */
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

function createListener() {
  return {
    onSignal: vi.fn(),
    onResync: vi.fn(),
    onError: vi.fn(),
    poll: vi.fn(() => Promise.resolve()),
  } satisfies RealtimeChannelListener;
}

/** Lets a join's answer from main land. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}
