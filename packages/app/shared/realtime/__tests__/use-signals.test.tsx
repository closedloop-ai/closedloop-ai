import type { RealtimeSignal } from "@repo/realtime-client/port";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RealtimeProvider } from "../realtime-provider";
import { type UntypedSignalsOptions, useSignals } from "../use-signals";
import { createFakeRealtimePort } from "./fake-realtime-port";

const CHANNEL = "comments:org-1:artifact-1";

/** Two types, so a skip is shown to be per type. */
const TYPES = {
  "thread.created": z.object({ threadId: z.string() }),
  "thread.updated": z.object({ threadRevision: z.number() }),
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useSignals", () => {
  it("joins on mount and leaves on unmount", () => {
    const fake = createFakeRealtimePort();
    const { unmount } = renderHook(() => useSignals(CHANNEL, callbacks()), {
      wrapper: providerFor(fake.port),
    });
    const [joined] = fake.joins;
    expect(joined?.channel).toBe(CHANNEL);
    expect(joined?.leave).not.toHaveBeenCalled();

    unmount();

    expect(joined?.leave).toHaveBeenCalledTimes(1);
  });

  it("calls the latest callbacks without rejoining when their identity changes", () => {
    const fake = createFakeRealtimePort();
    const first = callbacks();
    const { rerender } = renderHook(
      (options: UntypedSignalsOptions) => useSignals(CHANNEL, options),
      { wrapper: providerFor(fake.port), initialProps: first }
    );
    const second = callbacks({ dataLoadedAt: () => 42 });

    rerender(second);
    const listener = fake.onlyListener();
    listener.onSignal({ type: "thread.created", data: { threadId: "t1" } });
    listener.onResync();

    expect(fake.joins[0]?.leave).not.toHaveBeenCalled();
    expect(first.onSignal).not.toHaveBeenCalled();
    expect(second.onSignal).toHaveBeenCalledWith({
      type: "thread.created",
      data: { threadId: "t1" },
    });
    expect(second.onResync).toHaveBeenCalledTimes(1);
    expect(listener.dataLoadedAt?.()).toBe(42);
  });

  it("hands the port a poll that runs the latest poll", async () => {
    const fake = createFakeRealtimePort();
    const first = vi.fn(() => Promise.resolve());
    const second = vi.fn(() => Promise.resolve());
    const { rerender } = renderHook(
      (options: UntypedSignalsOptions) => useSignals(CHANNEL, options),
      {
        wrapper: providerFor(fake.port),
        initialProps: callbacks({ poll: first }),
      }
    );

    rerender(callbacks({ poll: second }));
    await fake.onlyListener().poll?.();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("keeps the join when poll comes and goes, and polls whichever is current", async () => {
    const fake = createFakeRealtimePort();
    const poll = vi.fn(() => Promise.resolve());
    const { rerender } = renderHook(
      (options: UntypedSignalsOptions) => useSignals(CHANNEL, options),
      { wrapper: providerFor(fake.port), initialProps: callbacks() }
    );

    rerender(callbacks({ poll }));
    await fake.onlyListener().poll?.();
    rerender(callbacks());
    await fake.onlyListener().poll?.();

    expect(fake.joins[0]?.leave).not.toHaveBeenCalled();
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("with no provider, polls a poll supplied after mount", async () => {
    const poll = vi.fn(() => Promise.resolve());
    const { rerender } = renderHook(
      (options: UntypedSignalsOptions) => useSignals(CHANNEL, options),
      { initialProps: callbacks() }
    );

    rerender(callbacks({ poll }));
    await vi.advanceTimersByTimeAsync(2000);

    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("forwards a channel refusal to the latest onError and a rejected poll to the latest onPollError, without rejoining", () => {
    const fake = createFakeRealtimePort();
    const first = callbacks({
      onError: vi.fn(),
      onPollError: vi.fn(),
      poll: () => Promise.resolve(),
    });
    const { rerender } = renderHook(
      (options: UntypedSignalsOptions) => useSignals(CHANNEL, options),
      { wrapper: providerFor(fake.port), initialProps: first }
    );
    const second = callbacks({
      onError: vi.fn(),
      onPollError: vi.fn(),
      poll: () => Promise.resolve(),
    });
    const pollError = new Error("poll failed");

    rerender(second);
    const listener = fake.onlyListener();
    listener.onError?.(RealtimeErrorCode.Forbidden);
    listener.onPollError?.(pollError);

    expect(fake.joins[0]?.leave).not.toHaveBeenCalled();
    expect(first.onError).not.toHaveBeenCalled();
    expect(first.onPollError).not.toHaveBeenCalled();
    expect(second.onError).toHaveBeenCalledWith(RealtimeErrorCode.Forbidden);
    expect(second.onPollError).toHaveBeenCalledWith(pollError);
  });

  it("with no provider, hands a rejected poll to onPollError and keeps polling", async () => {
    const pollError = new Error("poll failed");
    const poll = vi.fn(() => Promise.reject(pollError));
    const onPollError = vi.fn();
    renderHook(() => useSignals(CHANNEL, callbacks({ poll, onPollError })));

    await vi.advanceTimersByTimeAsync(2000);
    expect(onPollError).toHaveBeenCalledWith(pollError);

    await vi.advanceTimersByTimeAsync(4000);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(onPollError).toHaveBeenCalledTimes(2);
  });

  it("with no provider, joins nothing and only polls, until unmount", async () => {
    const poll = vi.fn(() => Promise.resolve());
    const { unmount } = renderHook(() =>
      useSignals(CHANNEL, callbacks({ poll }))
    );

    await vi.advanceTimersByTimeAsync(2000);
    expect(poll).toHaveBeenCalledTimes(1);

    unmount();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("with no channel yet, joins nothing and only polls, then joins once the channel is known", async () => {
    const fake = createFakeRealtimePort();
    const poll = vi.fn(() => Promise.resolve());
    const { rerender } = renderHook(
      (channel: string | null) => useSignals(channel, callbacks({ poll })),
      { wrapper: providerFor(fake.port), initialProps: null as string | null }
    );

    await vi.advanceTimersByTimeAsync(2000);
    expect(fake.joins).toHaveLength(0);
    expect(poll).toHaveBeenCalledTimes(1);

    rerender(CHANNEL);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(fake.joins.map(({ channel }) => channel)).toEqual([CHANNEL]);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("with types, delivers a known type parsed, skips an unknown type silently and reports failing data, per type", () => {
    const fake = createFakeRealtimePort();
    const onSignal = vi.fn();
    const onInvalidSignal = vi.fn();
    renderHook(
      () =>
        useSignals(CHANNEL, {
          onSignal,
          onResync: vi.fn(),
          types: TYPES,
          onInvalidSignal,
        }),
      { wrapper: providerFor(fake.port) }
    );
    const listener = fake.onlyListener();

    listener.onSignal({
      type: "thread.created",
      data: { threadId: "t1", extra: true },
    });
    listener.onSignal({
      type: "thread.updated",
      data: { threadRevision: "not-a-number" },
    });
    listener.onSignal({ type: "thread.updated", data: { threadRevision: 3 } });
    listener.onSignal({ type: "thread.deleted", data: { threadId: "t1" } });
    listener.onSignal({ type: "constructor", data: {} });

    expect(onSignal.mock.calls).toEqual([
      [{ type: "thread.created", data: { threadId: "t1" } }],
      [{ type: "thread.updated", data: { threadRevision: 3 } }],
    ]);
    expect(onInvalidSignal).toHaveBeenCalledTimes(1);
    expect(onInvalidSignal).toHaveBeenCalledWith(
      { type: "thread.updated", data: { threadRevision: "not-a-number" } },
      expect.any(z.ZodError)
    );
  });

  it("without types, delivers a signal of any type unchanged", () => {
    const fake = createFakeRealtimePort();
    const options = callbacks();
    renderHook(() => useSignals(CHANNEL, options), {
      wrapper: providerFor(fake.port),
    });
    const signal = { type: "never.seen", data: { anything: [1, 2] } };

    fake.onlyListener().onSignal(signal);

    expect(options.onSignal).toHaveBeenCalledWith(signal);
  });
});

function callbacks(overrides: Partial<UntypedSignalsOptions> = {}) {
  return {
    onSignal: vi.fn<(signal: RealtimeSignal) => void>(),
    onResync: vi.fn<() => void>(),
    ...overrides,
  };
}

function providerFor(port: Parameters<typeof RealtimeProvider>[0]["client"]) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <RealtimeProvider client={port}>{children}</RealtimeProvider>;
  };
}
