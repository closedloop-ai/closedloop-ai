/**
 * ISS-5337 — the OpenCode materialize utilityProcess boundary: the main-process
 * runner (fake fork, no real Electron child), the worker-side pass, and the
 * bounded log buffer between them.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { runOpencodeMaterializePass } from "../src/main/transcript-sync/opencode-materialize-pass.js";
import {
  createBoundedWorkerLogBuffer,
  MAX_WORKER_LOG_LINE_CHARS,
  MAX_WORKER_LOG_LINES,
  OpencodeMaterializeWorkerRequestType,
  OpencodeMaterializeWorkerResponseType,
  opencodeMaterializeWorkerResponseSchema,
  WORKER_INVALID_REQUEST_MESSAGE,
} from "../src/main/transcript-sync/opencode-materialize-worker-protocol.js";
import {
  createUtilityProcessOpencodeMaterializeRunner,
  type OpencodeMaterializeWorkerProcess,
} from "../src/main/transcript-sync/utility-process-opencode-materialize-runner.js";

const STATE_DIR = "/state";
const MATERIALIZE_BLEW_UP = /materialize blew up/;
const INVALID_RESPONSE = /invalid response/;
const EXITED_CODE_1 = /exited with code 1/;
const TIMED_OUT = /timed out/;
const FATAL_ERROR = /FatalError at somewhere/;
const WORKER_STOPPED = /worker stopped/;

const MATERIALIZED = OpencodeMaterializeWorkerResponseType.Materialized;
const FAILED = OpencodeMaterializeWorkerResponseType.Failed;

class FakeUtilityProcess extends EventEmitter {
  readonly messages: Array<{ type: string; stateDir: string }> = [];
  killed = false;
  postMessage(message: { type: string; stateDir: string }): void {
    this.messages.push(message);
  }
  kill(): void {
    this.killed = true;
  }
}

function makeRunner(options?: {
  log?: (message: string) => void;
  materializeTimeoutMs?: number;
}) {
  const children: FakeUtilityProcess[] = [];
  const runner = createUtilityProcessOpencodeMaterializeRunner({
    stateDir: STATE_DIR,
    log: options?.log,
    materializeTimeoutMs: options?.materializeTimeoutMs,
    forkWorker: (): OpencodeMaterializeWorkerProcess => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    },
  });
  return { runner, children };
}

test("runner posts the state dir and resolves on a materialized response", async () => {
  const logs: string[] = [];
  const { runner, children } = makeRunner({ log: (m) => logs.push(m) });

  const promise = runner.materialize();
  const child = children[0]!;
  assert.deepEqual(child.messages, [
    { type: OpencodeMaterializeWorkerRequestType.Run, stateDir: STATE_DIR },
  ]);

  child.emit("message", {
    type: MATERIALIZED,
    logs: ["opencode materialize skipped s1: nope"],
  });
  await promise;

  // The pass's own diagnostics are replayed into the sweep's log sink.
  assert.deepEqual(logs, ["opencode materialize skipped s1: nope"]);
  // The child is reaped as soon as the pass settles — it is forked per pass.
  assert.equal(child.killed, true);
});

test("runner single-flights overlapping passes onto one worker", async () => {
  const { runner, children } = makeRunner();

  const first = runner.materialize();
  const second = runner.materialize();
  assert.equal(children.length, 1, "second pass must not fork a second worker");

  children[0]!.emit("message", { type: MATERIALIZED, logs: [] });
  await Promise.all([first, second]);

  // The latch clears once the pass settles, so the next sweep runs a fresh pass.
  const third = runner.materialize();
  assert.equal(children.length, 2);
  children[1]!.emit("message", { type: MATERIALIZED, logs: [] });
  await third;
});

test("runner rejects on a worker failure response and still replays its logs", async () => {
  const logs: string[] = [];
  const { runner, children } = makeRunner({ log: (m) => logs.push(m) });
  const promise = runner.materialize();
  children[0]!.emit("message", {
    type: FAILED,
    message: "materialize blew up",
    logs: ["partial diagnostic"],
  });
  await assert.rejects(promise, MATERIALIZE_BLEW_UP);
  assert.deepEqual(logs, ["partial diagnostic"]);
});

test("runner rejects and kills the child on an invalid response payload", async () => {
  const logs: string[] = [];
  const { runner, children } = makeRunner({ log: (m) => logs.push(m) });
  const promise = runner.materialize();
  children[0]!.emit("message", { type: MATERIALIZED });
  await assert.rejects(promise, INVALID_RESPONSE);
  assert.equal(children[0]!.killed, true);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, INVALID_RESPONSE);
});

test("runner rejects an over-long log line rather than logging it", async () => {
  const logs: string[] = [];
  const { runner, children } = makeRunner({ log: (m) => logs.push(m) });
  const promise = runner.materialize();
  children[0]!.emit("message", {
    type: MATERIALIZED,
    logs: ["x".repeat(MAX_WORKER_LOG_LINE_CHARS + 1)],
  });
  await assert.rejects(promise, INVALID_RESPONSE);
  // Only the validation diagnostic reaches the sink; the unbounded line does not.
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, INVALID_RESPONSE);
});

test("runner rejects when the worker exits before answering", async () => {
  const { runner, children } = makeRunner();
  const promise = runner.materialize();
  children[0]!.emit("exit", 1);
  await assert.rejects(promise, EXITED_CODE_1);
});

test("runner rejects on a worker fatal error", async () => {
  const { runner, children } = makeRunner();
  const promise = runner.materialize();
  children[0]!.emit("error", "FatalError", "somewhere", "report");
  await assert.rejects(promise, FATAL_ERROR);
});

test("stop() cancels the in-flight pass and kills its worker", async () => {
  const { runner, children } = makeRunner();
  const promise = runner.materialize();

  runner.stop();

  // The sweep awaiting the pass settles immediately (inside the shutdown
  // quiesce budget) instead of parking until the timeout.
  await assert.rejects(promise, WORKER_STOPPED);
  assert.equal(children[0]!.killed, true);

  // A late response from the killed child cannot resurrect the settled pass,
  // and the runner stays reusable for a later start.
  children[0]!.emit("message", { type: MATERIALIZED, logs: [] });
  const next = runner.materialize();
  assert.equal(children.length, 2);
  children[1]!.emit("message", { type: MATERIALIZED, logs: [] });
  await next;
});

test("stop() is a no-op when no pass is in flight", () => {
  const { runner, children } = makeRunner();
  runner.stop();
  assert.equal(children.length, 0);
});

test("runner rejects when the worker outruns the timeout", async () => {
  // A real (short) timer, not fake timers: the runner `unref()`s its timeout, and
  // the assertion is only "this rejects", so a loaded machine can make the test
  // slower but never flaky.
  const { runner, children } = makeRunner({ materializeTimeoutMs: 20 });
  const promise = runner.materialize();
  await assert.rejects(promise, TIMED_OUT);
  assert.equal(children[0]!.killed, true);
});

test("pass returns a materialized response carrying the pass's diagnostics", () => {
  const calls: string[] = [];
  const response = runOpencodeMaterializePass(
    { type: OpencodeMaterializeWorkerRequestType.Run, stateDir: STATE_DIR },
    (stateDir, deps) => {
      calls.push(stateDir);
      deps.log?.("opencode materialize skipped s1: nope");
    }
  );

  assert.deepEqual(calls, [STATE_DIR]);
  assert.deepEqual(response, {
    type: MATERIALIZED,
    logs: ["opencode materialize skipped s1: nope"],
  });
  assert.equal(
    opencodeMaterializeWorkerResponseSchema.safeParse(response).success,
    true
  );
});

test("pass maps a throwing materialize to Failed, keeping partial diagnostics", () => {
  const response = runOpencodeMaterializePass(
    { type: OpencodeMaterializeWorkerRequestType.Run, stateDir: STATE_DIR },
    (_stateDir, deps) => {
      deps.log?.("partial diagnostic");
      throw new Error("materialize blew up");
    }
  );

  assert.deepEqual(response, {
    type: FAILED,
    message: "materialize blew up",
    logs: ["partial diagnostic"],
  });
  assert.equal(
    opencodeMaterializeWorkerResponseSchema.safeParse(response).success,
    true
  );
});

test("pass rejects a malformed request without running materialize", () => {
  let ran = false;
  const response = runOpencodeMaterializePass({ type: "run" }, () => {
    ran = true;
  });

  assert.equal(ran, false);
  assert.deepEqual(response, {
    type: FAILED,
    message: WORKER_INVALID_REQUEST_MESSAGE,
    logs: [],
  });
});

test("pass clips an over-long diagnostic to the schema's per-line bound", () => {
  const response = runOpencodeMaterializePass(
    { type: OpencodeMaterializeWorkerRequestType.Run, stateDir: STATE_DIR },
    (_stateDir, deps) => {
      deps.log?.("y".repeat(MAX_WORKER_LOG_LINE_CHARS * 3));
    }
  );

  assert.equal(response.logs[0]?.length, MAX_WORKER_LOG_LINE_CHARS);
  assert.equal(
    opencodeMaterializeWorkerResponseSchema.safeParse(response).success,
    true
  );
});

test("bounded log buffer reports what it dropped", () => {
  const buffer = createBoundedWorkerLogBuffer();
  for (let index = 0; index < MAX_WORKER_LOG_LINES + 10; index += 1) {
    buffer.push(`line ${index}`);
  }
  const drained = buffer.drain();

  // MAX + 10 pushes, capped at MAX - 1 kept lines, so 11 are accounted for by
  // the notice that takes the last slot.
  assert.equal(drained.length, MAX_WORKER_LOG_LINES);
  assert.equal(
    drained.at(-1),
    "opencode materialize suppressed 11 further log line(s)"
  );
  assert.equal(
    opencodeMaterializeWorkerResponseSchema.safeParse({
      type: MATERIALIZED,
      logs: drained,
    }).success,
    true
  );
});

test("bounded log buffer adds no notice when nothing was dropped", () => {
  const buffer = createBoundedWorkerLogBuffer();
  buffer.push("only line");
  assert.deepEqual(buffer.drain(), ["only line"]);
});
