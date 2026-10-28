import assert from "node:assert/strict";
import crypto from "node:crypto";
import type http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, test } from "vitest";
import type { CloudCommandExecutor } from "../src/main/cloud/cloud-command-executor.js";
import type {
  DesktopCommandAckEvent,
  DesktopCommandStreamEvent,
} from "../src/main/cloud/cloud-protocol.js";
import { Observability } from "../src/main/telemetry/observability.js";
import {
  asRecord,
  buildCancel,
  buildCommand,
  closeGateway,
  countDone,
  createExecutor,
  startGateway,
  waitFor,
} from "./cloud-command-executor-harness.js";

Observability.initNoOp();

let executor: CloudCommandExecutor | null = null;

afterEach(async () => {
  Observability.reset();
  executor?.dispose();
  executor = null;
  await closeGateway();
});

test("serializes conflicting lock keys while allowing parallel non-conflicting commands", async () => {
  const startOrder: string[] = [];
  let maxActive = 0;
  let active = 0;

  await startGateway(async (request, response, body) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const command = url.searchParams.get("command") ?? "unknown";
    startOrder.push(command);
    active += 1;
    maxActive = Math.max(maxActive, active);

    await sleep(80);
    active -= 1;

    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, command, body }));
  });

  const events: Omit<
    DesktopCommandStreamEvent,
    "protocolVersion" | "messageId" | "timestamp"
  >[] = [];
  executor = createExecutor({
    maxInFlightCommands: 2,
    onEvent: (event) => events.push(event),
  });
  executor.setConnected(true);

  executor.enqueue(
    buildCommand("c1", { command: "c1" }, { repoPath: "/repo/a" })
  );
  executor.enqueue(
    buildCommand("c2", { command: "c2" }, { repoPath: "/repo/a" })
  );
  executor.enqueue(
    buildCommand("c3", { command: "c3" }, { repoPath: "/repo/b" })
  );

  await waitFor(
    () =>
      countDone(events, "c1") === 1 &&
      countDone(events, "c2") === 1 &&
      countDone(events, "c3") === 1
  );

  assert.equal(maxActive, 2);
  const c2Index = startOrder.indexOf("c2");
  const c3Index = startOrder.indexOf("c3");
  assert.ok(
    c2Index > c3Index,
    `expected c3 to start before c2, got order: ${startOrder.join(",")}`
  );
});

test("cancels queued command with terminal done(cancelled=true)", async () => {
  const started: string[] = [];

  await startGateway(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const command = url.searchParams.get("command") ?? "unknown";
    started.push(command);
    await sleep(120);
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, command }));
  });

  const events: Omit<
    DesktopCommandStreamEvent,
    "protocolVersion" | "messageId" | "timestamp"
  >[] = [];
  executor = createExecutor({
    maxInFlightCommands: 1,
    onEvent: (event) => events.push(event),
  });
  executor.setConnected(true);

  executor.enqueue(
    buildCommand("c1", { command: "c1" }, { repoPath: "/repo/a" })
  );
  executor.enqueue(
    buildCommand("c2", { command: "c2" }, { repoPath: "/repo/b" })
  );
  executor.cancel(buildCancel("c2", "user requested cancel"));

  await waitFor(
    () => countDone(events, "c1") === 1 && countDone(events, "c2") === 1
  );

  const cancelledDone = events.find(
    (event) => event.commandId === "c2" && event.eventType === "done"
  );
  assert.ok(cancelledDone);
  assert.equal((cancelledDone.data as Record<string, unknown>).cancelled, true);
  assert.deepEqual(started, ["c1"]);
});

