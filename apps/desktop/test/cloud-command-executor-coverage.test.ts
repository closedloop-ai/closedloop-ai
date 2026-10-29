/**
 * @file cloud-command-executor-coverage.test.ts
 * @description ISS-10514 — `CloudCommandExecutor` admission, cancel, ack,
 * replay, retention and dispose paths that need no gateway response. A command
 * parked in `prepareCommandForExecution` holds its in-flight slot without a
 * fetch, so slot, timer and buffer state are observable synchronously.
 *
 * Gateway-response paths (stream parsing, body/query serialization, error
 * statuses) live in `cloud-command-executor-coverage-2.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudCommandExecutor } from "../src/main/cloud/cloud-command-executor.js";
import {
  type DesktopCancelEvent,
  type DesktopCommandAckEvent,
  type DesktopCommandEvent,
  type DesktopCommandStreamAckEvent,
  PROTOCOL_VERSION,
} from "../src/main/cloud/cloud-protocol.js";
import { Observability } from "../src/main/telemetry/observability.js";
import { COMMAND_ACK_REJECTION_REASONS } from "../src/shared/ack-reasons.js";
import {
  buildCancel,
  buildCommand,
  createExecutor,
  type StreamEvent,
  waitFor,
} from "./cloud-command-executor-harness.js";

type Ack = Omit<
  DesktopCommandAckEvent,
  "protocolVersion" | "messageId" | "timestamp"
>;

// Mirrors COMMAND_RETENTION_MS / MAX_RETAINED_TERMINAL_COMMANDS in the
// executor; neither is exported.
const COMMAND_RETENTION_MS = 10 * 60_000;
const MAX_RETAINED_TERMINAL_COMMANDS = 200;

Observability.initNoOp();

let executor: CloudCommandExecutor | null = null;

afterEach(() => {
  executor?.dispose();
  executor = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  Observability.reset();
  Observability.initNoOp();
});

function recorder(): {
  acks: Ack[];
  events: StreamEvent[];
  onAck: (ack: Ack) => void;
  onEvent: (event: StreamEvent) => void;
} {
  const acks: Ack[] = [];
  const events: StreamEvent[] = [];
  return {
    acks,
    events,
    onAck: (ack) => acks.push(ack),
    onEvent: (event) => events.push(event),
  };
}

/** A prepare step that never settles, so the command holds its slot. */
function parkForever(): Promise<DesktopCommandEvent> {
  return new Promise<DesktopCommandEvent>(() => undefined);
}

function bareCancel(commandId: string): DesktopCancelEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: `${commandId}-cancel`,
    timestamp: "2026-09-17T00:00:00.000Z",
    commandId,
  };
}

function streamAck(
  commandId: string,
  sequence: number
): DesktopCommandStreamAckEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: `${commandId}-ack`,
    timestamp: "2026-09-17T00:00:00.000Z",
    commandId,
    sequence,
  };
}

function parseWireCommand(json: string): DesktopCommandEvent {
  return JSON.parse(json);
}

function wireCommand(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    messageId: "wire-message",
    timestamp: "2026-09-17T00:00:00.000Z",
    commandId: "wire-1",
    operationId: "git_action",
    method: "POST",
    path: "/api/gateway/git",
    body: {},
    ...overrides,
  });
}

