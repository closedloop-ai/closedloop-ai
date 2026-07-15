import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { afterEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  CloudCommandExecutor,
  type CloudCommandExecutorOptions,
} from "../src/main/cloud-command-executor.js";
import type {
  DesktopCancelEvent,
  DesktopCommandAckEvent,
  DesktopCommandEvent,
  DesktopCommandStreamEvent,
} from "../src/main/cloud-protocol.js";
import { Observability } from "../src/main/observability.js";
import { SIGNED_LOOP_LAUNCH_MANAGED_KEY_ERROR } from "../src/main/signed-loop-launch-error.js";
import { COMMAND_SIGNING_REJECTION_REASONS } from "../src/shared/contracts.js";

Observability.initNoOp();

let gatewayServer: http.Server | null = null;
let gatewayPort = 0;
let executor: CloudCommandExecutor | null = null;

afterEach(async () => {
  Observability.reset();
  executor?.dispose();
  executor = null;
  if (!gatewayServer) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    gatewayServer?.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  gatewayServer = null;
  gatewayPort = 0;
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

test("gateway response watchdog spares a slow non-streaming loop launch while still bounding a wedged streaming-default command (Codex P2)", async () => {
  // The /api/gateway/symphony/loop route responds with JSON only after slow setup
  // (repo/worktree prep, binary resolution, process spawn). It must survive past
  // the short prompt-headers default — even when that default is injected small —
  // while a genuinely wedged non-loop command on the short bound is still aborted
  // so its in-flight slot frees.
  const SLOW_LAUNCH_RESPONSE_DELAY_MS = 150;
  await startGateway(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/api/gateway/symphony/loop") {
      // Legitimately slow: far beyond the 40ms injected default, but trivially
      // under the generous slow-setup backstop the route actually gets.
      await sleep(SLOW_LAUNCH_RESPONSE_DELAY_MS);
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, loopId: "loop-1" }));
      return;
    }
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
    // maxInFlightCommands: 2 so the slow loop launch and the wedged command run
    // concurrently against their different (route-aware) bounds.
    maxInFlightCommands: 2,
    onEvent: (event) => events.push(event),
    // The injected short bound governs only non-slow-setup routes; the loop route
    // is exempt and keeps its generous backstop.
    gatewayResponseTimeoutMs: 40,
  });
  executor.setConnected(true);

  // timeoutMs: null is exactly what the relay fixture sends for loop launches.
  executor.enqueue(
    buildCommand(
      "loop-launch",
      { command: "loop-launch" },
      {
        repoPath: "/repo/loop",
        timeoutMs: null,
        path: "/api/gateway/symphony/loop",
      }
    )
  );
  executor.enqueue(
    buildCommand("wedged", { command: "wedged" }, { repoPath: "/repo/wedged" })
  );

  // The wedged non-loop command hits the short 40ms bound and is aborted...
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

  // ...but the slow loop launch, which the short bound would have aborted at
  // 40ms, completes successfully because it is exempt and uses the backstop.
  await waitFor(() => countDone(events, "loop-launch") === 1, 2000);
  assert.equal(
    events.some(
      (event) =>
        event.commandId === "loop-launch" && event.eventType === "error"
    ),
    false,
    "slow loop launch must not surface a watchdog error"
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
    path: "/api/gateway/symphony/status/TICKET-1",
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

test("rejects unsigned commands before queueing when server signing support is enforced", () => {
  const acks: Omit<
    DesktopCommandAckEvent,
    "protocolVersion" | "messageId" | "timestamp"
  >[] = [];
  const events: Omit<
    DesktopCommandStreamEvent,
    "protocolVersion" | "messageId" | "timestamp"
  >[] = [];
  const commandId = "0196b1bb-7a00-7000-8000-000000000006";

  executor = createExecutor({
    maxInFlightCommands: 1,
    onAck: (ack) => acks.push(ack),
    onEvent: (event) => events.push(event),
    isCommandSigningEnforced: () => true,
    commandSignatureVerifier: {
      verify: () => ({
        ok: false,
        reason: COMMAND_SIGNING_REJECTION_REASONS.unsignedCommand,
      }),
    },
  });
  executor.setConnected(true);
  executor.enqueue(buildCommand(commandId, { command: "status" }));

  assert.deepEqual(acks, [
    {
      commandId,
      accepted: false,
      state: "failed",
      reason: COMMAND_SIGNING_REJECTION_REASONS.unsignedCommand,
    },
  ]);
  assert.deepEqual(events, []);
  assert.deepEqual(executor.getStats(), { activeCommands: 0, queueDepth: 0 });
});

test("emits terminal error with managed-key message when command preparation fails", async () => {
  const events: Omit<
    DesktopCommandStreamEvent,
    "protocolVersion" | "messageId" | "timestamp"
  >[] = [];
  const commandId = "0196b1bb-7a00-7000-8000-000000000008";

  executor = createExecutor({
    maxInFlightCommands: 1,
    onEvent: (event) => events.push(event),
    prepareCommandForExecution: async () => {
      throw new Error(SIGNED_LOOP_LAUNCH_MANAGED_KEY_ERROR);
    },
  });
  executor.setConnected(true);
  executor.enqueue(buildCommand(commandId, { command: "symphony_loop" }));

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
    error: SIGNED_LOOP_LAUNCH_MANAGED_KEY_ERROR,
  });
  assert.deepEqual(executor.getStats(), { activeCommands: 0, queueDepth: 0 });
});