test("force-settles a cancelled command whose tool ignores the abort, freeing its slot (FEA-1004)", async () => {
  // Simulate an underlying tool that ignores the AbortSignal: prepareCommand
  // ForExecution runs BEFORE the gateway fetch and is not signal-aware, so a
  // cancel that arrives while it is running has nothing to interrupt — the fetch
  // never even starts, so execute()'s finally (which frees the slot) never runs.
  // Without the force-settle watchdog the in-flight slot leaks forever and, at
  // maxInFlightCommands: 1, the scheduler wedges: the queued conflicting command
  // never dispatches. The watchdog must reclaim the slot so `queued` runs.
  let releasePrepare: (() => void) | null = null;
  const preparePromise = new Promise<void>((resolve) => {
    releasePrepare = resolve;
  });

  await startGateway(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const command = url.searchParams.get("command") ?? "unknown";
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, command }));
  });

  const events: Omit<
    DesktopCommandStreamEvent,
    "protocolVersion" | "messageId" | "timestamp"
  >[] = [];
  executor = createExecutor({
    maxInFlightCommands: 1,
    onEvent: (event) => events.push(event),
    cancelForceSettleGraceMs: 40,
    prepareCommandForExecution: async (command) => {
      // Only the first (cancelled) command hangs in prepare; the queued command
      // that dispatches after the slot frees resolves immediately.
      if (command.commandId === "wedged") {
        await preparePromise;
      }
      return command;
    },
  });
  executor.setConnected(true);

  executor.enqueue(
    buildCommand("wedged", { command: "wedged" }, { repoPath: "/repo/a" })
  );
  // Same lock key: it can only dispatch once the wedged command's slot frees.
  executor.enqueue(
    buildCommand("queued", { command: "queued" }, { repoPath: "/repo/a" })
  );

  // Let the wedged command occupy the single slot (parked in prepare).
  await waitFor(() => executor?.getStats().activeCommands === 1);
  executor.cancel(buildCancel("wedged", "user requested cancel"));

  // The wedged command finalizes to terminal done(cancelled) immediately, even
  // though its fetch never ran and its prepare is still parked.
  await waitFor(() => countDone(events, "wedged") === 1);
  const cancelledDone = events.find(
    (event) => event.commandId === "wedged" && event.eventType === "done"
  );
  assert.ok(cancelledDone, "the cancelled command emitted no done event");
  assert.equal((cancelledDone.data as Record<string, unknown>).cancelled, true);

  // The force-settle watchdog reclaims the leaked slot, so the conflicting
  // queued command dispatches and completes despite the wedged prepare still
  // being parked.
  await waitFor(() => countDone(events, "queued") === 1);

  // Cleanup: release the parked prepare so the wedged execute() can unwind.
  releasePrepare?.();
});

test("suppresses late events from a cancelled command's stream (FEA-1004)", async () => {
  // A streaming gateway that keeps emitting after the client aborts. undici
  // rejects the pending read on abort, but events already buffered on the wire
  // can still arrive between the cancel and the reject. Because cancel() marks
  // the command terminal synchronously, emitTrackedEvent's terminal guard must
  // drop those late events so they are never forwarded to the cloud (where they
  // would replay onto a later command reusing this lock key).
  let sawChunkAfterFirst = false;
  await startGateway(async (request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "application/x-ndjson");
    response.flushHeaders();
    response.write(`${JSON.stringify({ type: "text", content: "early" })}\n`);
    // Keep streaming "late" output; the executor must not forward any of it once
    // the command is cancelled. Never end so only the abort tears it down.
    const interval = setInterval(() => {
      sawChunkAfterFirst = true;
      response.write(`${JSON.stringify({ type: "text", content: "late" })}\n`);
    }, 10);
    // `.unref()` so this server-side ticker can never keep the Node event loop
    // (and thus the test process) alive after the run: the client abort should
    // fire `close` and clear it, but if that teardown is missed the unref'd timer
    // still lets the process exit. Clear on both `request` and `response` close.
    interval.unref?.();
    const stop = () => clearInterval(interval);
    request.on("close", stop);
    response.on("close", stop);
  });

  const events: Omit<
    DesktopCommandStreamEvent,
    "protocolVersion" | "messageId" | "timestamp"
  >[] = [];
  executor = createExecutor({
    maxInFlightCommands: 1,
    onEvent: (event) => events.push(event),
  });
  executor.setConnected(true);

  executor.enqueue(
    buildCommand("streamer", { command: "streamer" }, { repoPath: "/repo/a" })
  );

  // Wait for the first streamed chunk to be forwarded, then cancel.
  await waitFor(() =>
    events.some(
      (event) =>
        event.commandId === "streamer" &&
        event.eventType === "chunk" &&
        asRecord(event.data).content === "early"
    )
  );
  await waitFor(() => sawChunkAfterFirst);
  const forwardedBeforeCancel = events.filter(
    (event) => event.commandId === "streamer"
  ).length;
  executor.cancel(buildCancel("streamer", "user requested cancel"));

  await waitFor(() => countDone(events, "streamer") === 1);
  const cancelledDone = events.find(
    (event) => event.commandId === "streamer" && event.eventType === "done"
  );
  assert.ok(cancelledDone, "the cancelled command emitted no done event");
  assert.equal((cancelledDone.data as Record<string, unknown>).cancelled, true);

  // Give the wedged stream time to emit several more "late" chunks server-side.
  await sleep(80);

  // No non-terminal event is forwarded after the terminal done(cancelled): the
  // only events beyond the pre-cancel set are the single terminal done.
  const afterCancel = events.filter((event) => event.commandId === "streamer");
  const nonTerminalAfterCancel = afterCancel.filter(
    (event) => event.eventType !== "done"
  ).length;
  assert.equal(nonTerminalAfterCancel, forwardedBeforeCancel);
  assert.equal(countDone(events, "streamer"), 1);
});