describe("enqueue: duplicate command ids", () => {
  it("does not replay the buffer of a duplicate whose original is still running", () => {
    const rec = recorder();
    executor = createExecutor({
      maxInFlightCommands: 1,
      onAck: rec.onAck,
      onEvent: rec.onEvent,
      prepareCommandForExecution: parkForever,
    });
    executor.setConnected(true);
    executor.enqueue(buildCommand("dup-3", {}));
    expect(rec.events.map((event) => event.eventType)).toEqual(["status"]);

    executor.enqueue(buildCommand("dup-3", {}));

    expect(rec.events.map((event) => event.eventType)).toEqual(["status"]);
    expect(rec.acks).toEqual([
      { commandId: "dup-3", accepted: true, state: "accepted" },
      { commandId: "dup-3", accepted: true, state: "accepted" },
    ]);
    expect(executor.getStats()).toEqual({ activeCommands: 1, queueDepth: 0 });
  });

  it("replays the buffered events of a duplicate whose original is terminal", () => {
    const rec = recorder();
    executor = createExecutor({
      maxInFlightCommands: 1,
      onAck: rec.onAck,
      onEvent: rec.onEvent,
    });
    executor.enqueue(buildCommand("dup-2", {}));
    executor.cancel(buildCancel("dup-2", "stop"));
    const terminalDone: StreamEvent = {
      commandId: "dup-2",
      sequence: 1,
      eventType: "done",
      data: { type: "done", cancelled: true, reason: "stop" },
    };
    expect(rec.events).toEqual([terminalDone]);

    executor.enqueue(buildCommand("dup-2", {}));

    expect(rec.events).toEqual([terminalDone, terminalDone]);
    expect(rec.acks.at(-1)).toEqual({
      commandId: "dup-2",
      accepted: true,
      state: "accepted",
    });
    expect(executor.getStats()).toEqual({ activeCommands: 0, queueDepth: 0 });
  });
});

describe("enqueue: validation", () => {
  it.each([
    {
      label: "a blank commandId",
      overrides: { commandId: "   " },
      reason: COMMAND_ACK_REJECTION_REASONS.missingCommandId,
    },
    {
      label: "an unsupported method",
      overrides: { method: "TRACE" },
      reason: COMMAND_ACK_REJECTION_REASONS.unsupportedMethod,
    },
    {
      label: "a path outside the gateway",
      overrides: { path: "/api/private/git" },
      reason: COMMAND_ACK_REJECTION_REASONS.pathOutsideGateway,
    },
  ])(
    "rejects a wire command with $label and queues nothing",
    ({ overrides, reason }) => {
      const rec = recorder();
      executor = createExecutor({
        maxInFlightCommands: 1,
        onAck: rec.onAck,
        onEvent: rec.onEvent,
      });
      const command = parseWireCommand(wireCommand(overrides));
      executor.setConnected(true);

      executor.enqueue(command);

      expect(rec.acks).toEqual([
        {
          commandId: command.commandId,
          accepted: false,
          state: "failed",
          reason,
        },
      ]);
      expect(rec.events).toEqual([]);
      expect(executor.getStats()).toEqual({ activeCommands: 0, queueDepth: 0 });
    }
  );

  it("accepts a lowercase wire method", () => {
    const rec = recorder();
    executor = createExecutor({
      maxInFlightCommands: 1,
      onAck: rec.onAck,
      onEvent: rec.onEvent,
    });

    executor.enqueue(parseWireCommand(wireCommand({ method: "patch" })));

    expect(rec.acks).toEqual([
      { commandId: "wire-1", accepted: true, state: "accepted" },
    ]);
    expect(executor.getStats()).toEqual({ activeCommands: 0, queueDepth: 1 });
  });
});

