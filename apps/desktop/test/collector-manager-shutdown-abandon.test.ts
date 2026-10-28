/**
 * @file collector-manager-shutdown-abandon.test.ts
 * @description ISS-5262 — the collector import lane must not call an
 * intentional shutdown a failure.
 *
 * `collector claude import failed: db-host exited (code: 0)` landed AFTER
 * `shutdown sequence end: clean`, which made the shutdown verdict a lie: the
 * import did not fail, the db-host went away underneath it because the user
 * quit. This pins the call site — `runImportFor`'s catch — actually consulting
 * the shutdown classifier, so deleting that branch turns the assertion red
 * rather than leaving a green suite behind a helper nobody calls.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path, { join } from "node:path";
import { test } from "vitest";
import { CollectorManager } from "../src/main/collectors/engine/collector-manager.js";
import type { HarnessCollector } from "../src/main/collectors/types.js";
import { DbHostExitError } from "../src/shared/db-host-exit-error.js";
import {
  DB_HOST_SHUTDOWN_ABANDON_REASON,
  DbHostShutdownError,
  DbHostShutdownReason,
} from "../src/shared/db-host-shutdown-error.js";
import { type Deferred, deferred } from "./deferred.js";
import {
  makeSession,
  noopCooperativeDelay,
} from "./helpers/collector-manager-fixtures.js";
import { fakeCollector } from "./normalized-session-test-utils.js";

const ABANDONED_LINE =
  /collector claude import abandoned: db-host shutting down/;
const FAILED_WORD = /import failed/;
const REAL_FAILURE_LINE =
  /collector claude import failed: SQLITE_BUSY: database is locked/;
const BACKFILL_ABANDONED_LINE = /session backfill \[codex\] abandoned at /;
const RAW_EXIT_MESSAGE = /db-host exited \(code: 0\)/;
/** ISS-5808 — the tracker's terminal line once in-session re-drives are spent. */
const REDRIVE_BUDGET_EXHAUSTED_LINE =
  /re-drive budget exhausted after \d+ consecutive abandoned pass\(es\)/;
/** The manager's own line, counted to prove the pass really ran more than once. */
const RECOVERABLE_IMPORT_FAILED_LINE =
  /collector claude import failed: db-host exited \(code: 0\)/;

/**
 * How long a wait may go unanswered before the case fails. A HANG ESCAPE, not a
 * budget the work has to fit inside: every wait below settles the instant the
 * manager logs its line, so a healthy pass never reads this. It sits well under
 * the lane's 120s per-test timeout so a wedged pass fails naming the line it
 * wanted and the lines it saw, and so the `finally` that stops the manager still
 * runs rather than leaving the import loop to hang the whole FILE.
 */
const LOG_WAIT_TIMEOUT_MS = 30_000;

type ManagerLog = {
  lines: string[];
  log: (message: string) => void;
  waitForLog: (needle: string) => Promise<string>;
};

/**
 * The manager's log, plus a wait that settles ON THE EMIT.
 *
 * ISS-10065: this wait used to spin 500 `setImmediate` turns and give up. A turn
 * count is a scheduling budget, not a completion signal — the backfill advances
 * through real async work that does not move in lockstep with the event loop, so
 * a loaded runner could exhaust the budget with the pass still at `preparing`
 * and redden a correct build. `log` is called exactly once per line by the code
 * under test, so that call IS the signal every assertion here is waiting for.
 */
function createManagerLog(): ManagerLog {
  const lines: string[] = [];
  const waiters = new Set<{ needle: string; settle: Deferred<string> }>();

  function log(message: string): void {
    lines.push(message);
    for (const waiter of waiters) {
      if (message.includes(waiter.needle)) {
        waiters.delete(waiter);
        waiter.settle.resolve(message);
      }
    }
  }

  async function waitForLog(needle: string): Promise<string> {
    const alreadySeen = lines.find((line) => line.includes(needle));
    if (alreadySeen) {
      return alreadySeen;
    }
    const waiter = { needle, settle: deferred<string>() };
    waiters.add(waiter);
    const hangEscape = setTimeout(() => {
      waiters.delete(waiter);
      waiter.settle.reject(
        new Error(
          `no log line containing "${needle}" within ${LOG_WAIT_TIMEOUT_MS}ms; saw ${JSON.stringify(lines)}`
        )
      );
    }, LOG_WAIT_TIMEOUT_MS);
    try {
      return await waiter.settle.promise;
    } finally {
      clearTimeout(hangEscape);
    }
  }

  return { lines, log, waitForLog };
}

/** A collector whose source enumeration fails with `error`. */
function failingCollector(error: Error): HarnessCollector {
  return {
    ...fakeCollector("claude"),
    listSources: () => {
      throw error;
    },
  };
}

async function runImportWith(error: Error): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss-5262-collector-"));
  const managerLog = createManagerLog();
  try {
    const manager = new CollectorManager({
      importer: {
        importSession: () => ({ skipped: false, reactivated: false }),
      },
      stateDir: dir,
      emit: () => {
        // unused
      },
      getCollectionMode: () => "watcher",
      log: managerLog.log,
      collectors: [failingCollector(error)],
    });
    manager.start();
    // ALWAYS stop the manager, including when the wait gives up: a live import
    // loop left behind hangs the whole test FILE instead of failing this case.
    try {
      return await managerLog.waitForLog("collector claude ");
    } finally {
      await manager.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a graceful db-host exit is reported as ABANDONED, not failed", async () => {
  const line = await runImportWith(
    new DbHostShutdownError(
      DbHostShutdownReason.Exited,
      "db-host exited (code: 0)"
    )
  );

  assert.match(
    line,
    ABANDONED_LINE,
    `the quit must not read as an import failure; saw "${line}"`
  );
  assert.doesNotMatch(
    line,
    FAILED_WORD,
    "the word 'failed' is exactly what contradicted the clean shutdown verdict"
  );
});