test("cancel is a no-op (no cancelled telemetry, no second done) when the command already finished (FEA-1004)", async () => {
  // Race: a streaming command reaches its terminal `done` from the gateway while
  // its in-flight entry is still draining, then a late cancel arrives for it.
  // cancel() must NOT fire Observability.commandCancelled or emit a second
  // done(cancelled) for a command that actually finished; it may only abort the
  // idle socket. Emitting cancelled telemetry here would misattribute a completed
  // command as user-cancelled.
  await startGateway(async (_request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "application/x-ndjson");
    response.flushHeaders();
    // Emit the terminal done, then hold the socket open so the command's
    // in-flight entry lingers and a cancel can still find a `running` record.
    response.write(`${JSON.stringify({ type: "done" })}\n`);
    // Never end; only the executor's abort tears this down.
  });

  const cancelCalls: string[] = [];
  const failedCalls: string[] = [];
  const origCancelled = Observability.commandCancelled;
  const origFailed = Observability.commandFailed;
  try {
    Observability.commandCancelled = (
      commandId: string,
      operationId: string
    ) => {
      cancelCalls.push(commandId);
      origCancelled.call(Observability, commandId, operationId);
    };
    Observability.commandFailed = (
      commandId: string,
      operationId: string,
      errorClass: string
    ) => {
      failedCalls.push(commandId);
      origFailed.call(Observability, commandId, operationId, errorClass);
    };

    const events: Omit<
      DesktopCommandStreamEvent,
      "protocolVersion" | "messageId" | "timestamp"
    >[] = [];
    executor = createExecutor({
      maxInFlightCommands: 1,
      onEvent: (event) => events.push(event),
    });
    executor.setConnected(true);

    executor.enqueue(
      buildCommand("finished", { command: "finished" }, { repoPath: "/repo/a" })
    );

    // Wait until the command is terminal (its done was forwarded).
    await waitFor(() => countDone(events, "finished") === 1);
    const doneBeforeCancel = countDone(events, "finished");

    // Late cancel for the already-finished command.
    executor.cancel(buildCancel("finished", "user requested cancel"));

    // Give any (erroneous) emit/telemetry a chance to run.
    await sleep(60);

    assert.equal(
      cancelCalls.length,
      0,
      "commandCancelled must not fire for an already-terminal command"
    );
    assert.equal(
      countDone(events, "finished"),
      doneBeforeCancel,
      "no second done should be emitted for an already-terminal command"
    );
    // Aborting the still-open socket must not be misreported as a command
    // failure either: the abort-driven fetch rejection is an intentional cancel,
    // not a gateway error.
    assert.equal(
      failedCalls.length,
      0,
      "commandFailed must not fire for an already-terminal command's abort"
    );
  } finally {
    Observability.commandCancelled = origCancelled;
    Observability.commandFailed = origFailed;
  }
});

test("emits terminal timeout error when command exceeds timeoutMs", async () => {
  await startGateway(async (_request, _response) => {
    await sleep(250);
  });

  const events: Omit<
    DesktopCommandStreamEvent,
    "protocolVersion" | "messageId" | "timestamp"
  >[] = [];
  executor = createExecutor({
    maxInFlightCommands: 1,
    onEvent: (event) => events.push(event),
  });
  executor.setConnected(true);

  executor.enqueue(
    buildCommand(
      "timeout-command",
      { command: "timeout-command" },
      { repoPath: "/repo/a", timeoutMs: 30 }
    )
  );

  await waitFor(
    () =>
      events.some(
        (event) =>
          event.commandId === "timeout-command" &&
          event.eventType === "error" &&
          asRecord(event.data).terminal === true &&
          asRecord(event.data).code === "timeout"
      ),
    2000
  );
});

