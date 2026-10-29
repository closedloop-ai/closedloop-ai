/**
 * ISS-11283 lane B — branch coverage for `src/main/cloud/cloud-socket.ts`.
 *
 * Targets baseline-uncovered arms only: the `if (this.stopped)` guards in the
 * connect/connect_error/disconnect/hello-nack listeners, the connect_error
 * auth-classification branch, the reconnect-race guards in `reconnectSocket`,
 * the hello-ack supervisor's disconnected- and missing-socket arms,
 * `replayEvents`'s skip arm, the `desktop.cancel` reason fallback, and the
 * recovery-timer interval that only ever runs after a real `connect()` — which
 * every other cloud-socket suite avoids by short-circuiting before `io()` is
 * ever called.
 *
 * Every state is reached through the public surface (`start()`, `stop()`, and
 * socket events). A guard that only a private-field write can reach is not
 * covered here: stop() clears the hello-ack and reconnect timers before either
 * can fire, so neither timer callback's stopped arm is reachable, nor is the
 * hello-ack supervisor's restart() arm for a second timeout with no socket.
 */
import { AuthOutcome, AuthReason } from "@closedloop-ai/telemetry-contract/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopAuthFailureEventInput } from "../src/main/cloud/auth-failure-telemetry.js";
import type { CloudSocketStatus } from "../src/main/cloud/cloud-protocol.js";
import { CloudSocketService } from "../src/main/cloud/cloud-socket.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { CloudSocketState } from "../src/shared/cloud-socket-error.js";
import {
  connectPairingSocket,
  createStubOptions,
  FakeSocket,
} from "./helpers/cloud-socket-fixtures.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

const HELLO_ACK_TIMEOUT_MS = 10_000;
const RECONNECT_DELAY_MS = 1000;
const RECOVERY_CHECK_INTERVAL_MS = 30_000;
const FAR_FROM_EPOCH_MS = Date.UTC(2026, 0, 1);

const { mockIo } = vi.hoisted(() => ({ mockIo: vi.fn() }));
vi.mock("socket.io-client", () => ({ io: mockIo }));

afterEach(() => {
  nodeTestTimers.reset();
  gatewayLog.clear();
  mockIo.mockReset();
});

describe("start() surfaces getRelayOrigin failures without touching the socket", () => {
  it("degrades on a non-Error thrown by getRelayOrigin, without a generic message", async () => {
    const statuses: CloudSocketStatus[] = [];
    const service = new CloudSocketService(
      createStubOptions({
        getRelayOrigin: () => {
          // Options are a caller-supplied boundary of the CloudSocketOptions
          // contract; throwing a non-Error here is a legitimate case the
          // start() catch block must classify (its non-Error message fallback).
          // biome-ignore lint/style/useThrowOnlyError: pins the non-Error catch branch
          throw { code: "boom" };
        },
        onStatusChange: (status) => statuses.push(status),
      })
    );

    await service.start();

    expect(statuses).toEqual([
      { state: CloudSocketState.Degraded, error: "invalid relay origin" },
    ]);
    expect(mockIo).not.toHaveBeenCalled();
  });
});

describe("start() abandons a superseded start after the PoP-header await", () => {
  it("never calls connect() once stop() lands while the header build is pending", async () => {
    const statuses: CloudSocketStatus[] = [];
    const service = new CloudSocketService(
      createStubOptions({ onStatusChange: (status) => statuses.push(status) })
    );

    const pending = service.start();
    // start() has run synchronously through `notifyStatus({state:"idle"})` and
    // is now suspended on the `await buildRelayValidationPopHeaders(...)` call;
    // stop() lands in that window, which is exactly the race the post-await
    // stopped check guards.
    service.stop();
    await pending;

    expect(statuses).toEqual([{ state: CloudSocketState.Idle }]);
    expect(mockIo).not.toHaveBeenCalled();
  });
});

