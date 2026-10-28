/**
 * ISS-5337 — the OpenCode materialize utilityProcess boundary: the main-process
 * runner (fake fork, no real Electron child), the worker-side pass, and the
 * bounded log buffer between them.
 */

import assert from "node:assert/strict";
import { ImportHealthEvent } from "@closedloop-ai/telemetry-contract/app";
import { test } from "vitest";
import { importHealthEventForMaterializeRejection } from "../src/main/transcript-sync/opencode-materialize-outcome.js";
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
import { fakeOpencodeMaterializeWorkerFork } from "./helpers/opencode-materialize-worker-fixtures.js";

const STATE_DIR = "/state";
const MATERIALIZE_BLEW_UP = /materialize blew up/;
const INVALID_RESPONSE = /invalid response/;
const EXITED_CODE_1 = /exited with code 1/;
const TIMED_OUT = /timed out/;
const FATAL_ERROR = /FatalError at somewhere/;
const WORKER_STOPPED = /worker stopped/;
const FORK_FAILED = /fork failed/;
const POST_MESSAGE_FAILED = /post failed/;

const MATERIALIZED = OpencodeMaterializeWorkerResponseType.Materialized;
const FAILED = OpencodeMaterializeWorkerResponseType.Failed;

function makeRunner(options?: {
  log?: (message: string) => void;
  materializeTimeoutMs?: number;
  postMessageError?: unknown;
}) {
  const { children, forkWorker } = fakeOpencodeMaterializeWorkerFork(
    options?.postMessageError
  );
  const runner = createUtilityProcessOpencodeMaterializeRunner({
    stateDir: STATE_DIR,
    log: options?.log,
    materializeTimeoutMs: options?.materializeTimeoutMs,
    forkWorker,
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

test("runner clears the single-flight latch after a synchronous fork failure", async () => {
  const { children, forkWorker } = fakeOpencodeMaterializeWorkerFork();
  let forkAttempts = 0;
  const runner = createUtilityProcessOpencodeMaterializeRunner({
    stateDir: STATE_DIR,
    forkWorker: (
      modulePath: string,
      args: string[],
      forkOptions: { serviceName: string }
    ): OpencodeMaterializeWorkerProcess => {
      forkAttempts += 1;
      if (forkAttempts === 1) {
        throw new Error("fork failed");
      }
      return forkWorker(modulePath, args, forkOptions);
    },
  });

  await assert.rejects(runner.materialize(), FORK_FAILED);

  const retry = runner.materialize();
  assert.equal(forkAttempts, 2);
  children[0]!.emit("message", { type: MATERIALIZED, logs: [] });
  await retry;
});

test("runner rejects and kills the child when postMessage throws", async () => {
  const { runner, children } = makeRunner({ postMessageError: "post failed" });

  await assert.rejects(runner.materialize(), POST_MESSAGE_FAILED);
  assert.equal(children[0]!.killed, true);
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

/** The value a pass rejected with, so its classification can be asserted. */
async function rejectionOf(pass: Promise<void>): Promise<unknown> {
  try {
    await pass;
  } catch (error) {
    return error;
  }
  throw new Error("expected the materialize pass to reject");
}

test("ISS-8600: a timeout and a worker failure classify differently, and stop() classifies as nothing", async () => {
  const timeoutRunner = makeRunner({ materializeTimeoutMs: 20 });
  assert.equal(
    importHealthEventForMaterializeRejection(
      await rejectionOf(timeoutRunner.runner.materialize())
    ),
    ImportHealthEvent.MaterializeTimedOut,
    "a pass that outran its budget is not the same fleet problem as a broken one"
  );

  const exitRunner = makeRunner();
  const exitPass = exitRunner.runner.materialize();
  exitRunner.children[0]?.emit("exit", 1);
  assert.equal(
    importHealthEventForMaterializeRejection(await rejectionOf(exitPass)),
    ImportHealthEvent.MaterializeFailed
  );

  const errorRunner = makeRunner();
  const errorPass = errorRunner.runner.materialize();
  errorRunner.children[0]?.emit("error", "FatalError", "somewhere", "report");
  assert.equal(
    importHealthEventForMaterializeRejection(await rejectionOf(errorPass)),
    ImportHealthEvent.MaterializeFailed
  );

  const failedRunner = makeRunner();
  const failedPass = failedRunner.runner.materialize();
  failedRunner.children[0]?.emit("message", {
    type: FAILED,
    logs: [],
    message: "materialize blew up",
  });
  assert.equal(
    importHealthEventForMaterializeRejection(await rejectionOf(failedPass)),
    ImportHealthEvent.MaterializeFailed
  );

  // THE ONE THAT CARRIES THIS TICKET. `stopMaterialize` runs on the ISS-4903
  // shutdown path, so a clean quit with a pass in flight settles through the
  // very same rejection path every case above does. A classifier that read the
  // rejection alone -- or matched on its message -- would emit
  // `materialize_failed` on every desktop quit, a fleet-wide false alarm on the
  // exact liveness signal this ticket buys.
  const stopRunner = makeRunner();
  const stopPass = stopRunner.runner.materialize();
  stopRunner.runner.stop();
  assert.equal(
    importHealthEventForMaterializeRejection(await rejectionOf(stopPass)),
    undefined,
    "a deliberate teardown is not a failure and must report nothing"
  );
});

test("ISS-8600: an unreasoned rejection is classified as a failure, not silence", () => {
  // Fail-safe, and not a guess: `stop()` is the only producer of the silent
  // arm and it always constructs a reasoned error, so a bare rejection is a
  // pass that genuinely ended without fresh projections. Defaulting the other
  // way would let any future throw silently mute the signal.
  assert.equal(
    importHealthEventForMaterializeRejection(new Error("something else")),
    ImportHealthEvent.MaterializeFailed
  );
});