test("gateway response watchdog releases a wedged slot when timeoutMs is absent (FEA-2848)", async () => {
  // A handler that accepts the connection but never sends a response: without an
  // independent watchdog the fetch never settles, the in-flight slot is never
  // released, and a maxInFlightCommands-capped scheduler stalls forever.
  await startGateway(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.searchParams.get("command") === "wedged") {
      await sleep(10_000); // never responds within the test window
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });

  const events: Omit<
    DesktopCommandStreamEvent,
    "protocolVersion" | "messageId" | "timestamp"
  >[] = [];
  executor = createExecutor({
    maxInFlightCommands: 1,
    onEvent: (event) => events.push(event),
    gatewayResponseTimeoutMs: 40,
  });
  executor.setConnected(true);

  // No timeoutMs on either command — the wire default the finding describes.
  executor.enqueue(
    buildCommand("wedged", { command: "wedged" }, { repoPath: "/repo/a" })
  );
  executor.enqueue(
    buildCommand("after", { command: "after" }, { repoPath: "/repo/b" })
  );

  // The watchdog aborts the stuck fetch, surfacing a terminal error for it...
  await waitFor(
    () =>
      events.some(
        (event) =>
          event.commandId === "wedged" &&
          event.eventType === "error" &&
          asRecord(event.data).terminal === true
      ),
    2000
  );
  // ...and the freed slot lets the queued command dispatch and complete.
  await waitFor(
    () =>
      events.some(
        (event) => event.commandId === "after" && event.eventType === "done"
      ),
    2000
  );
});

test("replays buffered events from resume sequence", async () => {
  await startGateway(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const command = url.searchParams.get("command") ?? "unknown";
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, command }));
  });

  const events: Omit<
    DesktopCommandStreamEvent,
    "protocolVersion" | "messageId" | "timestamp"
  >[] = [];
  executor = createExecutor({
    maxInFlightCommands: 1,
    onEvent: (event) => events.push(event),
  });
  executor.setConnected(true);

  executor.enqueue(
    buildCommand(
      "replay-command",
      { command: "replay-command" },
      { repoPath: "/repo/a" }
    )
  );
  await waitFor(() => countDone(events, "replay-command") === 1);

  const eventCountBeforeReplay = events.length;
  executor.replayFrom({ "replay-command": 1 });
  await waitFor(() => events.length > eventCountBeforeReplay);

  const replayed = events
    .slice(eventCountBeforeReplay)
    .filter((event) => event.commandId === "replay-command");
  assert.ok(replayed.every((event) => event.sequence > 1));
});

test("fails a streaming command whose replay buffer exceeds the high-water mark while acks stall", async () => {
  const mark = 5;
  let streamClosed = false;

  await startGateway(async (_request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "application/x-ndjson");
    response.on("close", () => {
      streamClosed = true;
    });
    // Stream far more chunk events than the buffer mark. The executor never
    // acks (simulating a disconnected cloud socket), so its per-command buffer
    // should hit the high-water mark and abort this response.
    for (let i = 0; i < 1000 && !streamClosed && !response.destroyed; i += 1) {
      try {
        response.write(
          `${JSON.stringify({ type: "chunk", content: `line-${i}` })}\n`
        );
      } catch {
        break;
      }
      await sleep(2);
    }
    try {
      response.end();
    } catch {
      // response already torn down by the executor's backpressure abort
    }
  });

  const events: Omit<
    DesktopCommandStreamEvent,
    "protocolVersion" | "messageId" | "timestamp"
  >[] = [];
  executor = createExecutor({
    maxInFlightCommands: 1,
    onEvent: (event) => events.push(event),
    maxBufferedEventsPerCommand: mark,
  });
  executor.setConnected(true);

  const commandId = "buffer-overflow";
  // Never call acknowledge(): nothing trims buffered.events, so it grows until
  // the high-water mark trips.
  executor.enqueue(buildCommand(commandId, { command: "stream" }));

  await waitFor(() =>
    events.some(
      (event) =>
        event.commandId === commandId &&
        event.eventType === "error" &&
        asRecord(event.data).code === "buffer_overflow"
    )
  );
  await waitFor(() => executor?.getStats().activeCommands === 0);
  await waitFor(() => streamClosed);

  const forwarded = events.filter((event) => event.commandId === commandId);
  const overflowError = forwarded.find(
    (event) => asRecord(event.data).code === "buffer_overflow"
  );
  assert.ok(overflowError);
  assert.equal(overflowError.eventType, "error");
  assert.equal(asRecord(overflowError.data).terminal, true);
  // The overflow error is the last event: the command went terminal, so nothing
  // more is emitted even though the gateway kept trying to stream.
  assert.equal(forwarded.at(-1), overflowError);
  // Buffer is bounded: no more than the mark's worth of events plus the single
  // terminal error, versus the 1000 the gateway attempted to push.
  assert.ok(
    forwarded.length <= mark + 1,
    `expected at most ${mark + 1} forwarded events, got ${forwarded.length}`
  );
  assert.deepEqual(executor.getStats(), { activeCommands: 0, queueDepth: 0 });
});