describe("start() with a default (non-managed) API-key provenance", () => {
  it("falls back to USER_CREATED and opens the socket without PoP extraHeaders", async () => {
    const fakeSocket = new FakeSocket();
    mockIo.mockReturnValue(fakeSocket);
    nodeTestTimers.enable(["setTimeout", "setInterval"]);
    const statuses: CloudSocketStatus[] = [];
    const service = new CloudSocketService(
      createStubOptions({
        getRelayOrigin: () => "https://relay.example.com",
        onStatusChange: (status) => statuses.push(status),
        // getApiKeyProvenance intentionally omitted: exercises the
        // `?? "USER_CREATED"` provenance fallback in start(), which then makes
        // buildManagedDesktopPopHeaders return undefined (provenance is not
        // DESKTOP_MANAGED).
      })
    );

    await service.start();

    expect(mockIo).toHaveBeenCalledTimes(1);
    const [url, opts] = mockIo.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(url).toBe("https://relay.example.com/desktop-gateway");
    expect(opts).not.toHaveProperty("extraHeaders");
    expect(statuses).toEqual([{ state: CloudSocketState.Idle }]);
    expect(fakeSocket.connectCalls).toBe(1);
  });
});

describe("connect_error classification", () => {
  it("reports an auth-shaped failure as a credential problem on a never-connected socket", () => {
    const reported: DesktopAuthFailureEventInput[] = [];
    const harness = connectPairingSocket((input) => reported.push(input));

    harness.socket.emit("connect_error", new Error("Unauthorized"));

    expect(harness.statuses.at(-1)).toEqual({
      state: CloudSocketState.Degraded,
      error: "Authentication failed -- verify your API key in Settings",
    });
    expect(reported).toEqual([
      {
        outcome: AuthOutcome.PairingRejected,
        reason: AuthReason.RelayRejectedCredential,
      },
    ]);
  });

  it("reports a non-Error connect_error as a generic connection failure, not an auth rejection", () => {
    const reported: DesktopAuthFailureEventInput[] = [];
    const harness = connectPairingSocket((input) => reported.push(input));

    harness.socket.emit("connect_error", "transport closed");

    expect(harness.statuses.at(-1)).toEqual({
      state: CloudSocketState.Degraded,
      error: "Cloud socket connection failed: connection failed",
    });
    expect(reported).toEqual([]);
  });
});

describe("overlapping start calls", () => {
  it("keeps only the latest socket and never leaves an orphan", async () => {
    const { service, sockets } = createService();
    await Promise.all([service.start(), service.start()]);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.listenerCount("connect")).toBeGreaterThan(0);
    service.stop();
  });
});

describe("disconnect handler while running", () => {
  it("reports a degraded status for a disconnect", () => {
    const harness = connectPairingSocket(() => undefined);
    const statusesBeforeDisconnect = [...harness.statuses];

    harness.socket.emit("disconnect", "transport close");

    expect(harness.statuses.length).toBeGreaterThan(
      statusesBeforeDisconnect.length
    );
    expect(harness.statuses.at(-1)).toEqual({
      state: CloudSocketState.Degraded,
      error: "Cloud socket disconnected: transport close",
    });
  });
});

describe("handleHelloNack while running", () => {
  it("reports a degraded status for a hello.nack frame", () => {
    const harness = connectPairingSocket(() => undefined);
    const statusesBeforeNack = [...harness.statuses];

    harness.socket.emit("desktop.hello.nack", { reason: "invalid_signature" });

    expect(harness.statuses.length).toBeGreaterThan(statusesBeforeNack.length);
    expect(harness.statuses.at(-1)?.state).toBe(CloudSocketState.Degraded);
    expect(
      gatewayLog
        .getEntries()
        .some(({ message }) => message.includes("Hello rejected by cloud"))
    ).toBe(true);
  });
});

describe("desktop.cancel without a reason", () => {
  it("reports the cancel with an undefined reason rather than an empty string", () => {
    const cancels: Array<{ commandId: string; reason?: string }> = [];
    const harness = connectPairingSocket(() => undefined, {
      onCancel: (event) => cancels.push(event),
    });

    harness.socket.emit("desktop.cancel", { commandId: "cmd-no-reason" });

    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.commandId).toBe("cmd-no-reason");
    expect(cancels[0]?.reason).toBeUndefined();
    expect(cancels[0] && "reason" in cancels[0]).toBe(true);
  });
});

