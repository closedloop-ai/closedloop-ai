import {
  createSocketIoRealtimeClient,
  type RealtimeClient,
} from "@repo/realtime-client/connection";
import { RealtimeStatus } from "@repo/realtime-client/port";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLazyRealtimePort } from "../lazy-realtime-port";
import { createFakeRealtimePort } from "./fake-realtime-port";

const CHANNEL = "comments:org-1:artifact-1";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createLazyRealtimePort (PLN-2162 decision 9)", () => {
  it("reports the client's status changes once the first join built it", () => {
    const fake = createFakeRealtimePort();
    const client: RealtimeClient = { ...fake.port, close: vi.fn() };
    const port = createLazyRealtimePort(() => client);
    const statuses: RealtimeStatus[] = [];
    port.onStatus((status) => statuses.push(status));

    port.join(CHANNEL, { onSignal: vi.fn(), onResync: vi.fn() });
    fake.setStatus(RealtimeStatus.Open);

    expect(statuses).toEqual([RealtimeStatus.Open]);
    expect(port.status()).toBe(RealtimeStatus.Open);
  });

  it("closed before any join, builds nothing and leaves a late join polling", async () => {
    const createClient = vi.fn();
    const port = createLazyRealtimePort(createClient);
    const statuses: RealtimeStatus[] = [];
    port.onStatus((status) => statuses.push(status));
    const poll = vi.fn(() => Promise.resolve());
    const onError = vi.fn();

    port.close();
    port.join(CHANNEL, { onSignal: vi.fn(), onResync: vi.fn(), poll, onError });
    await vi.advanceTimersByTimeAsync(2000);

    expect(createClient).not.toHaveBeenCalled();
    expect(statuses).toEqual([RealtimeStatus.Closed]);
    expect(onError).toHaveBeenCalledWith(RealtimeErrorCode.Internal);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("closes the client when the last join leaves, and a later join builds another", async () => {
    // A refused token fetch with no fallback URL: the client retries it on a
    // backoff for as long as it is open, which is what an idle tab must not do.
    const getToken = vi.fn(() => Promise.reject(new Error("503")));
    const createClient = vi.fn(() =>
      createSocketIoRealtimeClient({ getToken, clientVersion: "test" })
    );
    const port = createLazyRealtimePort(createClient);
    const listener = { onSignal: vi.fn(), onResync: vi.fn() };

    const leaveFirst = port.join(CHANNEL, listener);
    const leaveSecond = port.join(CHANNEL, listener);
    await vi.advanceTimersByTimeAsync(0);
    leaveFirst();
    leaveFirst();
    await vi.advanceTimersByTimeAsync(60_000);
    const fetchesWhileHeld = getToken.mock.calls.length;
    expect(fetchesWhileHeld).toBeGreaterThan(1);

    leaveSecond();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(getToken).toHaveBeenCalledTimes(fetchesWhileHeld);
    expect(port.status()).toBe(RealtimeStatus.Connecting);

    port.join(CHANNEL, listener);
    await vi.advanceTimersByTimeAsync(0);

    expect(createClient).toHaveBeenCalledTimes(2);
    expect(getToken).toHaveBeenCalledTimes(fetchesWhileHeld + 1);
  });

  it("replaces a client that closed itself on the next join", () => {
    const first = createFakeRealtimePort();
    const second = createFakeRealtimePort();
    const clients = [first, second].map(
      (fake): RealtimeClient => ({ ...fake.port, close: vi.fn() })
    );
    const createClient = vi.fn(() => {
      const next = clients.shift();
      if (next === undefined) {
        throw new Error("no client left");
      }
      return next;
    });
    const port = createLazyRealtimePort(createClient);
    const statuses: RealtimeStatus[] = [];
    port.onStatus((status) => statuses.push(status));

    port.join(CHANNEL, { onSignal: vi.fn(), onResync: vi.fn() });
    first.setStatus(RealtimeStatus.Closed);
    port.join(CHANNEL, { onSignal: vi.fn(), onResync: vi.fn() });

    expect(createClient).toHaveBeenCalledTimes(2);
    expect(first.joins).toHaveLength(1);
    expect(second.joins).toHaveLength(1);
    expect(statuses).toEqual([
      RealtimeStatus.Closed,
      RealtimeStatus.Connecting,
    ]);
    expect(port.status()).toBe(RealtimeStatus.Connecting);
  });
});