test("completes a streaming command whose terminal event lands on the buffer high-water mark", async () => {
  const mark = 4;

  await startGateway(async (_request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "application/x-ndjson");
    // The "running" status event takes the first buffer slot, so `mark - 1`
    // chunks fill the buffer to exactly the mark. The terminal `done` then lands
    // on the boundary: it must still complete the command, not trip overflow.
    for (let i = 0; i < mark - 1; i += 1) {
      response.write(
        `${JSON.stringify({ type: "chunk", content: `c${i}` })}\n`
      );
    }
    response.write(`${JSON.stringify({ type: "done" })}\n`);
    response.end();
  });

  const events: Omit<
    DesktopCommandStreamEvent,
    "protocolVersion" | "messageId" | "timestamp"
  >[] = [];
  executor = createExecutor({
    maxInFlightCommands: 1,
    onEvent: (event) => events.push(event),
    maxBufferedEventsPerCommand: mark,
  });
  executor.setConnected(true);

  const commandId = "boundary-done";
  // Never ack: the buffer is never trimmed, so the terminal event lands exactly
  // at the high-water mark.
  executor.enqueue(buildCommand(commandId, { command: "stream" }));

  await waitFor(() => countDone(events, commandId) === 1);

  const forwarded = events.filter((event) => event.commandId === commandId);
  assert.ok(
    !forwarded.some((event) => asRecord(event.data).code === "buffer_overflow"),
    "terminal event on the boundary must not be converted to a buffer overflow"
  );
  assert.equal(forwarded.at(-1)?.eventType, "done");
  assert.deepEqual(executor.getStats(), { activeCommands: 0, queueDepth: 0 });
});

test("forwards request body for DELETE commands", async () => {
  let receivedBody = "";
  let receivedMethod = "";

  await startGateway(async (request, response, body) => {
    receivedMethod = request.method ?? "";
    receivedBody = body;
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });

  const events: Omit<
    DesktopCommandStreamEvent,
    "protocolVersion" | "messageId" | "timestamp"
  >[] = [];
  executor = createExecutor({
    maxInFlightCommands: 1,
    onEvent: (event) => events.push(event),
  });
  executor.setConnected(true);

  executor.enqueue({
    protocolVersion: "1",
    messageId: "delete-body-msg",
    timestamp: new Date().toISOString(),
    commandId: "delete-body",
    operationId: "git_worktree_delete",
    method: "DELETE",
    path: "/api/gateway/git/worktree",
    query: {},
    body: {
      worktreePath: "/repo/my-worktree",
      force: true,
    },
  });

  await waitFor(() => countDone(events, "delete-body") === 1);

  assert.equal(receivedMethod, "DELETE");
  const parsed = JSON.parse(receivedBody) as Record<string, unknown>;
  assert.equal(parsed.worktreePath, "/repo/my-worktree");
  assert.equal(parsed.force, true);
});

test("does not forward body for GET commands", async () => {
  let receivedBody = "";

  await startGateway(async (_request, response, body) => {
    receivedBody = body;
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });

  const events: Omit<
    DesktopCommandStreamEvent,
    "protocolVersion" | "messageId" | "timestamp"
  >[] = [];
  executor = createExecutor({
    maxInFlightCommands: 1,
    onEvent: (event) => events.push(event),
  });
  executor.setConnected(true);

  executor.enqueue({
    protocolVersion: "1",
    messageId: "get-nobody-msg",
    timestamp: new Date().toISOString(),
    commandId: "get-nobody",
    operationId: "status_check",
    method: "GET",
    path: "/api/gateway/git/local-changes",
    query: { repo: "/repo/a" },
    body: { shouldNotBeSent: true },
  });

  await waitFor(() => countDone(events, "get-nobody") === 1);

  assert.equal(receivedBody, "");
});