describe("replayEvents", () => {
  it("skips already-replayed sequence numbers and forwards only newer ones", () => {
    const harness = connectPairingSocket(() => undefined);
    harness.socket.emittedEvents.length = 0;

    harness.service.replayEvents(
      "cmd-1",
      [
        { sequence: 1, eventType: "chunk", data: "first" },
        { sequence: 2, eventType: "chunk", data: "second" },
        { sequence: 3, eventType: "chunk", data: "third" },
      ],
      2
    );

    const commandEvents = harness.socket.emittedEvents.filter(
      (event) => event.name === "desktop.command.event"
    );
    expect(commandEvents).toHaveLength(1);
    expect(commandEvents[0]?.payload).toMatchObject({
      commandId: "cmd-1",
      sequence: 3,
      eventType: "chunk",
      data: "third",
    });
  });
});

describe("reconnectSocket race guards", () => {
  it("abandons the reconnect if stop() lands during the PoP-header await", async () => {
    const { service, sockets } = await startService();
    const socket = sockets[0] as FakeSocket;
    const reconnects = recordAsyncCalls(service, "reconnectSocket");

    socket.emit("disconnect", "transport close");
    // The reconnect timer fires synchronously inside tick(); reconnectSocket
    // passes its entry check and suspends on the header refresh, and stop()
    // lands in that window before any microtask runs.
    nodeTestTimers.tick(RECONNECT_DELAY_MS);
    service.stop();
    expect(reconnects).toHaveLength(1);
    await reconnects[0];

    expect("extraHeaders" in socket.io.opts).toBe(true);
    expect(socket.connectCalls).toBe(1);
  });

  it("abandons the reconnect if a new start() replaces the socket during the PoP-header await", async () => {
    const { service, sockets } = await startService();
    const socket = sockets[0] as FakeSocket;
    const reconnects = recordAsyncCalls(service, "reconnectSocket");

    socket.emit("disconnect", "transport close");
    nodeTestTimers.tick(RECONNECT_DELAY_MS);
    // start() leaves the service running but disconnects and drops the old
    // socket, so only the post-await check's `this.socket !== socket` arm can
    // refuse the reconnect.
    const restarting = service.start();
    expect(reconnects).toHaveLength(1);
    await reconnects[0];
    await restarting;

    expect("extraHeaders" in socket.io.opts).toBe(true);
    expect(socket.connectCalls).toBe(1);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]?.connectCalls).toBe(1);
  });

  it("reconnects the same socket when nothing supersedes it", async () => {
    const { service, sockets } = await startService();
    const socket = sockets[0] as FakeSocket;
    const reconnects = recordAsyncCalls(service, "reconnectSocket");

    socket.emit("disconnect", "transport close");
    nodeTestTimers.tick(RECONNECT_DELAY_MS);
    expect(reconnects).toHaveLength(1);
    await reconnects[0];

    expect(socket.connectCalls).toBe(2);
  });
});

describe("hello-ack timeout supervisor", () => {
  it("does not re-arm the timer once the socket has already disconnected", () => {
    const harness = connectPairingSocket(() => undefined);
    harness.socket.connected = false;

    nodeTestTimers.tick(HELLO_ACK_TIMEOUT_MS);

    expect(countHelloAckTimeoutLogs("(1/2)")).toBe(1);
    expect(harness.statuses.at(-1)).toEqual({
      state: CloudSocketState.Degraded,
      error: "Relay did not respond to handshake — retrying",
    });
    const helloEmitsAfterTimeout = harness.socket.emittedEvents.filter(
      (event) => event.name === "desktop.hello"
    );
    // The initial `connect` handshake emits one hello; the disconnected-socket
    // check before re-emitting must not have sent a second.
    expect(helloEmitsAfterTimeout).toHaveLength(1);

    // No second timer was armed either — ticking again produces no further
    // warning, proving the supervisor did not reschedule itself.
    const entriesBefore = gatewayLog.getEntries().length;
    nodeTestTimers.tick(HELLO_ACK_TIMEOUT_MS);
    expect(gatewayLog.getEntries().length).toBe(entriesBefore);
  });
});

