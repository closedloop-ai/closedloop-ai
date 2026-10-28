/**
 * @file db-host-restart-ceiling.test.ts
 * @description ISS-8776 — the db-host restart ladder must have a CEILING and a
 * terminal state, and a healthy restart must still cost nothing.
 *
 * The failure this pins: `DbHostClient` re-forked forever. FEA-3072 escalates
 * the DELAY between attempts, which is not a bound — the observed crash log
 * showed `db-host exited unexpectedly (code: 0)` immediately followed by
 * `db-host restart failed, retrying: db-host exited (code: 0)`, repeating until
 * the app died. Worse, the spawn-failure retry re-armed WITHOUT registering a
 * crash, so it looped at whatever delay the last real crash had computed rather
 * than escalating at all.
 *
 * The vacuous-pass risk here is real and is designed against: "it stops
 * looping" passes trivially if nothing ever started it. Every case below counts
 * the forks the REAL ladder performed, so a ceiling that engaged because the
 * ladder never armed would fail the fork-count assertion first.
 *
 * Timers are driven with the shared fake-timer helper — no wall-clock waits,
 * per the desktop test:node determinism rules.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { DbHostClient } from "../src/main/database/db-host/db-host-client.js";
import {
  DbHostRequestKind,
  DbHostResponseKind,
} from "../src/main/database/db-host/db-host-protocol.js";
import { MAX_DB_HOST_RESTART_ATTEMPTS } from "../src/main/database/db-host/db-host-restart-budget.js";
import type { DbHostExitDiagnostics } from "../src/main/telemetry/telemetry-protocol.js";
import { isRecoverableDbHostExitError } from "../src/shared/db-host-exit-error.js";
import type {
  DbHostChildExitListener,
  DbHostChildListenerArgs,
  DbHostChildMessageListener,
} from "./db-host-fake-child-support.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

/** Microtask hops drained between synchronous steps. */
const MICROTASK_DRAIN_TURNS = 50;
/**
 * Far past every delay the ladder can compute (its own cap is 30 s), so a fork
 * that does not happen inside this window is one that never happens.
 *
 * Pinned as an independent literal rather than derived from the backoff
 * constants: a window computed FROM the thing under test cannot fail when that
 * thing is wrong.
 */
const LADDER_SETTLE_MS = 900_000;
/** The ceiling this suite asserts, stated independently of the module's own constant. */
const EXPECTED_CEILING = 8;
/** The terminal log line, matched on its distinguishing clause. */
const EXHAUSTED_LOG_RE = /restart ladder exhausted after \d+ attempt\(s\)/;
/** The terminal rejection names the op and the fact that nothing is coming back. */
const UNAVAILABLE_RE =
  /db-host is unavailable after \d+ failed restart attempts/;

/**
 * A fake forked db-host child that captures the client's listeners, so a test
 * can deliver `Ready` and `exit` on demand.
 */
function makeFakeChild() {
  const posted: { kind: string; id?: number }[] = [];
  let exitListener: DbHostChildExitListener | undefined;
  let messageListener: DbHostChildMessageListener | undefined;
  const child = {
    stderr: null,
    on(...args: DbHostChildListenerArgs): unknown {
      if (args[0] === "exit") {
        exitListener = args[1];
      } else {
        messageListener = args[1];
      }
      return child;
    },
    postMessage(message: { kind: string; id?: number }) {
      posted.push(message);
    },
    kill() {
      // no-op for the fake
    },
  };
  return {
    child,
    posted,
    exit(code: number | null) {
      exitListener?.(code);
    },
    ready() {
      const initId = posted.find((m) => m.kind === DbHostRequestKind.Init)?.id;
      messageListener?.({ kind: DbHostResponseKind.Ready, id: initId });
    },
  };
}

async function drainMicrotasks(): Promise<void> {
  for (let turn = 0; turn < MICROTASK_DRAIN_TURNS; turn++) {
    await Promise.resolve();
  }
}

/**
 * A child that forks cleanly and then EXITS before it can answer Init — the
 * exact shape of the observed incident, where `app.exit()` was already tearing
 * the process down so every replacement died on arrival with code 0.
 *
 * Deliberately not a `fork` that throws. That is a real production path — an
 * EMFILE under a crash storm — but it reaches the ladder's spawn-failure branch
 * by its own route, so ISS-9013 covers it in
 * `db-host-restart-fork-throw.test.ts` rather than folding it in here, where it
 * would no longer be the observed incident's shape.
 */