test("sends x-desktop-command-id and x-desktop-operation-id headers in gateway requests", async () => {
  let receivedCommandId: string | undefined;
  let receivedOperationId: string | undefined;

  const commandId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  const operationId = "f1e2d3c4-b5a6-7890-abcd-ef1234567890";

  await startGateway(async (request, response) => {
    receivedCommandId = request.headers["x-desktop-command-id"] as
      | string
      | undefined;
    receivedOperationId = request.headers["x-desktop-operation-id"] as
      | string
      | undefined;
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });

  const events: Omit<
    DesktopCommandStreamEvent,
    "protocolVersion" | "messageId" | "timestamp"
  >[] = [];
  executor = createExecutor({
    maxInFlightCommands: 1,
    onEvent: (event) => events.push(event),
  });
  executor.setConnected(true);

  executor.enqueue({
    protocolVersion: "1",
    messageId: "header-test-msg",
    timestamp: new Date().toISOString(),
    commandId,
    operationId,
    method: "GET",
    path: "/api/gateway/git",
    query: {},
  });

  await waitFor(() => countDone(events, commandId) === 1);

  assert.equal(receivedCommandId, commandId);
  assert.equal(receivedOperationId, operationId);
});

test("omits x-desktop-command-id header when commandId is not a valid UUID", async () => {
  let receivedHeaders: http.IncomingHttpHeaders | undefined;

  await startGateway(async (request, response) => {
    receivedHeaders = request.headers;
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });

  const events: Omit<
    DesktopCommandStreamEvent,
    "protocolVersion" | "messageId" | "timestamp"
  >[] = [];
  executor = createExecutor({
    maxInFlightCommands: 1,
    onEvent: (event) => events.push(event),
  });
  executor.setConnected(true);

  // commandId with CRLF injection attempt — not a valid UUID
  const injectedCommandId = "not-a-uuid\r\nX-Injected: evil";
  executor.enqueue({
    protocolVersion: "1",
    messageId: "injection-test-msg",
    timestamp: new Date().toISOString(),
    commandId: injectedCommandId,
    operationId: "git_action",
    method: "GET",
    path: "/api/gateway/git",
    query: {},
  });

  await waitFor(() => countDone(events, injectedCommandId) === 1);

  assert.ok(receivedHeaders !== undefined);
  assert.equal(receivedHeaders["x-desktop-command-id"], undefined);
  assert.equal(receivedHeaders["x-injected"], undefined);
  // operationId "git_action" is a safe non-UUID value — header should be set
  assert.equal(receivedHeaders["x-desktop-operation-id"], "git_action");
});

test("omits x-desktop-operation-id header when operationId contains CRLF", async () => {
  let receivedHeaders: http.IncomingHttpHeaders | undefined;

  await startGateway(async (request, response) => {
    receivedHeaders = request.headers;
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });

  const events: Omit<
    DesktopCommandStreamEvent,
    "protocolVersion" | "messageId" | "timestamp"
  >[] = [];
  executor = createExecutor({
    maxInFlightCommands: 1,
    onEvent: (event) => events.push(event),
  });
  executor.setConnected(true);

  const commandId = crypto.randomUUID();
  executor.enqueue({
    protocolVersion: "1",
    messageId: "op-injection-test-msg",
    timestamp: new Date().toISOString(),
    commandId,
    operationId: "evil\r\nX-Injected: pwned",
    method: "GET",
    path: "/api/gateway/git",
    query: {},
  });

  await waitFor(() => countDone(events, commandId) === 1);

  assert.ok(receivedHeaders !== undefined);
  assert.equal(receivedHeaders["x-desktop-command-id"], commandId);
  assert.equal(receivedHeaders["x-desktop-operation-id"], undefined);
  assert.equal(receivedHeaders["x-injected"], undefined);
});

test("Observability.commandTimedOut is called on timeout", async () => {
  await startGateway(async () => {
    await sleep(250);
  });

  const calls: Array<{ commandId: string; operationId: string }> = [];
  const origMethod = Observability.commandTimedOut;
  try {
    Observability.commandTimedOut = (
      commandId: string,
      operationId: string
    ) => {
      calls.push({ commandId, operationId });
      origMethod.call(Observability, commandId, operationId);
    };

    const commandEvents: Omit<
      DesktopCommandStreamEvent,
      "protocolVersion" | "messageId" | "timestamp"
    >[] = [];

    executor = createExecutor({
      maxInFlightCommands: 1,
      onEvent: (event) => commandEvents.push(event),
    });
    executor.setConnected(true);

    const commandId = "a1b2c3d4-e5f6-7890-abcd-111111111111";
    executor.enqueue(
      buildCommand(
        commandId,
        { command: commandId },
        { repoPath: "/repo/a", timeoutMs: 30 }
      )
    );

    await waitFor(() => calls.length > 0, 2000);
    assert.equal(calls[0].commandId, commandId);
  } finally {
    Observability.commandTimedOut = origMethod;
  }
});

