/**
 * @file ingest-parse-watchdog.test.ts
 * @description ISS-4444 regression: a single historical `parseSource` that never
 * settles (a catastrophic-regex-backtrack / CPU-spin on a poison transcript, which
 * never THROWS so the loop's existing dead-letter `continue` is unreachable) must
 * NOT wedge the whole boot-import sweep at 1/N. The desktop reproduction was
 * "import stuck at 1/1545" with the db-host node utility pegged ~99% CPU forever.
 *
 * The fix bounds the parse (`historicalParseTimeoutMs`): a wedged parse is
 * dead-lettered so the loop advances, the source is left UNMARKED (retries next
 * launch), and after `parseQuarantineMaxAttempts` wedging passes the source is
 * QUARANTINED (persisted, skipped on future launches) so the boot import COMPLETES
 * with it excluded. These tests assert that behavior — the loop advances, the good
 * source imports, the wedged source is quarantined + persisted, and the boot import
 * settles to `complete`.
 *
 * wongk review (ISS-4444): synchronization is on real completion signals emitted by
 * the code under test — the `onBootImportComplete` lifecycle callback and the
 * importSession mock — resolved through `deferred()`, per the desktop test:node
 * determinism rule. There is no `Date.now`/`setTimeout` polling barrier, so the
 * cases do not depend on shared-runner timing (the only timer is the parse bound
 * itself, which is what is under test).
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CollectorManager } from "../src/main/collectors/engine/collector-manager.js";
import { parseQuarantinePath } from "../src/main/collectors/engine/parse-quarantine.js";
import { deferred } from "./deferred.js";
import { fakeCollector, makeSession } from "./normalized-session-test-utils.js";

// A tiny parse bound keeps the test fast: the wedged parse never settles, so the
// ONLY way the loop advances is via the timeout path.
const TEST_PARSE_TIMEOUT_MS = 40;

async function noopCooperativeDelay(): Promise<void> {
  // No pacing pauses — keep the import loop tight for the test.
}

test("ISS-4444: a parse that never settles is bounded and dead-lettered; the loop advances to later sources", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-4444-parse-watchdog-"));
  const wedgedSource = join(dir, "wedged.jsonl");
  const goodSource = join(dir, "good.jsonl");
  writeFileSync(wedgedSource, "{}\n");
  writeFileSync(goodSource, "{}\n");
  // The loop processes newest-mtime first, so make the WEDGED source the newest —
  // it is the "stuck at 1/N" first item. Without the parse bound its unresolved
  // parse blocks the loop before the good source is reached.
  utimesSync(goodSource, new Date(1_000_000), new Date(1_000_000));
  utimesSync(wedgedSource, new Date(2_000_000), new Date(2_000_000));

  const wedged = deferred<ReturnType<typeof makeSession>[]>();
  const completedImports: string[] = [];
  // Completion signal: the importSession mock resolves this the moment the good
  // source lands, so the test synchronizes on the effect under test rather than
  // polling — the loop must reach the good source despite the wedged first parse.
  const goodImported = deferred();

  try {
    const manager = new CollectorManager({
      importer: {
        importSession: (session) => {
          completedImports.push(session.sessionId);
          if (session.sessionId === "good-session") {
            goodImported.resolve();
          }
          return { skipped: false, reactivated: false };
        },
      },
      detectBillingMode: () => "metered_api",
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "watcher",
      cooperativeDelay: noopCooperativeDelay,
      historicalParseTimeoutMs: TEST_PARSE_TIMEOUT_MS,
      parseQuarantineMaxAttempts: 1,
      collectors: [
        fakeCollector("claude", {
          sources: [wedgedSource, goodSource],
          sessionIdForSource: (source) =>
            source === wedgedSource ? "wedged-session" : "good-session",
          parse: (source) =>
            source === wedgedSource
              ? wedged.promise // never resolves — the CPU-spin reproduction
              : Promise.resolve([makeSession({ sessionId: "good-session" })]),
        }),
      ],
    });

    manager.start();
    // The loop must reach and complete the GOOD source despite the wedged first
    // parse — the whole point of the bound.
    await goodImported.promise;
    manager.stop();
    wedged.resolve([]); // let the abandoned parse settle harmlessly

    assert.deepEqual(completedImports, ["good-session"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-4444: after N wedging passes the source is quarantined (persisted) and no longer parsed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-4444-quarantine-persist-"));
  const wedgedSource = join(dir, "wedged.jsonl");
  writeFileSync(wedgedSource, "{}\n");
  const persistPath = parseQuarantinePath(dir, "claude");

  const wedged = deferred<ReturnType<typeof makeSession>[]>();
  let parseAttempts = 0;
  // Completion signal for the first launch: onBootImportComplete resolves this
  // once the boot import settles (the wedged source dead-lettered + quarantined).
  const firstComplete = deferred();

  try {
    const manager = new CollectorManager({
      importer: {
        importSession: () => ({ skipped: false, reactivated: false }),
      },
      detectBillingMode: () => "metered_api",
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "watcher",
      cooperativeDelay: noopCooperativeDelay,
      historicalParseTimeoutMs: TEST_PARSE_TIMEOUT_MS,
      // Quarantine on the FIRST wedge so a single pass persists the quarantine.
      parseQuarantineMaxAttempts: 1,
      onBootImportComplete: () => firstComplete.resolve(),
      collectors: [
        fakeCollector("claude", {
          sources: [wedgedSource],
          sessionIdForSource: () => "wedged-session",
          parse: () => {
            parseAttempts += 1;
            return wedged.promise; // never resolves
          },
        }),
      ],
    });

    manager.start();
    // The boot import settles to complete despite the wedged source — it is
    // dead-lettered, then quarantined, so the pass finishes.
    await firstComplete.promise;
    manager.stop();
    wedged.resolve([]);

    const progress = manager.getIngestProgress();
    assert.equal(
      progress.complete,
      true,
      "the boot import completed despite the wedged source"
    );
    assert.equal(
      progress.quarantinedCount,
      1,
      "the wedged source was quarantined and surfaced in the count"
    );
    assert.ok(existsSync(persistPath), "the quarantine was persisted to disk");
    assert.equal(
      parseAttempts,
      1,
      "the source was parsed exactly once this pass"
    );

    // A SECOND manager over the same stateDir must SKIP the quarantined source —
    // it is never parsed again — so a poison transcript can't re-wedge each boot.
    let secondPassParses = 0;
    const secondComplete = deferred();
    const secondManager = new CollectorManager({
      importer: {
        importSession: () => ({ skipped: false, reactivated: false }),
      },
      detectBillingMode: () => "metered_api",
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "watcher",
      cooperativeDelay: noopCooperativeDelay,
      historicalParseTimeoutMs: TEST_PARSE_TIMEOUT_MS,
      parseQuarantineMaxAttempts: 1,
      onBootImportComplete: () => secondComplete.resolve(),
      collectors: [
        fakeCollector("claude", {
          sources: [wedgedSource],
          sessionIdForSource: () => "wedged-session",
          parse: () => {
            secondPassParses += 1;
            return Promise.resolve([]);
          },
        }),
      ],
    });

    secondManager.start();
    await secondComplete.promise;
    secondManager.stop();

    assert.equal(
      secondPassParses,
      0,
      "the quarantined source was skipped on the next launch (never re-parsed)"
    );
    assert.equal(
      secondManager.getIngestProgress().quarantinedCount,
      1,
      "the persisted quarantine is still reported on the next launch"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-4444: a wedging BATCH collector (OpenCode) is quarantined so it stops re-running the kill cycle every launch", async () => {
  // wongk review: OpenCode is a batch collector; before the fix batch collectors
  // got no quarantine store, so a wedging `opencode.db` timeout left
  // recordSourceTimeout with undefined and re-ran the 90s kill cycle every boot and
  // every catch-up, never quarantining. It must now be quarantined + skipped.
  const dir = mkdtempSync(join(tmpdir(), "iss-4444-opencode-quarantine-"));
  const wedgedDb = join(dir, "opencode.db");
  writeFileSync(wedgedDb, "{}\n");
  const persistPath = parseQuarantinePath(dir, "opencode");

  const wedged = deferred<ReturnType<typeof makeSession>[]>();
  let parseAttempts = 0;
  const firstComplete = deferred();

  try {
    const manager = new CollectorManager({
      importer: {
        importSession: () => ({ skipped: false, reactivated: false }),
      },
      detectBillingMode: () => "metered_api",
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "watcher",
      cooperativeDelay: noopCooperativeDelay,
      historicalParseTimeoutMs: TEST_PARSE_TIMEOUT_MS,
      parseQuarantineMaxAttempts: 1,
      onBootImportComplete: () => firstComplete.resolve(),
      collectors: [
        fakeCollector("opencode", {
          batch: true,
          sources: [wedgedDb],
          parse: () => {
            parseAttempts += 1;
            return wedged.promise; // the poison opencode.db never settles
          },
        }),
      ],
    });

    manager.start();
    await firstComplete.promise;
    manager.stop();
    wedged.resolve([]);

    const progress = manager.getIngestProgress();
    assert.equal(progress.complete, true);
    assert.equal(
      progress.quarantinedCount,
      1,
      "the wedging opencode.db was quarantined"
    );
    assert.ok(
      existsSync(persistPath),
      "the batch-collector quarantine was persisted"
    );
    assert.equal(parseAttempts, 1);

    // Next launch over the same stateDir must NOT re-parse the quarantined DB.
    let secondPassParses = 0;
    const secondComplete = deferred();
    const secondManager = new CollectorManager({
      importer: {
        importSession: () => ({ skipped: false, reactivated: false }),
      },
      detectBillingMode: () => "metered_api",
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "watcher",
      cooperativeDelay: noopCooperativeDelay,
      historicalParseTimeoutMs: TEST_PARSE_TIMEOUT_MS,
      parseQuarantineMaxAttempts: 1,
      onBootImportComplete: () => secondComplete.resolve(),
      collectors: [
        fakeCollector("opencode", {
          batch: true,
          sources: [wedgedDb],
          parse: () => {
            secondPassParses += 1;
            return Promise.resolve([]);
          },
        }),
      ],
    });

    secondManager.start();
    await secondComplete.promise;
    secondManager.stop();

    assert.equal(
      secondPassParses,
      0,
      "the quarantined opencode.db was skipped on the next launch — no more kill cycle"
    );
    assert.equal(secondManager.getIngestProgress().quarantinedCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-4444: boot import settles to complete with a good source imported and a poison source quarantined", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-4444-settle-"));
  const poisonSource = join(dir, "poison.jsonl");
  const goodSource = join(dir, "good.jsonl");
  writeFileSync(poisonSource, "{}\n");
  writeFileSync(goodSource, "{}\n");
  utimesSync(goodSource, new Date(1_000_000), new Date(1_000_000));
  utimesSync(poisonSource, new Date(2_000_000), new Date(2_000_000));

  const wedged = deferred<ReturnType<typeof makeSession>[]>();
  const completedImports: string[] = [];
  const bootComplete = deferred();

  try {
    const manager = new CollectorManager({
      importer: {
        importSession: (session) => {
          completedImports.push(session.sessionId);
          return { skipped: false, reactivated: false };
        },
      },
      detectBillingMode: () => "metered_api",
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "watcher",
      cooperativeDelay: noopCooperativeDelay,
      historicalParseTimeoutMs: TEST_PARSE_TIMEOUT_MS,
      parseQuarantineMaxAttempts: 1,
      onBootImportComplete: () => bootComplete.resolve(),
      collectors: [
        fakeCollector("claude", {
          sources: [poisonSource, goodSource],
          sessionIdForSource: (source) =>
            source === poisonSource ? "poison-session" : "good-session",
          parse: (source) =>
            source === poisonSource
              ? wedged.promise
              : Promise.resolve([makeSession({ sessionId: "good-session" })]),
        }),
      ],
    });

    manager.start();
    await bootComplete.promise;
    manager.stop();
    wedged.resolve([]);

    const progress = manager.getIngestProgress();
    // The whole point: the import COMPLETES (so store-integrity runs and the
    // always-available cards resolve) even though one source was quarantined.
    assert.equal(progress.complete, true);
    assert.equal(
      progress.timedOut,
      false,
      "a bounded parse is NOT a boot-import timeout"
    );
    assert.equal(progress.quarantinedCount, 1);
    assert.deepEqual(completedImports, ["good-session"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