test("ignores invalid signed envelopes when server signing support is disabled", async () => {
  await startGateway(async (_request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });

  const acks: Omit<
    DesktopCommandAckEvent,
    "protocolVersion" | "messageId" | "timestamp"
  >[] = [];
  const events: Omit<
    DesktopCommandStreamEvent,
    "protocolVersion" | "messageId" | "timestamp"
  >[] = [];
  const commandId = "0196b1bb-7a00-7000-8000-000000000007";

  executor = createExecutor({
    maxInFlightCommands: 1,
    onAck: (ack) => acks.push(ack),
    onEvent: (event) => events.push(event),
    isCommandSigningEnforced: () => false,
    commandSignatureVerifier: {
      verify: () => ({
        ok: false,
        reason: COMMAND_SIGNING_REJECTION_REASONS.invalidSignature,
      }),
    },
  });
  executor.setConnected(true);
  executor.enqueue({
    ...buildCommand(commandId, { command: "status" }),
    signature: "not-valid",
    signaturePayload: "{",
    publicKeyFingerprint: "cl:unknown",
  });

  await waitFor(() => countDone(events, commandId) === 1);
  assert.equal(acks[0].accepted, true);
  assert.deepEqual(executor.getStats(), { activeCommands: 0, queueDepth: 0 });
});

function createExecutor(options: {
  maxInFlightCommands: number;
  onAck?: (
    event: Omit<
      DesktopCommandAckEvent,
      "protocolVersion" | "messageId" | "timestamp"
    >
  ) => void;
  onEvent: (
    event: Omit<
      DesktopCommandStreamEvent,
      "protocolVersion" | "messageId" | "timestamp"
    >
  ) => void;
  onQueueStatsChange?: (stats: {
    activeCommands: number;
    queueDepth: number;
  }) => void;
  commandSignatureVerifier?: CloudCommandExecutorOptions["commandSignatureVerifier"];
  isCommandSigningEnforced?: CloudCommandExecutorOptions["isCommandSigningEnforced"];
  prepareCommandForExecution?: CloudCommandExecutorOptions["prepareCommandForExecution"];
  gatewayResponseTimeoutMs?: number;
  maxBufferedEventsPerCommand?: number;
}): CloudCommandExecutor {
  return new CloudCommandExecutor({
    getGatewayPort: () => gatewayPort,
    getGatewayAuthToken: () => "test-gateway-token",
    maxInFlightCommands: options.maxInFlightCommands,
    sendCommandAck: options.onAck ?? (() => {}),
    sendCommandEvent: options.onEvent,
    onQueueStatsChange: options.onQueueStatsChange,
    ...(options.gatewayResponseTimeoutMs === undefined
      ? {}
      : { gatewayResponseTimeoutMs: options.gatewayResponseTimeoutMs }),
    ...(options.maxBufferedEventsPerCommand === undefined
      ? {}
      : { maxBufferedEventsPerCommand: options.maxBufferedEventsPerCommand }),
    ...(options.commandSignatureVerifier
      ? { commandSignatureVerifier: options.commandSignatureVerifier }
      : {}),
    ...(options.isCommandSigningEnforced
      ? { isCommandSigningEnforced: options.isCommandSigningEnforced }
      : {}),
    ...(options.prepareCommandForExecution
      ? { prepareCommandForExecution: options.prepareCommandForExecution }
      : {}),
  });
}

function buildCommand(
  commandId: string,
  query: Record<string, string>,
  options?: {
    repoPath?: string;
    timeoutMs?: number | null;
    path?: string;
  }
): DesktopCommandEvent {
  return {
    protocolVersion: "1",
    messageId: `${commandId}-message`,
    timestamp: new Date().toISOString(),
    commandId,
    operationId: "git_action",
    method: "POST",
    path: options?.path ?? "/api/gateway/git",
    query,
    body: {
      action: "status",
      repoPath: options?.repoPath ?? "/repo/default",
    },
    timeoutMs: options?.timeoutMs ?? undefined,
  };
}

function buildCancel(commandId: string, reason: string): DesktopCancelEvent {
  return {
    protocolVersion: "1",
    messageId: `${commandId}-cancel`,
    timestamp: new Date().toISOString(),
    commandId,
    reason,
  };
}

function countDone(
  events: Omit<
    DesktopCommandStreamEvent,
    "protocolVersion" | "messageId" | "timestamp"
  >[],
  commandId: string
): number {
  return events.filter(
    (event) => event.commandId === commandId && event.eventType === "done"
  ).length;
}

async function startGateway(
  handler: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    body: string
  ) => Promise<void>
): Promise<void> {
  gatewayServer = http.createServer((request, response) => {
    void (async () => {
      const body = await readBody(request);
      await handler(request, response, body);
    })().catch((error) => {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          error:
            error instanceof Error
              ? error.message
              : "unknown test server failure",
        })
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    gatewayServer?.listen(0, "127.0.0.1", () => resolve());
    gatewayServer?.once("error", reject);
  });

  const address = gatewayServer.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind test gateway server");
  }
  gatewayPort = address.port;
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await sleep(15);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

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