test("Observability.commandCancelled is called on cancel", async () => {
  await startGateway(async () => {
    await sleep(300);
  });

  const calls: Array<{ commandId: string }> = [];
  const origMethod = Observability.commandCancelled;
  try {
    Observability.commandCancelled = (
      commandId: string,
      _operationId: string
    ) => {
      calls.push({ commandId });
      origMethod.call(Observability, commandId, _operationId);
    };

    const commandEvents: Omit<
      DesktopCommandStreamEvent,
      "protocolVersion" | "messageId" | "timestamp"
    >[] = [];

    executor = createExecutor({
      maxInFlightCommands: 1,
      onEvent: (event) => commandEvents.push(event),
    });
    executor.setConnected(true);

    const commandId = "a1b2c3d4-e5f6-7890-abcd-222222222222";
    executor.enqueue(
      buildCommand(commandId, { command: commandId }, { repoPath: "/repo/a" })
    );

    await waitFor(() =>
      commandEvents.some(
        (e) => e.commandId === commandId && e.eventType === "status"
      )
    );
    executor.cancel(buildCancel(commandId, "user requested cancel"));

    await waitFor(() => calls.length > 0, 2000);
    assert.equal(calls[0].commandId, commandId);
  } finally {
    Observability.commandCancelled = origMethod;
  }
});

test("Observability.commandFailed is called on gateway error", async () => {
  await startGateway(async (_request, response) => {
    response.statusCode = 500;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "internal server error" }));
  });

  const calls: Array<{ commandId: string }> = [];
  const origMethod = Observability.commandFailed;
  try {
    Observability.commandFailed = (
      commandId: string,
      _operationId: string,
      _errorClass: string
    ) => {
      calls.push({ commandId });
      origMethod.call(Observability, commandId, _operationId, _errorClass);
    };

    const commandEvents: Omit<
      DesktopCommandStreamEvent,
      "protocolVersion" | "messageId" | "timestamp"
    >[] = [];

    executor = createExecutor({
      maxInFlightCommands: 1,
      onEvent: (event) => commandEvents.push(event),
    });
    executor.setConnected(true);

    const commandId = "a1b2c3d4-e5f6-7890-abcd-333333333333";
    executor.enqueue(
      buildCommand(commandId, { command: commandId }, { repoPath: "/repo/a" })
    );

    await waitFor(() => calls.length > 0, 2000);
    assert.equal(calls[0].commandId, commandId);
  } finally {
    Observability.commandFailed = origMethod;
  }
});

test("emits a terminal error carrying the message when command preparation fails", async () => {
  const events: Omit<
    DesktopCommandStreamEvent,
    "protocolVersion" | "messageId" | "timestamp"
  >[] = [];
  const commandId = "0196b1bb-7a00-7000-8000-000000000008";

  executor = createExecutor({
    maxInFlightCommands: 1,
    onEvent: (event) => events.push(event),
    prepareCommandForExecution: async () => {
      throw new Error(PREPARATION_FAILURE_MESSAGE);
    },
  });
  executor.setConnected(true);
  executor.enqueue(buildCommand(commandId, { command: "prepare-fails" }));

  await waitFor(() =>
    events.some(
      (event) => event.commandId === commandId && event.eventType === "error"
    )
  );

  const errorEvent = events.find(
    (event) => event.commandId === commandId && event.eventType === "error"
  );
  assert.ok(errorEvent);
  assert.deepEqual(errorEvent.data, {
    type: "error",
    terminal: true,
    error: PREPARATION_FAILURE_MESSAGE,
  });
  assert.deepEqual(executor.getStats(), { activeCommands: 0, queueDepth: 0 });
});

// ISS-12784 (R3): an older server can still send signature fields; the Desktop
// no longer verifies them, so the command runs like any other.
test("runs a command that still carries signature fields from an older server", async () => {
  await startGateway(async (_request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });

  const acks: Pick<DesktopCommandAckEvent, "accepted">[] = [];
  const events: Omit<
    DesktopCommandStreamEvent,
    "protocolVersion" | "messageId" | "timestamp"
  >[] = [];
  const commandId = "0196b1bb-7a00-7000-8000-000000000007";

  executor = createExecutor({
    maxInFlightCommands: 1,
    onAck: (ack) => acks.push(ack),
    onEvent: (event) => events.push(event),
  });
  executor.setConnected(true);
  const olderServerSignatureFields = {
    signature: "not-valid",
    signaturePayload: "{",
    publicKeyFingerprint: "cl:unknown",
  };
  executor.enqueue({
    ...buildCommand(commandId, { command: "status" }),
    ...olderServerSignatureFields,
  });

  await waitFor(() => countDone(events, commandId) === 1);
  assert.equal(acks[0].accepted, true);
  assert.deepEqual(executor.getStats(), { activeCommands: 0, queueDepth: 0 });
});

