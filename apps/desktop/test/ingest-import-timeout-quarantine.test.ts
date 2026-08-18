/**
 * @file ingest-import-timeout-quarantine.test.ts
 * @description ISS-6115 regression: a source whose historical IMPORT keeps
 * exceeding `HISTORICAL_IMPORT_SESSION_TIMEOUT_MS` must stop being re-attempted
 * at full cost.
 *
 * ISS-4410 bounds the import and ISS-4476 isolates the failure by leaving the
 * source UNMARKED so it retries. With no attempt budget on that path, "retries"
 * meant forever: a single poison source burned the whole bound on every boot AND
 * on every catch-up pass (`CATCHUP_POLL_MS`, one minute), measured as 8 days of
 * `codex 0/2465` with the timeout rate climbing from 2/day to 39/day.
 * `main/sync/AGENTS.md` invariant 5 — "unbounded retry is never acceptable,
 * every terminal path must be reachable" — is what that violates.
 *
 * The budget is ISS-4444's existing per-source quarantine store, charged by the
 * import bound as well as by a wedging parse, and spent per PASS rather than per
 * launch. These tests assert the BEHAVIOUR through the manager — the source stops
 * being attempted, the count the FTUE caveat reads goes up, a rejection is not
 * charged, a pass that burned no deadline clears the tally, a batch store is
 * exempt, and a changed file is re-admitted — rather than scanning source text.
 */
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { importSessionBounded } from "../src/main/collectors/engine/bounded-import-session.js";
import { CollectorManager } from "../src/main/collectors/engine/collector-manager.js";
import { ingestCachePath } from "../src/main/collectors/engine/ingest-paths.js";
import type {
  Importer,
  ImportResult,
} from "../src/main/dashboard/agent-dashboard-db-types.js";
import { createWriteQueue } from "../src/main/database/write-queue.js";
import { deferred } from "./deferred.js";
import { fakeCollector, makeSession } from "./normalized-session-test-utils.js";

// A tiny bound keeps the test fast: the wedged write never settles, so the only
// way a pass advances is through the timeout branch.
const TEST_IMPORT_TIMEOUT_MS = 40;
const TEST_MAX_ATTEMPTS = 3;
/**
 * Explicit per-case bound so a regression that never completes FAILS rather than
 * relying on the runner's default to eventually notice (apps/desktop determinism
 * rule). It is a hang detector, never a wait: every pass below settles on the
 * manager's own completion callback.
 */
const TEST_CASE_TIMEOUT_MS = 15_000;
const WEDGED_SESSION_ID = "wedged";

/** Session id for a source, so a pass can tell the two apart by file name. */
function sessionIdOf(source: string): string {
  return basename(source, ".jsonl");
}

async function noopCooperativeDelay(): Promise<void> {
  // No pacing pauses — keep the import loop tight for the test.
}

/**
 * Run ONE historical import pass over `stateDir` with the given importer, the
 * way a fresh launch would, and report the quarantine count the FTUE caveat
 * reads once the pass settled. A new manager per pass is deliberate: the
 * quarantine store is only durable if it survives the process, and re-reading it
 * from `stateDir` is what proves that.
 *
 * wongk review (ISS-6115): settles on `onBootImportComplete`, the manager's own
 * EXACT completion signal — `BootImportLifecycle.complete()` fires it on the line
 * after it sets the complete bit. The previous 5ms poll re-read a snapshot around
 * a 40ms bound, which made the suite load-sensitive for no benefit. Nothing here
 * races the bound now: the wedged write never settles, so the timeout branch is
 * the ONLY way a pass can advance, and a healthy import cannot be caught by it
 * either — `importSessionBounded` settles those from a microtask, which a
 * `setTimeout` can never pre-empt however loaded the machine is.
 *
 * `stop()` is in a `finally` so a failing assertion cannot strand the manager
 * (its watchers, timers and generation) for every later case in the file.
 */