describe("scheduling", () => {
  it("holds commands while disconnected and dispatches on connect", () => {
    const prepared: string[] = [];
    executor = createExecutor({
      maxInFlightCommands: 2,
      onEvent: () => undefined,
      prepareCommandForExecution: (command) => {
        prepared.push(command.commandId);
        return parkForever();
      },
    });

    executor.enqueue(buildCommand("held-1", {}, { repoPath: "/repo/a" }));
    expect(prepared).toEqual([]);
    expect(executor.getStats()).toEqual({ activeCommands: 0, queueDepth: 1 });

    executor.setConnected(true);

    expect(prepared).toEqual(["held-1"]);
    expect(executor.getStats()).toEqual({ activeCommands: 1, queueDepth: 0 });
  });

  it("serializes on a trimmed explicit lockKey over differing repo paths", () => {
    const prepared: string[] = [];
    executor = createExecutor({
      maxInFlightCommands: 3,
      onEvent: () => undefined,
      prepareCommandForExecution: (command) => {
        prepared.push(command.commandId);
        return parkForever();
      },
    });
    executor.setConnected(true);

    executor.enqueue({
      ...buildCommand("lock-a", {}, { repoPath: "/repo/a" }),
      lockKey: " shared ",
    });
    executor.enqueue({
      ...buildCommand("lock-b", {}, { repoPath: "/repo/b" }),
      lockKey: "shared",
    });
    executor.enqueue(buildCommand("lock-c", {}, { repoPath: "/repo/c" }));

    expect(prepared).toEqual(["lock-a", "lock-c"]);
    expect(executor.getStats()).toEqual({ activeCommands: 2, queueDepth: 1 });
  });

  it("falls back to the body-derived lock when the explicit lockKey is blank", () => {
    const prepared: string[] = [];
    executor = createExecutor({
      maxInFlightCommands: 2,
      onEvent: () => undefined,
      prepareCommandForExecution: (command) => {
        prepared.push(command.commandId);
        return parkForever();
      },
    });
    executor.setConnected(true);

    executor.enqueue({
      ...buildCommand("blank-a", {}, { repoPath: "/repo/same" }),
      lockKey: "   ",
    });
    executor.enqueue({
      ...buildCommand("blank-b", {}, { repoPath: "/repo/same" }),
      lockKey: "   ",
    });

    expect(prepared).toEqual(["blank-a"]);
    expect(executor.getStats()).toEqual({ activeCommands: 1, queueDepth: 1 });
  });

  it("reports a non-Error preparation rejection as an unknown command failure", async () => {
    const rec = recorder();
    const failed = vi.spyOn(Observability, "commandFailed");
    executor = createExecutor({
      maxInFlightCommands: 1,
      onEvent: rec.onEvent,
      prepareCommandForExecution: () => Promise.reject("not an Error"),
    });
    executor.setConnected(true);

    executor.enqueue(buildCommand("reject-1", {}));
    await waitFor(() => rec.events.length === 2);

    expect(rec.events[1]).toEqual({
      commandId: "reject-1",
      sequence: 2,
      eventType: "error",
      data: { type: "error", terminal: true, error: "unknown command failure" },
    });
    expect(failed).toHaveBeenCalledWith(
      "reject-1",
      "git_action",
      "unknown command failure"
    );
    await waitFor(() => executor?.getStats().activeCommands === 0);
  });
});

describe("cancel", () => {
  it("defaults the reason of a queued cancel to cancelled", () => {
    const rec = recorder();
    executor = createExecutor({
      maxInFlightCommands: 1,
      onEvent: rec.onEvent,
    });
    executor.enqueue(buildCommand("queued-1", {}));

    executor.cancel(bareCancel("queued-1"));

    expect(rec.events).toEqual([
      {
        commandId: "queued-1",
        sequence: 1,
        eventType: "done",
        data: { type: "done", cancelled: true, reason: "cancelled" },
      },
    ]);
    expect(executor.getStats()).toEqual({ activeCommands: 0, queueDepth: 0 });
  });

  it("ignores a cancel for an unknown command", () => {
    const rec = recorder();
    const cancelled = vi.spyOn(Observability, "commandCancelled");
    executor = createExecutor({
      maxInFlightCommands: 1,
      onEvent: rec.onEvent,
    });
    executor.enqueue(buildCommand("known-1", {}));

    executor.cancel(buildCancel("unknown-1", "stop"));

    expect(rec.events).toEqual([]);
    expect(cancelled).not.toHaveBeenCalled();
    expect(executor.getStats()).toEqual({ activeCommands: 0, queueDepth: 1 });
  });

  it("finalizes a running cancel once, with the default reason, when cancelled twice", () => {
    const rec = recorder();
    const cancelled = vi.spyOn(Observability, "commandCancelled");
    executor = createExecutor({
      maxInFlightCommands: 1,
      onEvent: rec.onEvent,
      cancelForceSettleGraceMs: 60_000,
      prepareCommandForExecution: parkForever,
    });
    executor.setConnected(true);
    executor.enqueue(buildCommand("running-1", {}));

    executor.cancel(bareCancel("running-1"));
    executor.cancel(buildCancel("running-1", "second"));

    expect(rec.events).toEqual([
      {
        commandId: "running-1",
        sequence: 1,
        eventType: "status",
        data: { type: "status", status: "running", operationId: "git_action" },
      },
      {
        commandId: "running-1",
        sequence: 2,
        eventType: "done",
        data: { type: "done", cancelled: true, reason: "cancelled" },
      },
    ]);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(executor.getStats()).toEqual({ activeCommands: 1, queueDepth: 0 });
  });

  it("force-settle clears the per-command timeout of a wedged cancelled command", () => {
    vi.useFakeTimers();
    const stats: { activeCommands: number; queueDepth: number }[] = [];
    executor = createExecutor({
      maxInFlightCommands: 1,
      onEvent: () => undefined,
      onQueueStatsChange: (next) => stats.push(next),
      cancelForceSettleGraceMs: 25,
      prepareCommandForExecution: parkForever,
    });
    executor.setConnected(true);
    executor.enqueue(buildCommand("wedged-1", {}, { timeoutMs: 60_000 }));
    executor.cancel(buildCancel("wedged-1", "stop"));
    expect(vi.getTimerCount()).toBe(2);

    vi.advanceTimersByTime(25);

    expect(vi.getTimerCount()).toBe(0);
    expect(executor.getStats()).toEqual({ activeCommands: 0, queueDepth: 0 });
    expect(stats.at(-1)).toEqual({ activeCommands: 0, queueDepth: 0 });
  });
});