// --- onQueueStatsChange dedupe ---

test("onQueueStatsChange: first notification on empty idle executor fires once", () => {
  const stats: Array<{ activeCommands: number; queueDepth: number }> = [];
  executor = createExecutor({
    maxInFlightCommands: 1,
    onEvent: () => {},
    onQueueStatsChange: (s) => stats.push(s),
  });
  executor.setConnected(true);
  assert.deepStrictEqual(stats, [{ activeCommands: 0, queueDepth: 0 }]);
});

test("onQueueStatsChange: idempotent setConnected(true) on idle executor does not re-fire", () => {
  const stats: Array<{ activeCommands: number; queueDepth: number }> = [];
  executor = createExecutor({
    maxInFlightCommands: 1,
    onEvent: () => {},
    onQueueStatsChange: (s) => stats.push(s),
  });
  executor.setConnected(true);
  executor.setConnected(false);
  executor.setConnected(true);
  assert.strictEqual(
    stats.length,
    1,
    "no-op schedule with unchanged 0/0 counts should not emit twice"
  );
});

test("onQueueStatsChange: depth-only change emits (enqueue beyond max in-flight, then cancel)", async () => {
  let releaseC1: (() => void) | null = null;
  const c1Blocker = new Promise<void>((resolve) => {
    releaseC1 = resolve;
  });

  await startGateway(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const command = url.searchParams.get("command") ?? "unknown";
    if (command === "c1") {
      await c1Blocker;
    }
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });

  const stats: Array<{ activeCommands: number; queueDepth: number }> = [];
  executor = createExecutor({
    maxInFlightCommands: 1,
    onEvent: () => {},
    onQueueStatsChange: (s) => stats.push(s),
  });
  executor.setConnected(true); // emits {0,0}
  executor.enqueue(
    buildCommand("c1", { command: "c1" }, { repoPath: "/repo/a" })
  );
  // Wait for c1 to enter flight so stats settles at {1,0}.
  await waitFor(() =>
    stats.some((s) => s.activeCommands === 1 && s.queueDepth === 0)
  );

  // c2 enqueued while c1 is in-flight with max=1 → sits in queue; depth grows.
  executor.enqueue(
    buildCommand("c2", { command: "c2" }, { repoPath: "/repo/b" })
  );
  await waitFor(() =>
    stats.some((s) => s.activeCommands === 1 && s.queueDepth === 1)
  );

  // Cancel the queued c2 → depth drops back; active unchanged.
  executor.cancel(buildCancel("c2", "user cancel"));
  await waitFor(() => {
    const last = stats.at(-1);
    return last.activeCommands === 1 && last.queueDepth === 0;
  });

  // No consecutive duplicates (dedupe guard works).
  for (let i = 1; i < stats.length; i++) {
    assert.ok(
      stats[i].activeCommands !== stats[i - 1].activeCommands ||
        stats[i].queueDepth !== stats[i - 1].queueDepth,
      `consecutive duplicate emission at index ${i}: ${JSON.stringify(stats[i])}`
    );
  }

  // Both partial-delta cases observed:
  //   {1,0} → {1,1}  depth-only (enqueue)
  //   {1,1} → {1,0}  depth-only (cancel)
  const pairs = stats.map((s) => `${s.activeCommands}/${s.queueDepth}`);
  assert.ok(
    pairs.includes("1/0") && pairs.includes("1/1"),
    `expected depth-only transitions through 1/0 and 1/1, got: ${pairs.join(", ")}`
  );

  releaseC1?.();
  await waitFor(() => stats.some((s) => s.activeCommands === 0));
});

test("onQueueStatsChange: dispose does not fire a final notification", () => {
  // dispose() must stay silent so it cannot re-arm a shutdown-side debounce
  // timer that outlives Observability.shutdown().
  const stats: Array<{ activeCommands: number; queueDepth: number }> = [];
  executor = createExecutor({
    maxInFlightCommands: 1,
    onEvent: () => {},
    onQueueStatsChange: (s) => stats.push(s),
  });
  executor.setConnected(true); // emits {0,0}
  const beforeDispose = stats.length;
  executor.dispose();
  assert.strictEqual(
    stats.length,
    beforeDispose,
    "dispose() must not invoke onQueueStatsChange"
  );
  executor = null; // prevent afterEach double-dispose
});

const PREPARATION_FAILURE_MESSAGE = "command preparation failed";
