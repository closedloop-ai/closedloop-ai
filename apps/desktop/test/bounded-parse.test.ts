/**
 * @file bounded-parse.test.ts
 * @description ISS-4444 / ISS-4572 unit coverage for the extracted
 * `parseSourceBounded` helper (`src/main/collectors/engine/bounded-parse.ts`), the
 * parse-side sibling of ISS-4410's `importSessionBounded`. The engine integration
 * test (`ingest-parse-watchdog.test.ts`) proves the loop advances end-to-end; these
 * tests pin the helper's own contract in isolation: a settled parse passes its
 * sessions through, a wedged parse (never settles, never throws — the CPU-spin
 * reproduction) resolves to `{ timedOut: true }` after the bound AND fires the
 * abort hook so the worker turn is killed, a genuine throw/rejection is
 * PROPAGATED unchanged (a partially-written mid-turn file is a normal parse error,
 * NOT the wedge this bound guards), and a late settle after either terminal path
 * is ignored. ISS-4572: the deadline arms only when the invoker fires its
 * `onDispatch` signal (at dispatch), not at enqueue — see
 * `ingest-parse-dispatch-deadline.test.ts` for the queue-wait regression. Time is
 * pinned with fake timers — no wall-clock waits.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  HISTORICAL_PARSE_ENQUEUE_CEILING_FACTOR,
  parseSourceBounded,
} from "../src/main/collectors/engine/bounded-parse.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { deferred } from "./deferred.js";
import { makeSession } from "./normalized-session-test-utils.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

const TIMEOUT_MS = 1000;
const HARNESS = "claude";
const SOURCE = "/tmp/poison.jsonl";
const EXCEEDED_LOG_PATTERN = /exceeded 1000ms/;
const NEVER_DISPATCHED_LOG_PATTERN = /enqueue ceiling \(never dispatched\)/;
const PARSE_FAILED_PATTERN = /parse failed/;

beforeEach(() => {
  nodeTestTimers.enable(["setTimeout"]);
});

afterEach(() => {
  nodeTestTimers.reset();
});

test("ISS-4444: passes settled parse sessions straight through", async () => {
  const sessions = [makeSession({ sessionId: "s1" })];
  const logs: string[] = [];
  const outcome = await parseSourceBounded(
    (_source, onDispatch) => {
      onDispatch();
      return Promise.resolve(sessions);
    },
    (m) => logs.push(m),
    HARNESS,
    SOURCE,
    TIMEOUT_MS
  );
  assert.deepEqual(outcome, { timedOut: false, sessions });
  assert.equal(logs.length, 0, "a clean parse logs nothing");
});

test("ISS-4444: a wedged parse resolves to timedOut after the bound and fires the abort hook", async () => {
  const wedged = deferred<NormalizedSession[]>();
  const logs: string[] = [];
  let aborted = 0;
  const pending = parseSourceBounded(
    (_source, onDispatch) => {
      onDispatch();
      return wedged.promise;
    },
    (m) => logs.push(m),
    HARNESS,
    SOURCE,
    TIMEOUT_MS,
    () => {
      aborted += 1;
    }
  );
  // Advance past the bound; the parse never resolves, so the ONLY settle path is
  // the timeout.
  nodeTestTimers.tick(TIMEOUT_MS);
  const outcome = await pending;
  assert.deepEqual(outcome, { timedOut: true });
  assert.equal(aborted, 1, "the worker-turn abort hook fired once on timeout");
  assert.equal(logs.length, 1);
  assert.match(logs[0], EXCEEDED_LOG_PATTERN);
  // A late resolve after the bound must be ignored (no throw, no second settle).
  wedged.resolve([makeSession({ sessionId: "late" })]);
  assert.deepEqual(await pending, { timedOut: true });
});

test("ISS-4444: a genuine async rejection is propagated, not mapped to timedOut", async () => {
  const logs: string[] = [];
  // A partially-written mid-turn transcript is a normal parse error the caller's
  // own try/catch already handles; it must NOT be conflated with the timeout wedge.
  await assert.rejects(
    () =>
      parseSourceBounded(
        (_source, onDispatch) => {
          onDispatch();
          return Promise.reject(new Error("parse failed"));
        },
        (m) => logs.push(m),
        HARNESS,
        SOURCE,
        TIMEOUT_MS
      ),
    PARSE_FAILED_PATTERN
  );
  nodeTestTimers.tick(TIMEOUT_MS * 2);
  assert.equal(logs.length, 0, "a propagated rejection logs no timeout");
});

test("ISS-4444: a synchronous parser throw is propagated and clears the timer", async () => {
  const logs: string[] = [];
  await assert.rejects(
    () =>
      parseSourceBounded(
        (_source, onDispatch) => {
          onDispatch();
          throw new Error("parse failed");
        },
        (m) => logs.push(m),
        HARNESS,
        SOURCE,
        TIMEOUT_MS
      ),
    PARSE_FAILED_PATTERN
  );
  nodeTestTimers.tick(TIMEOUT_MS * 2);
  assert.equal(logs.length, 0, "a propagated sync throw logs no timeout");
});

test("ISS-4444: a resolve within the bound wins over the timer (no abort, no timeout log)", async () => {
  const settled = deferred<NormalizedSession[]>();
  const logs: string[] = [];
  let aborted = 0;
  const pending = parseSourceBounded(
    (_source, onDispatch) => {
      onDispatch();
      return settled.promise;
    },
    (m) => logs.push(m),
    HARNESS,
    SOURCE,
    TIMEOUT_MS,
    () => {
      aborted += 1;
    }
  );
  const sessions = [makeSession({ sessionId: "fast" })];
  settled.resolve(sessions);
  assert.deepEqual(await pending, { timedOut: false, sessions });
  // Advancing past the bound after a clean settle must NOT abort or log.
  nodeTestTimers.tick(TIMEOUT_MS * 2);
  assert.equal(aborted, 0, "no abort on a clean parse");
  assert.equal(logs.length, 0, "cleared timer never logs a timeout");
});

test("ISS-4572: the deadline does not start until dispatch; queue-wait before dispatch is not charged", async () => {
  // Reproduce a source that sits in the serialized dispatch queue: the invoker is
  // called (enqueue) but withholds its `onDispatch` signal until we release it,
  // modelling the wait behind an in-flight (poison) parse. The clock must NOT run
  // during that wait — advancing well past the bound before dispatch must not time
  // it out or fire the abort hook.
  const wedged = deferred<NormalizedSession[]>();
  const dispatch = deferred<void>();
  const logs: string[] = [];
  let aborted = 0;
  const pending = parseSourceBounded(
    (_source, onDispatch) => {
      // Arm the deadline only once the queue releases this source to the worker.
      dispatch.promise.then(onDispatch, () => undefined).catch(() => undefined);
      return wedged.promise;
    },
    (m) => logs.push(m),
    HARNESS,
    SOURCE,
    TIMEOUT_MS,
    () => {
      aborted += 1;
    }
  );
  // Spend far longer than the bound WAITING in the queue (pre-dispatch). Because
  // the deadline is dispatch-scoped, none of this is charged to the source.
  nodeTestTimers.tick(TIMEOUT_MS * 5);
  assert.equal(aborted, 0, "no abort while merely queued (deadline not armed)");
  assert.equal(logs.length, 0, "no spurious timeout logged for queue wait");

  // Now the queue dispatches this source to the worker: the deadline starts HERE.
  dispatch.resolve();
  await dispatch.promise;
  // A tick short of the full bound does not yet time out — the clock started fresh
  // at dispatch, so the earlier queue wait bought this source nothing against it.
  nodeTestTimers.tick(TIMEOUT_MS - 1);
  assert.equal(aborted, 0, "still within the post-dispatch bound");
  assert.equal(logs.length, 0);
  // Crossing the full post-dispatch bound finally times it out.
  nodeTestTimers.tick(1);
  assert.deepEqual(await pending, { timedOut: true });
  assert.equal(aborted, 1, "abort fires exactly once, only after dispatch");
  assert.equal(logs.length, 1);
  assert.match(logs[0], EXCEEDED_LOG_PATTERN);
  wedged.resolve([]);
});

test("ISS-4444: a throwing abort hook does not fail the timeout resolve", async () => {
  const wedged = deferred<NormalizedSession[]>();
  const pending = parseSourceBounded(
    (_source, onDispatch) => {
      onDispatch();
      return wedged.promise;
    },
    () => {},
    HARNESS,
    SOURCE,
    TIMEOUT_MS,
    () => {
      throw new Error("abort blew up");
    }
  );
  nodeTestTimers.tick(TIMEOUT_MS);
  // The best-effort abort threw, but the outcome still resolves to timedOut.
  assert.deepEqual(await pending, { timedOut: true });
  wedged.resolve([]);
});

test("ISS-4572 (wongk / T9): the enqueue ceiling backstops a parse whose onDispatch is NEVER fired", async () => {
  // A (hypothetical/future) runner that accepts `onDispatch` but never calls it
  // would leave the precise dispatch clock unarmed forever. The enqueue-scoped
  // absolute ceiling must still resolve the bound so the boot import advances.
  const wedged = deferred<NormalizedSession[]>();
  const logs: string[] = [];
  let aborted = 0;
  const ceilingMs = TIMEOUT_MS * HISTORICAL_PARSE_ENQUEUE_CEILING_FACTOR;
  const pending = parseSourceBounded(
    // Never invokes onDispatch — the precise deadline is never armed.
    (_source, _onDispatch) => wedged.promise,
    (m) => logs.push(m),
    HARNESS,
    SOURCE,
    TIMEOUT_MS,
    () => {
      aborted += 1;
    }
  );
  // Well past the DISPATCH bound but under the enqueue ceiling: no timeout yet,
  // because the dispatch clock never armed and the ceiling has not elapsed.
  nodeTestTimers.tick(TIMEOUT_MS * 2);
  assert.equal(logs.length, 0, "no dispatch-scoped timeout without dispatch");
  // Crossing the enqueue ceiling trips the backstop.
  nodeTestTimers.tick(ceilingMs - TIMEOUT_MS * 2);
  assert.deepEqual(await pending, { timedOut: true });
  assert.equal(aborted, 1, "the ceiling still aborts the wedged worker turn");
  assert.equal(logs.length, 1);
  assert.match(logs[0], NEVER_DISPATCHED_LOG_PATTERN);
  wedged.resolve([]);
});

test("ISS-4572 (wongk / T9): a normal dispatch clears the enqueue ceiling so queue wait is never charged", async () => {
  // With the ceiling armed, a source that dispatches normally must still only be
  // charged the DISPATCH bound — the ceiling is cleared on dispatch, so a long
  // pre-dispatch queue wait (short of the ceiling) never trips the backstop.
  const wedged = deferred<NormalizedSession[]>();
  const dispatch = deferred<void>();
  const logs: string[] = [];
  const pending = parseSourceBounded(
    (_source, onDispatch) => {
      dispatch.promise.then(onDispatch, () => undefined).catch(() => undefined);
      return wedged.promise;
    },
    (m) => logs.push(m),
    HARNESS,
    SOURCE,
    TIMEOUT_MS
  );
  // Queue-wait shorter than the ceiling, then dispatch: the ceiling is cleared and
  // the precise dispatch clock takes over.
  nodeTestTimers.tick(TIMEOUT_MS * 2);
  dispatch.resolve();
  await dispatch.promise;
  // Only the dispatch bound is charged from here — the earlier wait bought nothing.
  nodeTestTimers.tick(TIMEOUT_MS);
  assert.deepEqual(await pending, { timedOut: true });
  assert.equal(logs.length, 1);
  // Dispatch-scoped message, NOT the never-dispatched ceiling message.
  assert.match(logs[0], EXCEEDED_LOG_PATTERN);
  assert.doesNotMatch(logs[0], NEVER_DISPATCHED_LOG_PATTERN);
  wedged.resolve([]);
});