function makeStillbornChild(exitCode: number) {
  const stillborn = makeFakeChild();
  const realPost = stillborn.child.postMessage.bind(stillborn.child);
  stillborn.child.postMessage = (message: { kind: string; id?: number }) => {
    realPost(message);
    if (message.kind === DbHostRequestKind.Init) {
      stillborn.exit(exitCode);
    }
  };
  return stillborn;
}

/**
 * Build a client whose first child is healthy and whose every replacement is
 * stillborn, so the ladder is driven purely by its spawn-failure retry — the
 * path the incident actually looped on.
 */
function makeAlwaysFailingLadder() {
  const first = makeFakeChild();
  const logs: string[] = [];
  const exhausted: DbHostExitDiagnostics[] = [];
  let forkCount = 0;
  const client = new DbHostClient({
    onEmit: () => {
      // no-op
    },
    onLog: (message) => logs.push(message),
    onRestartExhausted: (event) => exhausted.push(event),
    fork: () => {
      forkCount += 1;
      return forkCount === 1 ? first.child : makeStillbornChild(1).child;
    },
  });
  return { client, first, logs, exhausted, forkCount: () => forkCount };
}

test("the restart ladder stops at its ceiling instead of re-forking forever", async () => {
  nodeTestTimers.enable(["setTimeout"]);
  try {
    const ladder = makeAlwaysFailingLadder();
    const started = ladder.client.start({ dataDir: "/tmp/db" });
    ladder.first.ready();
    await started;
    assert.equal(ladder.forkCount(), 1, "the first child forked");

    // The live child dies unexpectedly. Every replacement then forks cleanly
    // and dies during Init, so the ladder is driven purely by its spawn-failure
    // retry — the path the incident actually looped on.
    ladder.first.exit(1);
    for (let round = 0; round < EXPECTED_CEILING * 3; round++) {
      nodeTestTimers.tick(LADDER_SETTLE_MS);
      await drainMicrotasks();
    }

    // 1 healthy fork + exactly the ceiling's worth of attempts, and not one
    // more no matter how much longer the clock runs.
    assert.equal(
      ladder.forkCount(),
      1 + EXPECTED_CEILING,
      "the ladder armed exactly the ceiling's worth of restart attempts"
    );
    assert.equal(
      MAX_DB_HOST_RESTART_ATTEMPTS,
      EXPECTED_CEILING,
      "the shipped ceiling is the one this suite was written against"
    );
    assert.ok(
      ladder.logs.some((line) => EXHAUSTED_LOG_RE.test(line)),
      `the ladder reported giving up; saw: ${ladder.logs.join(" | ")}`
    );
  } finally {
    nodeTestTimers.reset();
  }
});

test("exhaustion raises the monitored terminal event exactly once", async () => {
  nodeTestTimers.enable(["setTimeout"]);
  try {
    const ladder = makeAlwaysFailingLadder();
    const started = ladder.client.start({ dataDir: "/tmp/db" });
    ladder.first.ready();
    await started;
    ladder.first.exit(1);
    for (let round = 0; round < EXPECTED_CEILING * 3; round++) {
      nodeTestTimers.tick(LADDER_SETTLE_MS);
      await drainMicrotasks();
    }

    assert.equal(
      ladder.exhausted.length,
      1,
      "the terminal state is reported once, not once per later tick"
    );
    assert.equal(
      ladder.exhausted[0].exitCode,
      1,
      "the terminal event carries the code the host last died with"
    );
    // The severity signal. `crashesInWindow` counts crashes inside the 60s
    // FEA-3072 window, which is SHORTER than the ladder it would be describing,
    // so it under-reports the terminal case — and reads 0 outright on a run
    // driven purely by spawn failures. A triage read that took it as "how many
    // attempts failed" would rank the worst db-host state as the mildest.
    assert.equal(
      ladder.exhausted[0].restartAttempts,
      EXPECTED_CEILING,
      "the terminal event reports how many attempts were actually made"
    );
  } finally {
    nodeTestTimers.reset();
  }
});