describe("acknowledge and replay", () => {
  it("trims acked events from a running command's replay buffer", () => {
    const rec = recorder();
    executor = createExecutor({
      maxInFlightCommands: 1,
      onEvent: rec.onEvent,
      prepareCommandForExecution: parkForever,
    });
    executor.setConnected(true);
    executor.enqueue(buildCommand("ack-1", {}));
    expect(rec.events).toHaveLength(1);

    executor.replayFrom({ "ack-1": 0 });
    expect(rec.events).toHaveLength(2);

    executor.acknowledge(streamAck("ack-1", 1));
    executor.replayFrom({ "ack-1": 0 });

    expect(rec.events).toHaveLength(2);
  });

  it("keeps a terminal command's buffer intact after an ack", () => {
    const rec = recorder();
    executor = createExecutor({
      maxInFlightCommands: 1,
      onEvent: rec.onEvent,
    });
    executor.enqueue(buildCommand("ack-2", {}));
    executor.cancel(buildCancel("ack-2", "stop"));

    executor.acknowledge(streamAck("ack-2", 1));
    executor.replayFrom({ "ack-2": 0 });

    // pins current behavior; looks odd because an acked terminal event is still
    // replayed: acknowledge() skips trimming once the command is terminal.
    expect(rec.events).toEqual([rec.events[0], rec.events[0]]);
  });

  it("ignores acks and replays for unknown commands", () => {
    const rec = recorder();
    executor = createExecutor({
      maxInFlightCommands: 1,
      onEvent: rec.onEvent,
    });

    executor.acknowledge(streamAck("ghost", 5));
    executor.replayFrom({ ghost: 0 });

    expect(rec.events).toEqual([]);
  });

  it("replays from 0 on a non-finite sequence and truncates a fractional one", () => {
    const rec = recorder();
    executor = createExecutor({
      maxInFlightCommands: 1,
      onEvent: rec.onEvent,
      prepareCommandForExecution: parkForever,
    });
    executor.setConnected(true);
    executor.enqueue(buildCommand("replay-1", {}));
    executor.cancel(buildCancel("replay-1", "stop"));
    rec.events.length = 0;

    executor.replayFrom({ "replay-1": Number.NaN });
    expect(rec.events.map((event) => event.sequence)).toEqual([1, 2]);

    rec.events.length = 0;
    executor.replayFrom({ "replay-1": 1.9 });
    expect(rec.events.map((event) => event.sequence)).toEqual([2]);
  });
});

