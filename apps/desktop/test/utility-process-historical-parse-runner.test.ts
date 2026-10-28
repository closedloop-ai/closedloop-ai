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
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { HistoricalParseWorkerResponseType } from "../src/main/collectors/engine/historical-parse-worker-protocol.js";
import { createUtilityProcessHistoricalParseRunner } from "../src/main/collectors/engine/utility-process-historical-parse-runner.js";
import { Harness } from "../src/main/collectors/types.js";
import { Observability } from "../src/main/telemetry/observability.js";
import { CollectorRecordsDroppedReason } from "../src/main/telemetry/telemetry-protocol.js";
import type { EnrichedTelemetryEvent } from "../src/main/telemetry/telemetry-service.js";
import {
  INVALID_WORKER_RESPONSE_REQUEST_PATTERN,
  makeSession,
} from "./historical-parse-worker-response-support.js";

const INVALID_WORKER_RESPONSE_PATTERN = /invalid response/;
const WORKER_ERROR_PATTERN = /historical parse worker error/;
const WORKER_TERMINAL_FAILURE_PATTERN = /terminal failure/;
const WORKER_STOPPED_PATTERN = /stopped/;
const WORKER_EXITED_PATTERN = /exited with code/;
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

/**
 * ISS-7534: the clamp runs in the utility process, which has no telemetry
 * transport — so a truncated `tokenSeries` reaches the monitored path only if
 * the runner emits it here, in the main process where `Observability.init` ran.
 * Without this the truncation would be a field nobody is alerted on.
 */
test("a truncated tokenSeries reaches the monitored drop path, and a whole one does not", async () => {
  const telemetry: EnrichedTelemetryEvent[] = [];
  Observability.init({ telemetrySend: (event) => telemetry.push(event) });
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

  const truncated = runner.parseSource(Harness.Claude, "/tmp/truncated.jsonl");
  await Promise.resolve();
  await Promise.resolve();
  const child = children[0];
  assert.ok(child);
  child.emit("message", {
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: child.messages[0]?.requestId,
    sessions: [
      {
        ...makeSession("truncated-a"),
        tokenSeriesTruncation: {
          droppedRecords: 4,
          droppedTokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
        },
      },
      {
        ...makeSession("truncated-b"),
        tokenSeriesTruncation: {
          droppedRecords: 6,
          droppedTokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
        },
      },
    ],
  });
  await truncated;

  const drops = telemetry.filter(
    (event) => event.diagnostics?.collectorRecordsDropped !== undefined
  );
  assert.equal(
    drops.length,
    1,
    "one event per response, never one per session"
  );
  assert.deepEqual(drops[0]?.diagnostics?.collectorRecordsDropped, {
    reason: CollectorRecordsDroppedReason.TokenSeriesResponseBudget,
    count: 10,
  });
  assert.equal(
    logs.some((message) => message.includes("truncated-a")),
    true,
    "the session ids stay in the LOCAL log, where an operator can act on them"
  );

  // The negative's positive sibling: an untruncated response stays silent, so
  // the alert cannot fire on every healthy parse.
  const whole = runner.parseSource(Harness.Claude, "/tmp/whole.jsonl");
  await Promise.resolve();
  await Promise.resolve();
  const wholeChild = children.at(-1);
  assert.ok(wholeChild);
  wholeChild.emit("message", {
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: wholeChild.messages.at(-1)?.requestId,
    sessions: [makeSession("whole")],
  });
  await whole;

  assert.equal(
    telemetry.filter(
      (event) => event.diagnostics?.collectorRecordsDropped !== undefined
    ).length,
    1,
    "no second drop event — nothing was dropped"
  );
  runner.stop();
});

/**
 * ISS-5854: a dropped SESSION leaves no row anywhere — unlike a truncated field,
 * which at least rides back on the session that carries it. The response
 * envelope and this emit are the only places its absence is stated, so a missing
 * emit here makes the loss invisible outside one local log line.
 */