async function runPass(
  stateDir: string,
  sources: string[],
  importSession: Importer["importSession"],
  batch = false,
  cancelInFlightWrite?: Importer["cancelInFlightWrite"]
): Promise<number> {
  const parse = (source: string) =>
    Promise.resolve([makeSession({ sessionId: sessionIdOf(source) })]);
  const bootComplete = deferred<void>();
  const manager = new CollectorManager({
    onBootImportComplete: () => bootComplete.resolve(),
    importer: {
      importSession,
      ...(cancelInFlightWrite ? { cancelInFlightWrite } : {}),
    },
    detectBillingMode: () => "metered_api",
    stateDir,
    emit: () => {},
    getCollectionMode: () => "watcher",
    cooperativeDelay: noopCooperativeDelay,
    historicalImportSessionTimeoutMs: TEST_IMPORT_TIMEOUT_MS,
    parseQuarantineMaxAttempts: TEST_MAX_ATTEMPTS,
    collectors: [
      batch
        ? fakeCollector("opencode", { batch: true, parse, sources })
        : fakeCollector("claude", {
            parse,
            sessionIdForSource: sessionIdOf,
            sources,
          }),
    ],
  });
  try {
    manager.start();
    await bootComplete.promise;
    return manager.getIngestProgress().quarantinedCount;
  } finally {
    manager.stop();
  }
}

/**
 * An importer whose write never settles for the wedged session — the ISS-4410
 * reproduction — and imports every other session normally. `release` settles the
 * abandoned promise after the pass so the test leaves nothing pending.
 */
function wedgedImporter(attempts: string[]): {
  importSession: Importer["importSession"];
  release: () => void;
} {
  const pending = deferred<ImportResult>();
  return {
    importSession: (session) => {
      attempts.push(session.sessionId);
      if (session.sessionId === WEDGED_SESSION_ID) {
        return pending.promise;
      }
      return { skipped: false, reactivated: false };
    },
    release: () => pending.resolve({ skipped: false, reactivated: false }),
  };
}

/** How many of `attempts` are the wedged source's session. */
function wedgedAttempts(attempts: string[]): number {
  return attempts.filter((id) => id === WEDGED_SESSION_ID).length;
}