test("a real import failure is still reported as failed, with its message", async () => {
  const line = await runImportWith(
    new Error("SQLITE_BUSY: database is locked")
  );

  assert.match(
    line,
    REAL_FAILURE_LINE,
    `a genuine failure must stay loud; saw "${line}"`
  );
});

/**
 * closedloop-ai-stage review: the catch narrates the abandonment TWICE. Fixing
 * only its own line left `abandonPass` holding the raw error, so the ingest
 * tracker still printed
 * `session backfill [codex] abandoned at N/M source file(s): db-host exited (code: 0)`
 * — the exact string the branch above exists to keep out of the log after
 * `shutdown sequence end: clean`. This drives a REAL first pass (so `beginPass`
 * has run and `abandonPass` actually logs) and rejects the unbounded historical
 * import with the typed error, pinning the second line too.
 */
test("the backfill abandon line reports the shutdown, not the raw db-host exit", async () => {
  const dir = mkdtempSync(join(os.tmpdir(), "iss-5262-backfill-abandon-"));
  try {
    const sources: string[] = [];
    for (let index = 0; index < 3; index++) {
      const source = join(dir, `codex-${index}.jsonl`);
      writeFileSync(source, "{}\n");
      sources.push(source);
    }
    const managerLog = createManagerLog();
    const manager = new CollectorManager({
      importer: {
        importSession: () => {
          throw new DbHostShutdownError(
            DbHostShutdownReason.Exited,
            "db-host exited (code: 0)"
          );
        },
      },
      stateDir: dir,
      emit: () => {
        // unused
      },
      getCollectionMode: () => "watcher",
      cooperativeDelay: noopCooperativeDelay,
      // Unbounded, so the rejection propagates out of the import loop to
      // `runImportFor`'s catch instead of being absorbed by the bounded wrapper.
      historicalImportSessionTimeoutMs: null,
      catchupPollMs: null,
      log: managerLog.log,
      collectors: [
        {
          key: "codex",
          cacheName: "codex",
          allowUnscopedSourceAdmission: true,
          watchRoots: () => [],
          watchMatch: () => true,
          listSources: () => sources,
          parse: (source: string) =>
            Promise.resolve([makeSession(`session-${source}`)]),
        },
      ],
    });

    manager.start();
    // ALWAYS stop the manager, including when the wait gives up — see
    // `runImportWith`.
    let line: string;
    try {
      line = await managerLog.waitForLog("session backfill [codex] abandoned");
    } finally {
      await manager.stop();
    }

    assert.match(line, BACKFILL_ABANDONED_LINE, line);
    assert.ok(
      line.includes(DB_HOST_SHUTDOWN_ABANDON_REASON),
      `the abandon line must name the shutdown; saw "${line}"`
    );
    assert.doesNotMatch(
      line,
      RAW_EXIT_MESSAGE,
      `the raw db-host exit is what made the clean-shutdown verdict a lie; saw "${line}"`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * ISS-5808 — the PRODUCTION WIRING of the import pass's re-drive verdict.
 *
 * `describeCollectorImportFailure` is unit-tested in
 * `db-host-exit-consumer-recovery.test.ts`, but its `passCompleted` verdict only
 * matters because `runImportFor` returns it as `HarnessImportResult.outcome`
 * and the WATCHER re-arms `pendingHistoricalImport` off exactly that field.
 * Hardcoding a completed outcome back at the call site left every other suite
 * green, so this case observes the re-arm through the manager itself.
 *
 * The observable is the manager's OWN log: a pass abandoned by a recoverable
 * db-host exit is re-armed, abandoned again, and after
 * `MAX_CONSECUTIVE_ABANDON_REDRIVES` the tracker refuses further re-drives and
 * says so. That one line therefore proves BOTH halves at once — the pass really
 * was re-driven in-session, and the re-drive is bounded rather than a crash loop
 * against a host that keeps dying.
 */
test("a pass abandoned by a recoverable db-host exit is re-driven, and the re-drive is bounded", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss-5808-collector-"));
  const managerLog = createManagerLog();
  try {
    const manager = new CollectorManager({
      importer: {
        importSession: () => ({ skipped: false, reactivated: false }),
      },
      stateDir: dir,
      emit: () => {
        // unused
      },
      getCollectionMode: () => "watcher",
      catchupPollMs: null,
      log: managerLog.log,
      collectors: [
        failingCollector(
          new DbHostExitError(0, true, "db-host exited (code: 0)")
        ),
      ],
    });
    manager.start();
    try {
      // The re-drive is what this case observes: a SECOND failed pass, which
      // only happens because `runImportFor` reported the first one incomplete
      // and the watcher re-armed it. The bound on that chain is asserted
      // deterministically against the tracker itself in
      // `ingest-progress-tracker.test.ts`, without a live manager.
      const line = await managerLog.waitForLog("re-drive budget exhausted");
      assert.match(line, REDRIVE_BUDGET_EXHAUSTED_LINE, line);
      assert.ok(
        managerLog.lines.filter((entry) =>
          RECOVERABLE_IMPORT_FAILED_LINE.test(entry)
        ).length > 1,
        `the pass must be re-driven in-session, not left to the next launch; saw ${JSON.stringify(managerLog.lines)}`
      );
    } finally {
      // ALWAYS stop the manager. A failed wait would otherwise leave the import
      // loop running and hang the whole test FILE instead of failing this case.
      await manager.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