test("a call made after exhaustion rejects as NOT recoverable", async () => {
  nodeTestTimers.enable(["setTimeout"]);
  try {
    const ladder = makeAlwaysFailingLadder();
    const started = ladder.client.start({ dataDir: "/tmp/db" });
    ladder.first.ready();
    await started;
    ladder.first.exit(1);
    for (let round = 0; round < EXPECTED_CEILING * 3; round++) {
      nodeTestTimers.tick(LADDER_SETTLE_MS);
      await drainMicrotasks();
    }

    const rejection = await ladder.client.invoke("sessions.count", []).then(
      () => null,
      (error: unknown) => error
    );
    assert.ok(rejection instanceof Error, "the call rejected");
    assert.match(rejection.message, UNAVAILABLE_RE);
    // The whole point of the terminal state: a consumer gating its re-drive on
    // `restartScheduled` must stop. Before the ceiling existed the ladder kept
    // asserting a replacement was coming, forever.
    assert.equal(
      isRecoverableDbHostExitError(rejection),
      false,
      "the terminal rejection must not claim a replacement is coming"
    );
  } finally {
    nodeTestTimers.reset();
  }
});

test("a call queued when the ladder gives up rejects instead of hanging", async () => {
  nodeTestTimers.enable(["setTimeout"]);
  try {
    const ladder = makeAlwaysFailingLadder();
    const started = ladder.client.start({ dataDir: "/tmp/db" });
    ladder.first.ready();
    await started;
    ladder.first.exit(1);

    // Issued while the ladder is still trying, so it parks on `ready` — the
    // promise exhaustion removes the only resolver for.
    let settled: unknown = "pending";
    ladder.client.invoke("sessions.count", []).then(
      (value) => {
        settled = value;
      },
      (error: unknown) => {
        settled = error;
      }
    );

    for (let round = 0; round < EXPECTED_CEILING * 3; round++) {
      nodeTestTimers.tick(LADDER_SETTLE_MS);
      await drainMicrotasks();
    }

    assert.ok(
      settled instanceof Error,
      "the queued call settled rather than hanging on a promise nothing re-arms"
    );
    assert.equal(isRecoverableDbHostExitError(settled), false);
  } finally {
    nodeTestTimers.reset();
  }
});

test("a healthy restart resets the tally, so the ceiling is per-run", async () => {
  nodeTestTimers.enable(["setTimeout"]);
  try {
    // Every fork succeeds. The child bounces far MORE times than the ceiling;
    // because each replacement actually comes up, the ladder must never give
    // up — a cap counted per process rather than per run of failures would
    // strand a perfectly healthy app.
    const children = Array.from(
      { length: EXPECTED_CEILING * 2 + 2 },
      makeFakeChild
    );
    const logs: string[] = [];
    let forkCount = 0;
    const client = new DbHostClient({
      onEmit: () => {
        // no-op
      },
      onLog: (message) => logs.push(message),
      fork: () => children[Math.min(forkCount++, children.length - 1)].child,
    });

    const started = client.start({ dataDir: "/tmp/db" });
    children[0].ready();
    await started;

    for (let bounce = 1; bounce <= EXPECTED_CEILING * 2; bounce++) {
      children[bounce - 1].exit(1);
      nodeTestTimers.tick(LADDER_SETTLE_MS);
      await drainMicrotasks();
      children[bounce].ready();
      await drainMicrotasks();
    }

    assert.equal(
      forkCount,
      EXPECTED_CEILING * 2 + 1,
      "every bounce was still re-forked"
    );
    assert.ok(
      !logs.some((line) => EXHAUSTED_LOG_RE.test(line)),
      `a recovering host must never exhaust the ladder; saw: ${logs.join(" | ")}`
    );

    // And it is still usable: the tally reset is only meaningful if the client
    // actually serves work afterwards.
    const live = children[EXPECTED_CEILING * 2];
    // Deliberately unawaited: the assertion is that the call REACHED the child,
    // which happens on post, not on reply. Its rejection is impossible here (the
    // child is live), and the `.catch` keeps the runner honest anyway.
    client.invoke("sessions.count", []).catch(() => undefined);
    await drainMicrotasks();
    assert.ok(
      live.posted.some((m) => m.kind === DbHostRequestKind.Invoke),
      "the healed client still forwards calls to its live child"
    );
  } finally {
    nodeTestTimers.reset();
  }
});