test("dropped whole sessions reach the monitored path, and a complete parse stays silent", async () => {
  const telemetry: EnrichedTelemetryEvent[] = [];
  Observability.init({ telemetrySend: (event) => telemetry.push(event) });
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

  const partial = runner.parseSource(Harness.Claude, "/tmp/partial.jsonl");
  await Promise.resolve();
  await Promise.resolve();
  const child = children[0];
  assert.ok(child);
  child.emit("message", {
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: child.messages[0]?.requestId,
    sessions: [makeSession("delivered")],
    droppedSessions: 42,
  });
  const partialResult = await partial;

  const drops = telemetry.filter(
    (event) =>
      event.diagnostics?.collectorRecordsDropped?.reason ===
      CollectorRecordsDroppedReason.SessionResponseBudget
  );
  assert.equal(drops.length, 1);
  assert.deepEqual(drops[0]?.diagnostics?.collectorRecordsDropped, {
    reason: CollectorRecordsDroppedReason.SessionResponseBudget,
    count: 42,
  });
  // The count must also reach the IMPORT decision, not just the operator —
  // without it the manager seals this source as fully imported and the dropped
  // tail is never re-read.
  assert.equal(partialResult.droppedSessions, 42);
  assert.equal(
    logs.some((message) => message.includes("/tmp/partial.jsonl")),
    true,
    "the local log must name WHICH source under-imported"
  );

  // The positive sibling: a complete parse omits the field and must stay silent.
  const whole = runner.parseSource(Harness.Claude, "/tmp/whole.jsonl");
  await Promise.resolve();
  await Promise.resolve();
  const wholeChild = children.at(-1);
  assert.ok(wholeChild);
  wholeChild.emit("message", {
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: wholeChild.messages.at(-1)?.requestId,
    sessions: [makeSession("whole")],
  });
  const wholeResult = await whole;

  assert.equal(wholeResult.droppedSessions, undefined);
  assert.equal(
    telemetry.filter(
      (event) =>
        event.diagnostics?.collectorRecordsDropped?.reason ===
        CollectorRecordsDroppedReason.SessionResponseBudget
    ).length,
    1,
    "no second event — nothing was dropped"
  );
  runner.stop();
});

/**
 * ISS-7625: the runner's own copy-out of the unreadable-parse quality.
 *
 * An all-malformed source parses to ZERO sessions in the worker, so there is no
 * session row to carry the quality back — the response envelope and this copy
 * are the only path it has to the main process, and the historical path is
 * where production does this parsing. The wire schema round-trip is covered in
 * `unreadable-parse-ingest-failure.test.ts`, but that suite stubs
 * `HistoricalParseRunner`, so it stays green with this copy deleted while every
 * historical import silently drops the field. This is the boundary assertion
 * `droppedSessions` already has.
 */
test("an unreadable parse's quality crosses the runner boundary, and a readable one omits it", async () => {
  const children: FakeUtilityProcess[] = [];
  const runner = createUtilityProcessHistoricalParseRunner({
    log: () => undefined,
    forkWorker: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    },
  });

  const quality = {
    totalLines: 12,
    malformedLines: 12,
    truncatedFinalLine: false,
  };
  const unreadable = runner.parseSource(
    Harness.Claude,
    "/tmp/unreadable.jsonl"
  );
  await Promise.resolve();
  await Promise.resolve();
  const child = children[0];
  assert.ok(child);
  child.emit("message", {
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: child.messages[0]?.requestId,
    sessions: [],
    unreadableParseQuality: quality,
  });
  const unreadableResult = await unreadable;

  assert.deepEqual(
    unreadableResult.unreadableParseQuality,
    quality,
    "the whole record must reach the main process — a dropped field is an all-malformed source arriving as a healthy empty parse"
  );

  // The positive sibling: a parse that produced a session reports no quality,
  // and the field must stay ABSENT rather than arrive as an empty record.
  const readable = runner.parseSource(Harness.Claude, "/tmp/readable.jsonl");
  await Promise.resolve();
  await Promise.resolve();
  const readableChild = children.at(-1);
  assert.ok(readableChild);
  readableChild.emit("message", {
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: readableChild.messages.at(-1)?.requestId,
    sessions: [makeSession("readable")],
  });
  const readableResult = await readable;

  assert.equal(readableResult.unreadableParseQuality, undefined);
  runner.stop();
});

/**
 * ISS-6898 (review of PR #6476). Worker stderr is summarized on LINE boundaries
 * so a credential straddling two `data` events cannot reach the log as two
 * halves. That deferral needs a release, and the two tests below pin the two
 * ways it can go wrong: released too EARLY it recreates the split it exists to
 * close, and released never it loses the line that says why the worker died.
 */
function makeStderrRunner(): {
  children: FakeUtilityProcess[];
  logs: string[];
  runner: ReturnType<typeof createUtilityProcessHistoricalParseRunner>;
} {
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
  return { children, logs, runner };
}

