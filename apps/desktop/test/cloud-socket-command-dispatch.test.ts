/**
 * @file cloud-socket-command-dispatch.test.ts
 * @description ISS-8142 item 10 — the desktop side of the command, cancel and
 * event-ack listeners.
 *
 * Each of these three listeners validates its payload and returns early when the
 * payload does not narrow. The CLOUD half of the same contract is pinned
 * (`validators.test.ts` for the retired `/api/engineer/` namespace,
 * `tier2-event-streaming.test.ts` for the stream ack), but the DESKTOP consumer
 * was not: before this suite, `onCommandEventAck` had zero occurrences in any
 * test in the repo, so flipping any of these guards to accept left everything
 * green.
 *
 * The event-ack guard is the one with teeth. `replayEvents` resumes a reconnect
 * from `fromSequence`, so a fabricated or fractional sequence does not merely
 * log wrong — it silently SKIPS events on the next reconnect.
 *
 * Every negative here is paired with a positive control in the same test, so a
 * harness that could never dispatch at all cannot pass by doing nothing.
 */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import type {
  DesktopCancelEvent,
  DesktopCommandEvent,
  DesktopCommandStreamAckEvent,
} from "../src/main/cloud/cloud-protocol.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import {
  connectPairingSocket,
  type FakeSocket,
} from "./helpers/cloud-socket-fixtures.js";

afterEach(() => {
  gatewayLog.clear();
});

describe("ISS-8142: desktop.command rejects what does not narrow", () => {
  test("a legacy /api/engineer/ command is ignored, a /api/gateway/ one is not", () => {
    // The `/api/engineer/` namespace was deliberately retired. The cloud is
    // pinned against re-emitting it; this is the desktop refusing to honour one
    // if it ever arrives from an older or misconfigured peer.
    const { socket, commands } = bindDispatchHarness();

    socket.emit("desktop.command", {
      path: "/api/engineer/health-check",
      method: "GET",
      commandId: "c1",
    });
    assert.equal(commands.length, 0, "the retired namespace must not dispatch");

    socket.emit("desktop.command", VALID_COMMAND);
    assert.equal(
      commands.length,
      1,
      "positive control: a well-formed command on the live namespace DOES dispatch"
    );
    assert.equal(commands[0]?.path, VALID_COMMAND.path);
  });

  test("a payload with none of the required fields is ignored", () => {
    const { socket, commands } = bindDispatchHarness();

    socket.emit("desktop.command", { nonsense: true });
    assert.equal(commands.length, 0);

    socket.emit("desktop.command", VALID_COMMAND);
    assert.equal(commands.length, 1, "positive control");
  });

  test("a command missing only operationId is ignored", () => {
    // Each required field is load-bearing on its own: a command that reached
    // the executor without an operationId would dispatch an unnamed operation.
    const { socket, commands } = bindDispatchHarness();

    socket.emit("desktop.command", {
      commandId: "c1",
      method: "GET",
      path: "/api/gateway/repos",
    });
    assert.equal(commands.length, 0);

    socket.emit("desktop.command", VALID_COMMAND);
    assert.equal(commands.length, 1, "positive control");
  });
});

describe("ISS-8142: desktop.cancel requires a commandId", () => {
  test("a cancel with no commandId, or an empty one, is ignored", () => {
    // A cancel that lost its target is not a cancel-everything.
    const { socket, cancels } = bindDispatchHarness();

    socket.emit("desktop.cancel", { reason: "user aborted" });
    socket.emit("desktop.cancel", { commandId: "", reason: "user aborted" });
    assert.equal(cancels.length, 0);

    socket.emit("desktop.cancel", { commandId: "c1", reason: "user aborted" });
    assert.equal(cancels.length, 1, "positive control");
    assert.equal(cancels[0]?.commandId, "c1");
    assert.equal(cancels[0]?.reason, "user aborted");
  });
});

describe("ISS-8142: desktop.command.event.ack requires an integer sequence", () => {
  test("a missing or non-finite sequence is ignored", () => {
    // `replayEvents` resumes from `fromSequence`, so a sequence that does not
    // narrow must not reach the consumer at all.
    const { socket, eventAcks } = bindDispatchHarness();

    socket.emit("desktop.command.event.ack", { commandId: "c1" });
    socket.emit("desktop.command.event.ack", {
      commandId: "c1",
      sequence: Number.NaN,
    });
    socket.emit("desktop.command.event.ack", {
      commandId: "c1",
      sequence: Number.POSITIVE_INFINITY,
    });
    socket.emit("desktop.command.event.ack", {
      commandId: "c1",
      sequence: -1,
    });
    assert.equal(eventAcks.length, 0);

    socket.emit("desktop.command.event.ack", { commandId: "c1", sequence: 3 });
    assert.equal(eventAcks.length, 1, "positive control");
    assert.equal(eventAcks[0]?.sequence, 3);
  });

  test("today a FRACTIONAL sequence is truncated and accepted, not refused", () => {
    // Pinning current behaviour, not blessing it. `asFiniteInteger` answers
    // `Math.trunc(value)`, so `1.5` narrows to `1` and dispatches. ISS-8142
    // filed this expecting a refusal; the guard admits it instead.
    //
    // Truncation rounds DOWN, so the practical effect on `replayEvents` is
    // re-sending events already delivered rather than skipping undelivered ones
    // — the safe direction, which is why this is pinned rather than treated as
    // the reported defect. What it does mean is that a malformed ack from a
    // newer or buggy cloud is silently normalised instead of being rejected at
    // the boundary, so nothing upstream ever learns it sent nonsense.
    const { socket, eventAcks } = bindDispatchHarness();

    socket.emit("desktop.command.event.ack", {
      commandId: "c1",
      sequence: 1.5,
    });

    assert.equal(eventAcks.length, 1);
    assert.equal(
      eventAcks[0]?.sequence,
      1,
      "1.5 is truncated to 1 and dispatched"
    );
  });

  test("a sequence with no commandId is ignored", () => {
    // The sequence is meaningless without the stream it belongs to.
    const { socket, eventAcks } = bindDispatchHarness();

    socket.emit("desktop.command.event.ack", { sequence: 3 });
    assert.equal(eventAcks.length, 0);

    socket.emit("desktop.command.event.ack", { commandId: "c1", sequence: 3 });
    assert.equal(eventAcks.length, 1, "positive control");
  });
});

const VALID_COMMAND = {
  commandId: "c-valid",
  operationId: "repos_config",
  method: "GET",
  path: "/api/gateway/repos",
};

type DispatchHarness = {
  socket: FakeSocket;
  commands: DesktopCommandEvent[];
  cancels: DesktopCancelEvent[];
  eventAcks: DesktopCommandStreamAckEvent[];
};

/**
 * The shared pairing harness with the three dispatch callbacks captured.
 *
 * `emitConnect: false` because none of these listeners depends on a completed
 * handshake, and arming the hello-ack supervisor would leave a timer to clean up
 * for no assertion's benefit.
 */
function bindDispatchHarness(): DispatchHarness {
  const commands: DesktopCommandEvent[] = [];
  const cancels: DesktopCancelEvent[] = [];
  const eventAcks: DesktopCommandStreamAckEvent[] = [];
  const { socket } = connectPairingSocket(
    () => undefined,
    {
      onCommand: (event) => commands.push(event),
      onCancel: (event) => cancels.push(event),
      onCommandEventAck: (event) => eventAcks.push(event),
    },
    { emitConnect: false }
  );
  return { socket, commands, cancels, eventAcks };
}
