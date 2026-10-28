/**
 * @file cloud-socket-hello-ack-classification.test.ts
 * @description ISS-8142 items 10 and 11 — what the hello-ack LISTENER does with
 * an ack it cannot parse, and how a handshake still in flight colours the
 * disconnect that follows.
 *
 * Split out of `cloud-socket-presence.test.ts` rather than added to it: that
 * file sits seven logical lines under the 1,000-line ceiling, and both cases
 * here need the same live-handshake harness, which nothing there had. The pure
 * parser (`parseDesktopHelloAck`) and the FEA-1404 timeout supervisor stay
 * where they are; this file owns only the classification the listener performs
 * on top of them.
 */
import assert from "node:assert/strict";
import { AuthOutcome, AuthReason } from "@closedloop-ai/telemetry-contract/app";
import { afterEach, describe, test } from "vitest";
import type { DesktopAuthFailureEventInput } from "../src/main/cloud/auth-failure-telemetry.js";
import {
  HELLO_REJECTED_WITHOUT_REASON_MESSAGE,
  SERVER_INITIATED_DISCONNECT_REASON,
} from "../src/main/cloud/cloud-hello-nack.js";
import type {
  CloudSocketStatus,
  DesktopHelloAckEvent,
} from "../src/main/cloud/cloud-protocol.js";
import type {
  CloudSocketOptions,
  CloudSocketService,
} from "../src/main/cloud/cloud-socket.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import {
  CloudSocketDegradedReason,
  CloudSocketError,
  CloudSocketState,
} from "../src/shared/cloud-socket-error.js";
import {
  connectPairingSocket,
  type FakeSocket,
  rearmHandshake,
} from "./helpers/cloud-socket-fixtures.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

afterEach(() => {
  nodeTestTimers.reset();
  gatewayLog.clear();
});

// ISS-8142: the desktop.hello.ack LISTENER's `if (!ackEvent)` ignore arm.
// `parseDesktopHelloAck` is pinned as a pure function in
// `cloud-socket-presence.test.ts`; nothing drove the LISTENER that calls it, so
// flipping that guard to accept a malformed ack left every existing test green.
describe("ISS-8142: a hello-ack the listener cannot parse is ignored, not accepted", () => {
  test("desktop.hello.ack with no computeTargetId never fires onHelloAck or reaches online", () => {
    const { service, socket, statuses, helloAcks } = connectHandshakeSocket();

    socket.emit("desktop.hello.ack", {
      sessionId: "s1",
      serverTime: "2026-05-11T00:00:00.000Z",
    });

    assert.deepEqual(helloAcks, []);
    assert.ok(
      !statuses.some((status) => status.state === "online"),
      "a malformed ack must not be accepted as a successful handshake"
    );
    assert.equal(
      (service as unknown as { hadSuccessfulConnection: boolean })
        .hadSuccessfulConnection,
      false
    );
    assert.equal(
      (service as unknown as { awaitingHelloAck: boolean }).awaitingHelloAck,
      true,
      "the ignored ack must leave the hello-ack supervisor armed, or a real ack could time out silently"
    );

    service.stop();
  });

  test("POSITIVE CONTROL: a well-formed ack with computeTargetId does fire onHelloAck and reach online", () => {
    const { service, socket, statuses, helloAcks } = connectHandshakeSocket();

    socket.emit("desktop.hello.ack", { computeTargetId: "ct_1" });

    assert.equal(helloAcks.length, 1);
    assert.equal(helloAcks[0].computeTargetId, "ct_1");
    assert.equal(statuses.at(-1)?.state, "online");
    assert.equal(
      (service as unknown as { hadSuccessfulConnection: boolean })
        .hadSuccessfulConnection,
      true
    );
    assert.equal(
      (service as unknown as { awaitingHelloAck: boolean }).awaitingHelloAck,
      false
    );

    service.stop();
  });
});

describe("ISS-8142: a handshake still in flight colours the disconnect that follows", () => {
  test(
    "ISS-8142 PINS CURRENT BEHAVIOR (not endorsed): two timeouts on a transport " +
      "that already went half-open still get classified as a pairing rejection " +
      "once the disconnect finally arrives",
    () => {
      // The MAX-timeout recovery comment above names this case directly: a
      // transport that silently died leaves `socket.connected` false, so its
      // own `socket.disconnect()` call is a no-op that raises no event, and
      // nothing resets `awaitingHelloAck`. When a disconnect notification
      // eventually does arrive, `describeDisconnect` has no way to tell that
      // apart from the cloud genuinely rejecting the handshake, and reports a
      // pairing rejection for what was really a transport timeout. This test
      // PINS that classification as it exists today; changing it is a
      // behavior change to make deliberately, not a test to "fix".
      const reported: DesktopAuthFailureEventInput[] = [];
      const { service, socket, statuses } = connectHandshakeSocket({
        reportAuthFailure: (input) => reported.push(input),
      });

      // First timeout: the transport still looks connected, so the supervisor
      // re-arms itself exactly as the test above pins.
      nodeTestTimers.tick(10_000);
      assert.equal(
        (service as unknown as { helloAckTimeoutCount: number })
          .helloAckTimeoutCount,
        1
      );

      // The transport goes half-open between the two timeouts: no
      // 'disconnect' event ever fires for it, only this flag changes.
      socket.connected = false;

      // Second (MAX) timeout: recovery calls socket.disconnect(), which on an
      // already-disconnected FakeSocket raises no event.
      nodeTestTimers.tick(10_000);
      assert.equal(
        (service as unknown as { helloAckTimeoutCount: number })
          .helloAckTimeoutCount,
        2
      );
      assert.equal(
        (service as unknown as { awaitingHelloAck: boolean }).awaitingHelloAck,
        true,
        "nothing has reset awaitingHelloAck yet -- the disconnect() call above raised no event"
      );

      // The disconnect notification finally arrives.
      socket.emit("disconnect", SERVER_INITIATED_DISCONNECT_REASON);

      assert.deepEqual(reported, [
        {
          outcome: AuthOutcome.PairingRejected,
          reason: AuthReason.NoRejectionReason,
        },
      ]);
      const surfaced = statuses.at(-1);
      assert.equal(surfaced?.state, "degraded");
      assert.equal(
        surfaced?.state === "degraded" ? surfaced.error : undefined,
        HELLO_REJECTED_WITHOUT_REASON_MESSAGE,
        "a transport timeout surfaces the same message as a genuine cloud rejection"
      );

      service.stop();
    }
  );
});