describe("recovery timer", () => {
  it("skips the elapsed check until degraded, then forces a restart once the timeout is crossed", async () => {
    const sockets: FakeSocket[] = [];
    mockIo.mockImplementation(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    // Start the fake clock far from epoch 0: with `degradedSince` still null,
    // `Date.now() - null` is just `Date.now()`, so only a large clock proves the
    // first check returned at the `!this.degradedSince` guard rather than merely
    // measuring a sub-threshold elapsed time.
    nodeTestTimers.enable(["setTimeout", "setInterval", "Date"], {
      now: FAR_FROM_EPOCH_MS,
    });
    const statuses: CloudSocketStatus[] = [];
    const service = new CloudSocketService(
      createStubOptions({
        getRelayOrigin: () => "https://relay.example.com",
        onStatusChange: (status) => statuses.push(status),
      })
    );
    const starts = recordAsyncCalls(service, "start");

    await service.start();
    expect(mockIo).toHaveBeenCalledTimes(1);

    // First interval check: not yet degraded (degradedSince is still null), so
    // the interval's not-degraded guard returns before ever reading Date.now()
    // — no restart, no warning, and specifically no "Degraded for" log (proves
    // the elapsed-time branch below it was never reached on this check).
    nodeTestTimers.tick(RECOVERY_CHECK_INTERVAL_MS);
    expect(starts).toHaveLength(1);
    expect(mockIo).toHaveBeenCalledTimes(1);
    expect(
      gatewayLog
        .getEntries()
        .some(({ message }) => message.includes("Degraded for"))
    ).toBe(false);

    sockets[0]?.emit("connect_error", new Error("relay unreachable"));
    expect(statuses.at(-1)?.state).toBe(CloudSocketState.Degraded);

    // Three sub-threshold checks (elapsed 30s/60s/90s against the 120s bound):
    // each must leave mockIo uncalled again and log nothing "Degraded for".
    for (let i = 0; i < 3; i++) {
      nodeTestTimers.tick(RECOVERY_CHECK_INTERVAL_MS);
      expect(starts).toHaveLength(1);
      expect(mockIo).toHaveBeenCalledTimes(1);
      expect(
        gatewayLog
          .getEntries()
          .some(({ message }) => message.includes("Degraded for"))
      ).toBe(false);
    }

    // The fourth check crosses the 120s bound exactly and forces a restart — a
    // fresh start() that reaches connect() a second time.
    nodeTestTimers.tick(RECOVERY_CHECK_INTERVAL_MS);
    expect(starts).toHaveLength(2);
    await starts[1];

    expect(
      gatewayLog
        .getEntries()
        .some(
          (entry) =>
            entry.tag === "cloud-socket" &&
            entry.message === "Degraded for 120s, forcing reconnect"
        )
    ).toBe(true);
    expect(mockIo).toHaveBeenCalledTimes(2);
  });
});

type StartedService = {
  service: CloudSocketService;
  sockets: FakeSocket[];
  statuses: CloudSocketStatus[];
};

/**
 * A real service started through `start()`, with every `io()` call answered by
 * a fresh FakeSocket recorded in `sockets`.
 */
async function startService(): Promise<StartedService> {
  const started = createService();
  await started.service.start();
  return started;
}

function createService(): StartedService {
  const sockets: FakeSocket[] = [];
  mockIo.mockImplementation(() => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });
  nodeTestTimers.enable(["setTimeout", "setInterval"]);
  const statuses: CloudSocketStatus[] = [];
  const service = new CloudSocketService(
    createStubOptions({
      onStatusChange: (status) => statuses.push(status),
    })
  );
  return { service, sockets, statuses };
}

function countHelloAckTimeoutLogs(fragment: string): number {
  return gatewayLog
    .getEntries()
    .filter(
      ({ message }) =>
        message.startsWith("Hello ack timeout") && message.includes(fragment)
    ).length;
}

/**
 * Wraps `method` on this instance and records the promise of each call, so a
 * case can await the call's own completion instead of flushing microtasks.
 */
function recordAsyncCalls(target: object, method: string): Promise<void>[] {
  const calls: Promise<void>[] = [];
  const original: (...args: unknown[]) => Promise<void> = Reflect.get(
    target,
    method
  );
  Reflect.set(target, method, (...args: unknown[]) => {
    const call = original.apply(target, args);
    calls.push(call);
    return call;
  });
  return calls;
}
