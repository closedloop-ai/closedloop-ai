/**
 * @file utility-process-historical-parse-runner.test.ts
 * @description Runner-lifecycle coverage split out of
 * `historical-parse-worker-protocol.test.ts`: how
 * `createUtilityProcessHistoricalParseRunner` forks, serializes, drains, times
 * out, restarts, and classifies fatal vs nonfatal worker failures. The protocol
 * suite owns the wire SCHEMA; this suite owns the process that speaks it.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { HistoricalParseWorkerResponseType } from "../src/main/collectors/engine/historical-parse-worker-protocol.js";
import { createUtilityProcessHistoricalParseRunner } from "../src/main/collectors/engine/utility-process-historical-parse-runner.js";
import { Harness } from "../src/main/collectors/types.js";
import {
  INVALID_WORKER_RESPONSE_REQUEST_PATTERN,
  makeSession,
} from "./historical-parse-worker-response-support.js";

const INVALID_WORKER_RESPONSE_PATTERN = /invalid response/;
const WORKER_ERROR_PATTERN = /historical parse worker error/;
const WORKER_TERMINAL_FAILURE_PATTERN = /terminal failure/;
const WORKER_STOPPED_PATTERN = /stopped/;
const WORKER_TIMEOUT_PATTERN = /timed out/;

test("utility parse runner rejects the in-flight parse and kills its child after a malformed response", async () => {
  const children: FakeUtilityProcess[] = [];
  const logs: string[] = [];
  const runner = createUtilityProcessHistoricalParseRunner({
    log: (message) => logs.push(message),
    forkWorker: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    },
  });
  const first = runner.parseSource(Harness.Claude, "/tmp/first.jsonl");
  // ISS-4444: dispatch is serialized — only the in-flight request is posted to
  // the shared child, and it forks on the next microtask tick rather than
  // synchronously, so flush before reading the child.
  const second = runner.parseSource(Harness.Claude, "/tmp/second.jsonl");
  await Promise.resolve();
  await Promise.resolve();
  const child = children[0];

  assert.ok(child);
  assert.equal(child.messages.length, 1);
  const firstMessage = child.messages[0];
  assert.ok(firstMessage);
  child.emit("message", {
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: firstMessage.requestId,
    sessions: [{ sessionId: "missing-required-fields" }],
  });

  await assert.rejects(first, INVALID_WORKER_RESPONSE_PATTERN);
  assert.equal(child.killed, true);

  // The second parse chains after the first settles onto a fresh worker; killing
  // the poisoned child never discarded the healthy queued request.
  await Promise.resolve();
  await Promise.resolve();
  const secondChild = children[1];
  assert.ok(secondChild);
  secondChild.emit("message", {
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: secondChild.messages[0]?.requestId,
    sessions: [makeSession("second-session")],
  });
  assert.deepEqual((await second).sessions, [makeSession("second-session")]);

  assert.equal(
    logs.some((message) =>
      INVALID_WORKER_RESPONSE_REQUEST_PATTERN.test(message)
    ),
    true
  );
  assert.equal(
    logs.some((message) => message.includes(":")),
    true
  );
  assert.equal(
    logs.some((message) => message.includes("missing-required-fields")),
    false
  );
  runner.stop();
});

test("utility parse runner treats worker-side schema failures as nonfatal per-request failures", async () => {
  const children: FakeUtilityProcess[] = [];
  const logs: string[] = [];
  const runner = createUtilityProcessHistoricalParseRunner({
    log: (message) => logs.push(message),
    forkWorker: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    },
  });
  const first = runner.parseSource(Harness.Claude, "/tmp/first.jsonl");
  const second = runner.parseSource(Harness.Claude, "/tmp/second.jsonl");
  // Serialized dispatch forks the worker on the next microtask tick.
  await Promise.resolve();
  await Promise.resolve();
  const child = children[0];

  assert.ok(child);
  child.emit("message", {
    type: HistoricalParseWorkerResponseType.Failed,
    requestId: child.messages[0]?.requestId,
    message:
      "historical parse worker sent an invalid response for historical-parse-1",
    diagnostic: "sessions.0.messages:too_big:too many rows",
  });

  await assert.rejects(first, INVALID_WORKER_RESPONSE_REQUEST_PATTERN);
  assert.equal(child.killed, false);
  // A nonfatal per-request failure leaves the worker alive, so the queued second
  // parse reuses the same child once the first settles.
  await Promise.resolve();
  await Promise.resolve();
  child.emit("message", {
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: child.messages[1]?.requestId,
    sessions: [makeSession("second-session")],
  });
  assert.deepEqual((await second).sessions, [makeSession("second-session")]);
  assert.equal(
    logs.some((message) => message.includes("sessions.0.messages:too_big")),
    true
  );
  runner.stop();
});

test("utility parse runner treats explicit fatal failures as worker-terminal", async () => {
  const children: FakeUtilityProcess[] = [];
  const logs: string[] = [];
  const runner = createUtilityProcessHistoricalParseRunner({
    log: (message) => logs.push(message),
    forkWorker: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    },
  });
  const first = runner.parseSource(Harness.Claude, "/tmp/first.jsonl");
  const second = runner.parseSource(Harness.Claude, "/tmp/second.jsonl");
  // Serialized dispatch forks the worker on the next microtask tick.
  await Promise.resolve();
  await Promise.resolve();
  const child = children[0];

  assert.ok(child);
  child.emit("message", {
    type: HistoricalParseWorkerResponseType.Failed,
    requestId: child.messages[0]?.requestId,
    message: "historical parse worker terminal failure",
    fatal: true,
    diagnostic: "utility process corrupted",
  });

  await assert.rejects(first, WORKER_TERMINAL_FAILURE_PATTERN);
  assert.equal(child.killed, true);
  assert.equal(
    logs.some((message) => message.includes("utility process corrupted")),
    true
  );

  // The queued second parse recovers on a fresh worker; the fatal kill of the
  // in-flight child never discarded the healthy queued request.
  await Promise.resolve();
  await Promise.resolve();
  const secondChild = children[1];
  assert.ok(secondChild);
  secondChild.emit("message", {
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: secondChild.messages[0]?.requestId,
    sessions: [makeSession("second-session")],
  });
  assert.deepEqual((await second).sessions, [makeSession("second-session")]);
  runner.stop();
});

test("utility parse runner drains posted responses before rejecting clean worker exit", async () => {
  const children: FakeUtilityProcess[] = [];
  const runner = createUtilityProcessHistoricalParseRunner({
    log: () => {},
    forkWorker: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    },
  });
  const pending = runner.parseSource(Harness.Claude, "/tmp/source.jsonl");
  // Serialized dispatch forks the worker on the next microtask tick.
  await Promise.resolve();
  await Promise.resolve();
  const child = children[0];

  assert.ok(child);
  child.emit("exit", 0);
  child.emit("message", {
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: child.messages[0]?.requestId,
    sessions: [makeSession("exit-race-session")],
  });
  await nextImmediate();

  assert.deepEqual((await pending).sessions, [
    makeSession("exit-race-session"),
  ]);
  runner.stop();
});

test("utility parse runner forks worker with stderr piped", async () => {
  // Collected, not reassigned: CFA cannot see the fork callback's assignment.
  const forkOptions: { stdio: string[] }[] = [];
  const runner = createUtilityProcessHistoricalParseRunner({
    log: () => {},
    forkWorker: (_modulePath, _args, options) => {
      forkOptions.push(options);
      return new FakeUtilityProcess();
    },
  });

  const pending = runner.parseSource(Harness.Claude, "/tmp/source.jsonl");
  // Serialized dispatch forks the worker on the next microtask tick, so let the
  // dispatch land (recording forkOptions and registering the pending parse)
  // before stopping the runner.
  await Promise.resolve();
  await Promise.resolve();
  runner.stop();
  await assert.rejects(pending, WORKER_STOPPED_PATTERN);

  assert.deepEqual(forkOptions[0]?.stdio, ["ignore", "ignore", "pipe"]);
});

test("utility parse runner rejects pending parses on worker error", async () => {
  const children: FakeUtilityProcess[] = [];
  const runner = createUtilityProcessHistoricalParseRunner({
    log: () => {},
    forkWorker: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    },
  });
  const pending = runner.parseSource(Harness.Claude, "/tmp/source.jsonl");
  // Serialized dispatch forks the worker on the next microtask tick.
  await Promise.resolve();
  await Promise.resolve();
  const child = children[0];

  assert.ok(child);
  child.emit("error", "FatalError", "utility-worker");

  await assert.rejects(pending, WORKER_ERROR_PATTERN);
  assert.equal(child.killed, true);
  runner.stop();
});

test("utility parse runner rejects silent workers after the parse timeout", async () => {
  const keepAlive = setInterval(() => {}, 10);
  const children: FakeUtilityProcess[] = [];
  const runner = createUtilityProcessHistoricalParseRunner({
    log: () => {},
    parseTimeoutMs: 1,
    forkWorker: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    },
  });
  const pending = runner.parseSource(Harness.Claude, "/tmp/source.jsonl");

  try {
    await assert.rejects(pending, WORKER_TIMEOUT_PATTERN);
    assert.equal(children[0]?.killed, true);
  } finally {
    clearInterval(keepAlive);
    runner.stop();
  }
});

test("utility parse runner ignores stale child messages after restart", async () => {
  const children: FakeUtilityProcess[] = [];
  const runner = createUtilityProcessHistoricalParseRunner({
    log: () => {},
    forkWorker: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    },
  });
  const first = runner.parseSource(Harness.Claude, "/tmp/first.jsonl");
  // Serialized dispatch forks the worker on the next microtask tick.
  await Promise.resolve();
  await Promise.resolve();
  const firstChild = children[0];
  assert.ok(firstChild);
  firstChild.emit("message", {
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: firstChild.messages[0]?.requestId,
    sessions: [{ sessionId: "missing-required-fields" }],
  });
  await assert.rejects(first, INVALID_WORKER_RESPONSE_PATTERN);

  const second = runner.parseSource(Harness.Claude, "/tmp/second.jsonl");
  // The restarted worker forks on the next microtask tick as well.
  await Promise.resolve();
  await Promise.resolve();
  const secondChild = children[1];
  assert.ok(secondChild);
  firstChild.emit("message", {
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "stale-message",
    sessions: [{ sessionId: "missing-required-fields" }],
  });
  assert.equal(secondChild.killed, false);
  secondChild.emit("message", {
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: secondChild.messages[0]?.requestId,
    sessions: [makeSession("second-session")],
  });

  assert.deepEqual((await second).sessions, [makeSession("second-session")]);
  runner.stop();
});

class FakeUtilityProcess extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly messages: Array<{ requestId: string }> = [];
  killed = false;

  postMessage(message: { requestId: string }): void {
    this.messages.push(message);
  }

  kill(): void {
    this.killed = true;
    this.emit("exit", 0);
  }
}

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