/**
 * The shared pairing harness plus the hello-ack capture these two cases need.
 * Wraps {@link connectPairingSocket} rather than re-declaring the private-access
 * binding dance, so every cloud-socket suite keeps one notion of a connected
 * socket.
 */
function connectHandshakeSocket(
  overrides?: Partial<CloudSocketOptions>
): HandshakeHarness {
  const helloAcks: DesktopHelloAckEvent[] = [];
  const { service, socket, statuses } = connectPairingSocket(() => undefined, {
    onHelloAck: (event) => helloAcks.push(event),
    ...overrides,
  });
  return { service, socket, statuses, helloAcks };
}

type HandshakeHarness = {
  service: CloudSocketService;
  socket: FakeSocket;
  statuses: CloudSocketStatus[];
  helloAcks: DesktopHelloAckEvent[];
};

// ISS-11843: a cloud that accepts the connection and then drops `desktop.hello`
// without a nack was retried forever (4,914 reconnects in two hours on the
// reported install). Operator ruling (Marisol Ashgrove, 2026-10-05): the refusal is
// a terminal state, surfaced as "unable to connect to server".
describe("ISS-11843: a hello the cloud keeps closing without a nack is terminal", () => {
  test("two mute closes retry promptly; the third stops reconnecting for good", async () => {
    const { service, socket, statuses } = connectHandshakeSocket();

    socket.emit("disconnect", SERVER_INITIATED_DISCONNECT_REASON);
    nodeTestTimers.tick(1000);
    await flushMicrotasks();
    assert.equal(socket.connectCalls, 1, "first retry uses the 1s cadence");
    assert.equal(
      surfacedError(statuses),
      HELLO_REJECTED_WITHOUT_REASON_MESSAGE,
      "a close that still retries keeps the reconnecting message"
    );

    rearmHandshake(service);
    socket.emit("disconnect", SERVER_INITIATED_DISCONNECT_REASON);
    nodeTestTimers.tick(1000);
    await flushMicrotasks();
    assert.equal(socket.connectCalls, 2, "second retry uses the 1s cadence");

    rearmHandshake(service);
    socket.emit("disconnect", SERVER_INITIATED_DISCONNECT_REASON);
    nodeTestTimers.tick(60 * 60_000);
    await flushMicrotasks();
    assert.equal(
      socket.connectCalls,
      2,
      "a refused handshake is never redialled on a timer"
    );
    assert.deepEqual(statuses.at(-1), {
      state: CloudSocketState.Degraded,
      error: CloudSocketError.HandshakeRefused,
      reason: CloudSocketDegradedReason.HandshakeRefused,
    });
    assert.equal(
      (service as unknown as { stopped: boolean }).stopped,
      true,
      "only a fresh start() may dial again"
    );
  });

  test("a proven handshake clears the streak, so a later mute close is prompt again", async () => {
    const { service, socket, statuses } = connectHandshakeSocket();

    for (let i = 0; i < 2; i += 1) {
      rearmHandshake(service);
      socket.emit("disconnect", SERVER_INITIATED_DISCONNECT_REASON);
      nodeTestTimers.tick(1000);
      await flushMicrotasks();
    }
    socket.emit("desktop.hello.ack", {
      computeTargetId: "ct-1",
      sessionId: "s1",
      serverTime: "2026-10-01T00:00:00.000Z",
    });

    rearmHandshake(service);
    socket.emit("disconnect", SERVER_INITIATED_DISCONNECT_REASON);
    nodeTestTimers.tick(1000);
    await flushMicrotasks();
    assert.equal(
      socket.connectCalls,
      3,
      "the run was broken, so the third close is a flap and retries promptly"
    );
    assert.equal(
      surfacedError(statuses),
      HELLO_REJECTED_WITHOUT_REASON_MESSAGE
    );

    service.stop();
  });
});

/** What the status bar would be showing right now. */
function surfacedError(statuses: CloudSocketStatus[]): string | undefined {
  const last = statuses.at(-1);
  return last?.state === "degraded" ? last.error : undefined;
}

/**
 * Let the async reconnect path settle. Local, like every sibling suite's copy —
 * promoting it is a sweep across nine files and not this change's business.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}