describe("terminal command retention", () => {
  it("forgets a terminal command older than the retention window on the next enqueue", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-17T00:00:00.000Z"));
    executor = createExecutor({
      maxInFlightCommands: 1,
      onEvent: () => undefined,
    });
    executor.enqueue(buildCommand("kept", {}));
    executor.enqueue(buildCommand("expired", {}));
    executor.cancel(buildCancel("expired", "stop"));
    vi.setSystemTime(Date.now() + 1);
    executor.cancel(buildCancel("kept", "stop"));

    vi.setSystemTime(Date.now() + COMMAND_RETENTION_MS);
    executor.enqueue(buildCommand("trigger", {}));
    expect(executor.getStats()).toEqual({ activeCommands: 0, queueDepth: 1 });

    // Exactly at the window: still retained, so a re-send is a duplicate.
    executor.enqueue(buildCommand("kept", {}));
    expect(executor.getStats()).toEqual({ activeCommands: 0, queueDepth: 1 });

    // Past the window: forgotten, so the same id queues as a new command.
    executor.enqueue(buildCommand("expired", {}));
    expect(executor.getStats()).toEqual({ activeCommands: 0, queueDepth: 2 });
  });

  it("evicts the earliest-completed terminal command beyond the retention cap, not the earliest enqueued", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-17T00:00:00.000Z"));
    executor = createExecutor({
      maxInFlightCommands: 1,
      onEvent: () => undefined,
    });
    for (let index = 0; index <= MAX_RETAINED_TERMINAL_COMMANDS; index += 1) {
      executor.enqueue(buildCommand(`cap-${index}`, {}));
    }
    // Complete in reverse so completion order is the opposite of insertion order.
    for (let index = MAX_RETAINED_TERMINAL_COMMANDS; index >= 0; index -= 1) {
      executor.cancel(buildCancel(`cap-${index}`, "stop"));
      vi.setSystemTime(Date.now() + 1);
    }

    executor.enqueue(buildCommand("trigger", {}));
    expect(executor.getStats()).toEqual({ activeCommands: 0, queueDepth: 1 });

    executor.enqueue(buildCommand("cap-0", {}));
    executor.enqueue(
      buildCommand(`cap-${MAX_RETAINED_TERMINAL_COMMANDS - 1}`, {})
    );
    expect(executor.getStats()).toEqual({ activeCommands: 0, queueDepth: 1 });

    executor.enqueue(buildCommand(`cap-${MAX_RETAINED_TERMINAL_COMMANDS}`, {}));
    expect(executor.getStats()).toEqual({ activeCommands: 0, queueDepth: 2 });
  });
});

describe("dispose", () => {
  it("records no failure telemetry for a command whose work rejects after dispose", async () => {
    const failed = vi.spyOn(Observability, "commandFailed");
    const stats: { activeCommands: number; queueDepth: number }[] = [];
    let rejectPrepare: (error: Error) => void = () => undefined;
    const prepare = new Promise<DesktopCommandEvent>((_resolve, reject) => {
      rejectPrepare = reject;
    });
    executor = createExecutor({
      maxInFlightCommands: 1,
      onEvent: () => undefined,
      onQueueStatsChange: (next) => stats.push(next),
      prepareCommandForExecution: () => prepare,
    });
    executor.setConnected(true);
    executor.enqueue(buildCommand("disposed-1", {}));
    expect(stats.at(-1)).toEqual({ activeCommands: 1, queueDepth: 0 });

    executor.dispose();
    rejectPrepare(new Error("aborted by shutdown"));

    // execute()'s finally re-runs schedule(), which reports the emptied queue;
    // that report proves the catch block has already run.
    await waitFor(() => stats.length > 0 && stats.at(-1)?.activeCommands === 0);
    expect(failed).not.toHaveBeenCalled();
  });

  it("clears a running command's timeout and cancel force-settle timers", () => {
    vi.useFakeTimers();
    executor = createExecutor({
      maxInFlightCommands: 1,
      onEvent: () => undefined,
      cancelForceSettleGraceMs: 60_000,
      prepareCommandForExecution: parkForever,
    });
    executor.setConnected(true);
    executor.enqueue(buildCommand("dispose-1", {}, { timeoutMs: 30_000 }));
    executor.cancel(buildCancel("dispose-1", "stop"));
    expect(vi.getTimerCount()).toBe(2);

    executor.dispose();

    expect(vi.getTimerCount()).toBe(0);
    expect(executor.getStats()).toEqual({ activeCommands: 0, queueDepth: 0 });
  });
});