test("ISS-6115: an import that keeps timing out is quarantined after its attempt budget, and the backlog then drains", {
  timeout: TEST_CASE_TIMEOUT_MS,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-6115-budget-"));
  const wedgedSource = join(dir, `${WEDGED_SESSION_ID}.jsonl`);
  // A healthy neighbour proves the catchup cache below is actually functioning:
  // it must hold THIS source and not the quarantined one.
  const goodSource = join(dir, "good.jsonl");
  writeFileSync(wedgedSource, "{}\n");
  writeFileSync(goodSource, "{}\n");
  const sources = [wedgedSource, goodSource];
  const attempts: string[] = [];
  const releases: Array<() => void> = [];

  try {
    const counts: number[] = [];
    for (let pass = 0; pass < TEST_MAX_ATTEMPTS; pass++) {
      const wedged = wedgedImporter(attempts);
      releases.push(wedged.release);
      counts.push(await runPass(dir, sources, wedged.importSession));
    }

    // Every pass up to the budget re-attempts the source (the ISS-4476 isolate
    // path leaves it unmarked), and only the attempt that CROSSES the budget
    // quarantines it.
    assert.equal(
      wedgedAttempts(attempts),
      TEST_MAX_ATTEMPTS,
      `the wedged source was attempted once per pass: ${JSON.stringify(attempts)}`
    );
    assert.deepEqual(
      counts,
      [0, 0, 1],
      "only the threshold attempt quarantines the source"
    );

    // The pass AFTER the budget must not pay the bound again — that unbounded
    // retry is the issue, and the backlog advancing past the source is the point.
    const wedgedAgain = wedgedImporter(attempts);
    releases.push(wedgedAgain.release);
    const afterQuarantine = await runPass(
      dir,
      sources,
      wedgedAgain.importSession
    );
    assert.equal(
      wedgedAttempts(attempts),
      TEST_MAX_ATTEMPTS,
      "a quarantined source is not re-attempted at full cost"
    );
    assert.equal(
      afterQuarantine,
      1,
      "the quarantine survives the process and still reports through getIngestProgress"
    );

    // ISS-6115 acceptance: a quarantined source is never reported as imported.
    // The catchup cache is the durable "this source was successfully imported"
    // record, so the quarantined source must be absent from it while its healthy
    // neighbour is present — otherwise clearing the quarantine would silently
    // skip a source that was never actually imported.
    const cache = JSON.parse(
      readFileSync(ingestCachePath(dir, "claude"), "utf8")
    ) as { entries?: Record<string, unknown> };
    const entries = cache.entries ?? {};
    assert.ok(
      Object.hasOwn(entries, goodSource),
      `the healthy source was marked seen: ${JSON.stringify(entries)}`
    );
    assert.ok(
      !Object.hasOwn(entries, wedgedSource),
      `the quarantined source was NOT marked seen: ${JSON.stringify(entries)}`
    );
  } finally {
    for (const release of releases) {
      release();
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-6115: a batch store is exempt from the budget — one wedged session must not quarantine the whole harness", {
  timeout: TEST_CASE_TIMEOUT_MS,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-6115-batch-"));
  const store = join(dir, `${WEDGED_SESSION_ID}.jsonl`);
  writeFileSync(store, "{}\n");
  const attempts: string[] = [];
  const releases: Array<() => void> = [];

  try {
    // A batch collector's source IS its whole DB, so quarantining it would drop
    // every remaining and future session of that harness from the historical path
    // — and it could never be re-admitted, because a batch source carries no stat
    // and therefore no freshness fingerprint.
    const counts: number[] = [];
    for (let pass = 0; pass < TEST_MAX_ATTEMPTS + 1; pass++) {
      const wedged = wedgedImporter(attempts);
      releases.push(wedged.release);
      counts.push(await runPass(dir, [store], wedged.importSession, true));
    }

    assert.deepEqual(
      counts,
      [0, 0, 0, 0],
      "a batch store is never quarantined by the import bound"
    );
    assert.equal(
      attempts.length,
      TEST_MAX_ATTEMPTS + 1,
      "and its remaining sessions keep being offered to the importer"
    );
  } finally {
    for (const release of releases) {
      release();
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-6115: a pass that burned no deadline clears the tally, even when the import stayed incomplete", {
  timeout: TEST_CASE_TIMEOUT_MS,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-6115-clear-"));
  const source = join(dir, `${WEDGED_SESSION_ID}.jsonl`);
  writeFileSync(source, "{}\n");
  const attempts: string[] = [];
  const releases: Array<() => void> = [];

  try {
    for (let pass = 0; pass < TEST_MAX_ATTEMPTS - 1; pass++) {
      const wedged = wedgedImporter(attempts);
      releases.push(wedged.release);
      await runPass(dir, [source], wedged.importSession);
    }

    // An `incomplete` import committed within the bound: a tolerated record group
    // failed, so the source stays unmarked for retry — but no deadline was burned,
    // so the tally must reset. Gating the clear on the source having COMMITTED
    // would let old attempts accrete across passes that went fine, which is what
    // ISS-4444's clear existed to prevent.
    await runPass(dir, [source], () => ({
      skipped: false,
      reactivated: false,
      incomplete: true,
    }));

    const wedgedAgain = wedgedImporter(attempts);
    releases.push(wedgedAgain.release);
    assert.equal(
      await runPass(dir, [source], wedgedAgain.importSession),
      0,
      "the next timeout is attempt 1 of the budget again, not the threshold"
    );
  } finally {
    for (const release of releases) {
      release();
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-6115: a genuine import rejection is never charged against the attempt budget", {
  timeout: TEST_CASE_TIMEOUT_MS,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-6115-reject-"));
  const source = join(dir, "rejecting.jsonl");
  writeFileSync(source, "{}\n");
  const attempts: string[] = [];

  try {
    // A rejection is a DB-host transport/lifecycle failure: it aborts the harness
    // pass by design (ISS-4410) rather than resolving through the timeout branch,
    // so charging it would quarantine a healthy source on an outage.
    const counts: number[] = [];
    for (let pass = 0; pass < TEST_MAX_ATTEMPTS + 1; pass++) {
      counts.push(
        await runPass(dir, [source], (session) => {
          attempts.push(session.sessionId);
          return Promise.reject(new Error("db-host write connection lost"));
        })
      );
    }

    assert.deepEqual(
      counts,
      [0, 0, 0, 0],
      "a rejecting source is never quarantined"
    );
    assert.equal(
      attempts.length,
      TEST_MAX_ATTEMPTS + 1,
      "and it is still retried on every pass once the host recovers"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * ISS-6115 (wongk review) — the settle must run on the exits that do NOT fall
 * through to the end of the source's pass.
 *
 * A genuine importer rejection unwinds out of the session loop to
 * `runImportFor.catch`, so before this it never reached the settle and left the
 * previous passes' tally in place. The reviewer's exact sequence on a budget of
 * 3: timeout, timeout, rejection, timeout — the source quarantined on the fourth
 * pass even though the rejection pass burned no deadline at all and should have
 * cleared the tally, exactly as the `incomplete` pass does.
 *
 * The pre-existing rejection test cannot catch this: with rejections on EVERY
 * pass the tally never accumulates, so its `[0,0,0,0]` holds whether or not the
 * rejection clears. Interleaving the timeouts is what makes the clear observable.
 *
 * MUTATION: drop the `finally { settleBudget(); }` around the session loop and
 * the rejection pass no longer clears, so the fourth pass is the threshold
 * attempt and `quarantinedCount` reads 1 instead of 0.
 */
test("ISS-6115: a rejection pass CLEARS the tally — timeout, timeout, rejection, timeout must not quarantine", {
  timeout: TEST_CASE_TIMEOUT_MS,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-6115-reject-clears-"));
  const source = join(dir, `${WEDGED_SESSION_ID}.jsonl`);
  writeFileSync(source, "{}\n");
  const attempts: string[] = [];
  const releases: Array<() => void> = [];

  try {
    const timeoutPass = async (): Promise<number> => {
      const wedged = wedgedImporter(attempts);
      releases.push(wedged.release);
      return await runPass(dir, [source], wedged.importSession);
    };

    // Two chargeable timeouts: the tally is now one short of the budget.
    assert.equal(await timeoutPass(), 0, "pass 1 (timeout) is below budget");
    assert.equal(await timeoutPass(), 0, "pass 2 (timeout) is below budget");

    // The rejection pass burns no deadline — it aborts the harness pass by
    // design (ISS-4410) — so it must reset the tally rather than preserve it.
    const rejected = await runPass(dir, [source], (session) => {
      attempts.push(session.sessionId);
      return Promise.reject(new Error("db-host write connection lost"));
    });
    assert.equal(rejected, 0, "a rejection never quarantines on its own");

    // With the tally cleared this is attempt 1 of 3 again, NOT the threshold.
    assert.equal(
      await timeoutPass(),
      0,
      "the timeout after a rejection is attempt 1 of the budget, not the threshold"
    );

    // Positive control on the same predicate: the budget still converges when
    // nothing clears it, so the assertion above is not passing because the
    // budget is simply never charged.
    assert.equal(await timeoutPass(), 0, "attempt 2 of the fresh budget");
    assert.equal(
      await timeoutPass(),
      1,
      "and the third consecutive timeout still quarantines"
    );
  } finally {
    for (const release of releases) {
      release();
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-6115: a changed transcript re-admits a quarantined source", {
  timeout: TEST_CASE_TIMEOUT_MS,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-6115-refresh-"));
  const source = join(dir, `${WEDGED_SESSION_ID}.jsonl`);
  writeFileSync(source, "{}\n");
  const attempts: string[] = [];
  const releases: Array<() => void> = [];

  try {
    for (let pass = 0; pass < TEST_MAX_ATTEMPTS; pass++) {
      const wedged = wedgedImporter(attempts);
      releases.push(wedged.release);
      await runPass(dir, [source], wedged.importSession);
    }
    assert.equal(attempts.length, TEST_MAX_ATTEMPTS, "the source quarantined");

    // The {mtimeMs, size} pair the store fingerprints on both change: a codex
    // rollout that timed out at 4.7 MB deserves another chance once it is edited
    // or replaced.
    writeFileSync(source, '{}\n{"grown":true}\n');
    const grown = statSync(source);
    utimesSync(source, grown.atime, new Date(grown.mtimeMs + 60_000));

    const imported: string[] = [];
    const count = await runPass(dir, [source], (session) => {
      attempts.push(session.sessionId);
      imported.push(session.sessionId);
      return { skipped: false, reactivated: false };
    });

    assert.deepEqual(
      imported,
      [WEDGED_SESSION_ID],
      "the changed source was re-attempted and imported"
    );
    assert.equal(
      count,
      0,
      "and the stale quarantine entry was discarded rather than left counting"
    );
  } finally {
    for (const release of releases) {
      release();
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * ISS-6115 (wongk review) — the SHARED-QUEUE regression: a healthy source that
 * only ever WAITED behind another session's wedged write must not be charged.
 *
 * The import bound's clock starts at CALL time, before the write reaches the
 * single serialized writer. Production-shaped through the real
 * `createWriteQueue`, exactly as `openSqliteAgentDatabase` wires it: each
 * session's write is a queue task tagged with its session id, and
 * `cancelInFlightWrite` is the queue's task-scoped eviction.
 *
 * The poison source's write DISPATCHES and never settles. Because the queue
 * advances only on an evicted task's REAL settle (split-write safety), the
 * waiter's write is enqueued and never dispatches at all — it burns the entire
 * bound on queue wait alone. Charging it would quarantine a perfectly healthy
 * transcript for someone else's wedge, and with one poison write parked at the
 * head EVERY concurrently-queued source is such a waiter.
 *
 * The two assertions are a matched pair on the SAME predicate: the waiter is not
 * quarantined, and the poison — which did burn its own deadline — is. Without the
 * positive control, "not quarantined" would also pass if the budget never charged
 * anything at all.
 *
 * MUTATION: make `classifyTimeoutCharge` unconditionally chargeable (drop the
 * `WriteQueueCancelOutcome.Queued` case) and the waiter quarantines alongside the
 * poison — `quarantinedCount` reaches 2 and the final assertion fails.
 */
test("ISS-6115: a healthy source queued behind a wedged write is NOT charged for the wait", {
  timeout: TEST_CASE_TIMEOUT_MS,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-6115-queue-wait-"));
  const poisonSource = join(dir, "poison.jsonl");
  const waiterSource = join(dir, "waiter.jsonl");
  writeFileSync(poisonSource, "{}\n");
  writeFileSync(waiterSource, "{}\n");
  // The poison source must be processed FIRST so it owns the writer while the
  // waiter's write is enqueued behind it; the pending scan orders by mtime.
  utimesSync(waiterSource, new Date(1_000_000), new Date(1_000_000));
  utimesSync(poisonSource, new Date(2_000_000), new Date(2_000_000));
  const releases: Array<() => void> = [];

  try {
    const counts: number[] = [];
    for (let pass = 0; pass < TEST_MAX_ATTEMPTS; pass++) {
      // A fresh queue per pass models a fresh launch; the previous pass's
      // abandoned write is released in the `finally` below.
      const queue = createWriteQueue();
      const wedgedWrite = deferred<ImportResult>();
      releases.push(() =>
        wedgedWrite.resolve({ skipped: false, reactivated: false })
      );
      counts.push(
        await runPass(
          dir,
          [poisonSource, waiterSource],
          (session) =>
            queue.run(() => {
              if (session.sessionId === "poison") {
                return wedgedWrite.promise;
              }
              return Promise.resolve({ skipped: false, reactivated: false });
            }, session.sessionId),
          false,
          (sessionId, reason) => queue.cancel(sessionId, reason)
        )
      );
    }

    // Positive control on the same predicate: the poison source DID burn its own
    // deadline every pass, so the budget still converges on it.
    assert.deepEqual(
      counts,
      [0, 0, 1],
      "the poison source — whose own write held the writer — is quarantined on the threshold pass"
    );
    // The waiter's write never dispatched on any pass, so it must still be
    // ELIGIBLE. Both sources stay in the scan (the store prunes entries for paths
    // it is no longer shown), and the next pass — with a healthy importer — must
    // still be offered the waiter and must NOT be offered the quarantined poison.
    const offered: string[] = [];
    assert.equal(
      await runPass(dir, [poisonSource, waiterSource], (session) => {
        offered.push(session.sessionId);
        return { skipped: false, reactivated: false };
      }),
      1,
      "exactly one source is quarantined"
    );
    assert.deepEqual(
      offered,
      ["waiter"],
      "the queue waiter is still retried; only the poison source was skipped"
    );
  } finally {
    for (const release of releases) {
      release();
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-6115: importSessionBounded reports the TIMEOUT branch only — not a genuine failed result or rejection", {
  timeout: TEST_CASE_TIMEOUT_MS,
}, async () => {
  const importer = (result: () => Promise<ImportResult>): Importer =>
    ({ importSession: result }) as unknown as Importer;
  const session = makeSession({ sessionId: WEDGED_SESSION_ID });
  const noop = () => {
    // The bound's diagnostics are not under test here.
  };

  // The TIMEOUT branch: the write never settles, so the bound synthesizes the
  // `failed` result AND reports the timeout.
  let timeouts = 0;
  const timedOut = await importSessionBounded(
    importer(() => new Promise<ImportResult>(() => undefined)),
    noop,
    session,
    "claude",
    "/tmp/wedged.jsonl",
    20,
    () => {
      timeouts += 1;
    }
  );
  assert.equal(timedOut.failed, true);
  assert.equal(timeouts, 1, "the timeout branch reported exactly once");

  // The importer's OWN `failed` result is byte-identical to the synthetic one, so
  // this is the case the callback exists to distinguish: a session-local error
  // (the FK-parent gate on a mis-owned agent id) must not spend the budget.
  let failedReports = 0;
  const failed = await importSessionBounded(
    importer(() =>
      Promise.resolve({ skipped: false, reactivated: false, failed: true })
    ),
    noop,
    session,
    "claude",
    "/tmp/failed.jsonl",
    5000,
    () => {
      failedReports += 1;
    }
  );
  assert.equal(failed.failed, true);
  assert.equal(failedReports, 0, "a genuine failed result is not a timeout");

  // A genuine rejection propagates and aborts the harness pass — never charged.
  let rejectionReports = 0;
  await assert.rejects(
    importSessionBounded(
      importer(() =>
        Promise.reject(new Error("db-host write connection lost"))
      ),
      noop,
      session,
      "claude",
      "/tmp/rejecting.jsonl",
      5000,
      () => {
        rejectionReports += 1;
      }
    )
  );
  assert.equal(rejectionReports, 0, "a rejection is not a timeout");
});