test("utility parse runner does not split the stderr carry across the worker's exit", async () => {
  // The exit-edge flush is deferred a turn so bytes already queued for the
  // stream land in the carry first. Fire it inline and the carry goes out as one
  // record and its continuation as another, which reconstructs the credential
  // between them.
  const { children, logs, runner } = makeStderrRunner();
  const pending = runner.parseSource(Harness.Claude, "/tmp/source.jsonl");
  const rejection = assert.rejects(pending, WORKER_EXITED_PATTERN);
  await Promise.resolve();
  await Promise.resolve();
  const child = children[0];
  assert.ok(child);

  child.stderr.emit(
    "data",
    Buffer.from("worker died: unexpected token AKIASYN")
  );
  child.kill();
  // Bytes still queued behind the exit that preceded them.
  child.stderr.emit("data", Buffer.from("THETIC0000000"));
  await nextImmediate();

  const stderrLogs = logs.filter((line) => line.includes("worker stderr"));
  assert.equal(
    stderrLogs.length,
    1,
    "the carry was logged separately from its continuation, which reconstructs the credential"
  );
  assert.equal(
    stderrLogs.join(" ").includes("AKIASYNTHETIC0000000"),
    false,
    "the credential straddling the worker's exit reached the log"
  );
  assert.equal(
    stderrLogs.join(" ").includes("AKIASYN"),
    false,
    "the credential's leading half reached the log on its own"
  );
  assert.ok(stderrLogs.join(" ").includes("worker died"));
  await rejection;
  runner.stop();
});

test("utility parse runner still flushes the stderr carry when the stream is torn down with the worker", async () => {
  // Electron's `ForkUtilityProcess` calls `stderr.removeAllListeners()` and
  // drops the stream in the same turn it emits `exit`, so nothing wired to the
  // stream's own `end`/`close` is ever called. `exit` is the only edge left, and
  // without it the worker's last line — the one saying why it died — is lost.
  const { children, logs, runner } = makeStderrRunner();
  const pending = runner.parseSource(Harness.Claude, "/tmp/source.jsonl");
  const rejection = assert.rejects(pending, WORKER_EXITED_PATTERN);
  await Promise.resolve();
  await Promise.resolve();
  const child = children[0];
  assert.ok(child);

  child.stderr.emit(
    "data",
    Buffer.from("worker died: unexpected end of JSON input")
  );
  assert.equal(
    logs.some((line) => line.includes("worker stderr")),
    false,
    "an unterminated line was logged before anything said the stream was over"
  );

  child.kill();
  child.stderr.removeAllListeners();
  await nextImmediate();

  assert.ok(
    logs.some((line) => line.includes("unexpected end of JSON input")),
    "the worker's last stderr line was dropped with the stream"
  );
  await rejection;
  runner.stop();
});

describe("utility parse runner idle teardown", () => {
  const IDLE_MS = 1000;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function idleRunner(children: FakeUtilityProcess[]) {
    return createUtilityProcessHistoricalParseRunner({
      idleTeardownMs: IDLE_MS,
      forkWorker: () => {
        const child = new FakeUtilityProcess();
        children.push(child);
        return child;
      },
    });
  }

  async function parseOnce(
    runner: ReturnType<typeof idleRunner>,
    children: FakeUtilityProcess[],
    sessionId: string
  ): Promise<FakeUtilityProcess> {
    const parse = runner.parseSource(Harness.Claude, `/tmp/${sessionId}.jsonl`);
    await Promise.resolve();
    await Promise.resolve();
    const child = children.at(-1);
    if (!child) {
      throw new Error("expected the parse to fork a worker");
    }
    child.emit("message", {
      type: HistoricalParseWorkerResponseType.Parsed,
      requestId: child.messages.at(-1)?.requestId,
      sessions: [makeSession(sessionId)],
    });
    await parse;
    await Promise.resolve();
    return child;
  }

  test("kills the worker once it has been idle for the idle delay, then respawns it on the next parse", async () => {
    const children: FakeUtilityProcess[] = [];
    const runner = idleRunner(children);
    const first = await parseOnce(runner, children, "first");

    vi.advanceTimersByTime(IDLE_MS - 1);
    assert.equal(first.killed, false);
    vi.advanceTimersByTime(1);
    assert.equal(first.killed, true);

    const second = await parseOnce(runner, children, "second");
    assert.equal(children.length, 2);
    assert.notEqual(second, first);
    runner.stop();
  });

  test("a parse dispatched inside the idle window keeps the same worker alive", async () => {
    const children: FakeUtilityProcess[] = [];
    const runner = idleRunner(children);
    const first = await parseOnce(runner, children, "first");

    vi.advanceTimersByTime(IDLE_MS - 1);
    const again = await parseOnce(runner, children, "second");
    assert.equal(again, first);
    vi.advanceTimersByTime(IDLE_MS - 1);
    assert.equal(first.killed, false);
    assert.equal(children.length, 1);
    runner.stop();
  });

  test("stop cancels the idle countdown", async () => {
    const children: FakeUtilityProcess[] = [];
    const runner = idleRunner(children);
    await parseOnce(runner, children, "first");
    runner.stop();
    assert.equal(vi.getTimerCount(), 0);
  });
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
