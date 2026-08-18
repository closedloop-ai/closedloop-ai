/**
 * @file ingest-import-session-timeout.test.ts
 * @description ISS-4410 regression: a single historical `importSession` write
 * that never settles must NOT wedge the whole boot-import sweep at the first of
 * N sources. The desktop reproduction was "import stuck at 1/1545, 0 bytes
 * synced" — the first Claude session's DB-host write was accepted but never
 * completed, so the unbounded `await this.importer.importSession(...)` in the
 * historical import loop never returned, the single serial write queue blocked
 * every later write behind it, and the harness made no further progress.
 *
 * The fix bounds the historical import write (`historicalImportSessionTimeoutMs`):
 * a wedged session resolves as a `failed` import after the bound so the loop
 * advances to the next source, the wedged source is left UNMARKED (retries on the
 * next launch), and the good sources still import. These tests assert that
 * behavior — the loop advances, the surviving sources import, and the wedged
 * source is not marked seen — rather than scanning source text.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CollectorManager } from "../src/main/collectors/engine/collector-manager.js";
import type { ImportResult } from "../src/main/dashboard/agent-dashboard-db-types.js";
import { deferred } from "./deferred.js";
import { fakeCollector, makeSession } from "./normalized-session-test-utils.js";

// A tiny bound keeps the test fast and deterministic: the wedged write never
// resolves, so the ONLY way the second source imports is via the timeout path.
const TEST_IMPORT_TIMEOUT_MS = 40;
const WAIT_TIMEOUT_MS = 4000;

async function noopCooperativeDelay(): Promise<void> {
  // No pacing pauses — keep the import loop tight for the test.
}

/**
 * Resolve when `predicate()` holds, or throw after `WAIT_TIMEOUT_MS`. The bound
 * throws (never falls through silently) per the desktop test:node determinism
 * rule, so a regression that reintroduces the wedge fails loudly instead of a
 * later assertion seeing stale state.
 */
async function waitUntil(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > WAIT_TIMEOUT_MS) {
      throw new Error("timed out waiting for the import loop to advance");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("ISS-4410: a wedged first-session import does not stall the boot import; the loop advances to later sources", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-4410-import-timeout-"));
  const wedgedSource = join(dir, "wedged.jsonl");
  const goodSource = join(dir, "good.jsonl");
  writeFileSync(wedgedSource, "{}\n");
  writeFileSync(goodSource, "{}\n");
  // The import loop processes sources newest-mtime first, so make the WEDGED
  // source the newest — it is the "stuck at 1/N" first item. Without the bound,
  // its unresolved import blocks the loop before the good source is reached.
  utimesSync(goodSource, new Date(1_000_000), new Date(1_000_000));
  utimesSync(wedgedSource, new Date(2_000_000), new Date(2_000_000));

  // The first source's importSession never resolves (the DB-host-write-wedge
  // reproduction). Without the bound, this await would block the whole loop and
  // the good source would never import.
  const wedged = deferred<ImportResult>();
  const importAttempts: string[] = [];
  const completedImports: string[] = [];

  try {
    const manager = new CollectorManager({
      importer: {
        importSession: (session) => {
          importAttempts.push(session.sessionId);
          if (session.sessionId === "wedged-session") {
            return wedged.promise; // never resolves
          }
          completedImports.push(session.sessionId);
          return { skipped: false, reactivated: false };
        },
      },
      detectBillingMode: () => "metered_api",
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "watcher",
      cooperativeDelay: noopCooperativeDelay,
      historicalImportSessionTimeoutMs: TEST_IMPORT_TIMEOUT_MS,
      collectors: [
        fakeCollector("claude", {
          sources: [wedgedSource, goodSource],
          sessionIdForSource: (source) =>
            source === wedgedSource ? "wedged-session" : "good-session",
          parse: (source) =>
            Promise.resolve([
              makeSession({
                sessionId:
                  source === wedgedSource ? "wedged-session" : "good-session",
              }),
            ]),
        }),
      ],
    });

    manager.start();
    // The loop must reach and complete the GOOD source despite the wedged first
    // source — the whole point of the bound.
    await waitUntil(() => completedImports.includes("good-session"));
    manager.stop();
    // Let stop() settle the never-resolving wedged promise's rejection path.
    wedged.resolve({ skipped: false, reactivated: false });

    // Both sources were attempted, and the good one landed — the sweep advanced
    // past the wedged first source instead of stalling at 1/N.
    assert.ok(
      importAttempts.includes("wedged-session"),
      "the wedged first source's session import was attempted"
    );
    assert.deepEqual(completedImports, ["good-session"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-4410: the wedged source is left unmarked so it retries on the next launch; a clean pass imports it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-4410-retry-"));
  const wedgedSource = join(dir, "wedged.jsonl");
  writeFileSync(wedgedSource, "{}\n");

  // First pass: the single source's import wedges → the bound fires → the source
  // is treated as a failed import and MUST NOT be marked seen.
  const wedged = deferred<ImportResult>();
  let firstPassResolved = false;
  const secondPassImports: string[] = [];

  try {
    const firstManager = new CollectorManager({
      importer: {
        importSession: (session) => {
          if (!firstPassResolved) {
            return wedged.promise; // wedge the first pass
          }
          secondPassImports.push(session.sessionId);
          return { skipped: false, reactivated: false };
        },
      },
      detectBillingMode: () => "metered_api",
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "watcher",
      cooperativeDelay: noopCooperativeDelay,
      historicalImportSessionTimeoutMs: TEST_IMPORT_TIMEOUT_MS,
      collectors: [
        fakeCollector("claude", {
          sources: [wedgedSource],
          sessionIdForSource: () => "wedged-session",
          parse: () =>
            Promise.resolve([makeSession({ sessionId: "wedged-session" })]),
        }),
      ],
    });

    firstManager.start();
    // Wait for the bound to fire (the wedged write never resolves, so the pass
    // can only settle via the timeout). Give it several timeout windows.
    await new Promise((resolve) =>
      setTimeout(resolve, TEST_IMPORT_TIMEOUT_MS * 6)
    );
    firstManager.stop();
    wedged.resolve({ skipped: false, reactivated: false });

    // Second pass over the SAME stateDir (so the persisted catchup cache is
    // reused). Because the wedged source was never marked seen, a clean import
    // must re-attempt and import it — proving the failure did not silently drop
    // the source.
    firstPassResolved = true;
    const secondManager = new CollectorManager({
      importer: {
        importSession: (session) => {
          secondPassImports.push(session.sessionId);
          return { skipped: false, reactivated: false };
        },
      },
      detectBillingMode: () => "metered_api",
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "watcher",
      cooperativeDelay: noopCooperativeDelay,
      historicalImportSessionTimeoutMs: TEST_IMPORT_TIMEOUT_MS,
      collectors: [
        fakeCollector("claude", {
          sources: [wedgedSource],
          sessionIdForSource: () => "wedged-session",
          parse: () =>
            Promise.resolve([makeSession({ sessionId: "wedged-session" })]),
        }),
      ],
    });

    secondManager.start();
    await waitUntil(() => secondPassImports.includes("wedged-session"));
    secondManager.stop();

    assert.ok(
      secondPassImports.includes("wedged-session"),
      "the previously-wedged source was re-attempted (not marked seen) and imported on the clean pass"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-4410 (wongk review): a genuine importSession rejection aborts the harness pass instead of a per-source retry storm", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-4410-reject-"));
  const rejectingSource = join(dir, "rejecting.jsonl");
  const laterSource = join(dir, "later.jsonl");
  writeFileSync(rejectingSource, "{}\n");
  writeFileSync(laterSource, "{}\n");
  // Process the REJECTING source first (newest mtime). A DB-host transport /
  // lifecycle rejection (which the main-process proxy raises, not the child
  // importer) must propagate and abort the pass — the pre-ISS-4410 behavior —
  // rather than being swallowed into `failed` and retried once per remaining
  // source. Observable signal: the later source is NOT attempted this pass.
  utimesSync(laterSource, new Date(1_000_000), new Date(1_000_000));
  utimesSync(rejectingSource, new Date(2_000_000), new Date(2_000_000));

  const importAttempts: string[] = [];

  try {
    const manager = new CollectorManager({
      importer: {
        importSession: (session) => {
          importAttempts.push(session.sessionId);
          if (session.sessionId === "rejecting-session") {
            return Promise.reject(new Error("db-host write connection lost"));
          }
          return { skipped: false, reactivated: false };
        },
      },
      detectBillingMode: () => "metered_api",
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "watcher",
      cooperativeDelay: noopCooperativeDelay,
      historicalImportSessionTimeoutMs: TEST_IMPORT_TIMEOUT_MS,
      collectors: [
        fakeCollector("claude", {
          sources: [rejectingSource, laterSource],
          sessionIdForSource: (source) =>
            source === rejectingSource ? "rejecting-session" : "later-session",
          parse: (source) =>
            Promise.resolve([
              makeSession({
                sessionId:
                  source === rejectingSource
                    ? "rejecting-session"
                    : "later-session",
              }),
            ]),
        }),
      ],
    });

    manager.start();
    // The rejection propagates out of importSources and is caught by the boot
    // driver, which aborts this harness pass. Wait until the rejecting source
    // was attempted, then confirm the later source was NOT reached this pass.
    await waitUntil(() => importAttempts.includes("rejecting-session"));
    // Give any (incorrect) continue-to-next-source path a chance to run.
    await new Promise((resolve) =>
      setTimeout(resolve, TEST_IMPORT_TIMEOUT_MS * 4)
    );
    manager.stop();

    assert.ok(
      importAttempts.includes("rejecting-session"),
      "the rejecting source's import was attempted"
    );
    assert.ok(
      !importAttempts.includes("later-session"),
      "a genuine rejection aborted the pass — the later source was NOT imported this pass (no per-source retry storm)"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-4410 (wongk review): a synchronous importer throw aborts without logging a bogus timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-4410-sync-throw-"));
  const source = join(dir, "sync-throw.jsonl");
  writeFileSync(source, "{}\n");

  const logs: string[] = [];
  const importAttempts: string[] = [];

  try {
    const manager = new CollectorManager({
      importer: {
        importSession: (session) => {
          importAttempts.push(session.sessionId);
          // A synchronous throw happens before the returned promise exists. It
          // must route through the same reject/cleanup path so the bound's timer
          // is cleared and can never later log a spurious timeout for this
          // already-failed session.
          throw new Error("synchronous db-host failure");
        },
      },
      detectBillingMode: () => "metered_api",
      stateDir: dir,
      emit: () => {},
      log: (message) => logs.push(message),
      getCollectionMode: () => "watcher",
      cooperativeDelay: noopCooperativeDelay,
      historicalImportSessionTimeoutMs: TEST_IMPORT_TIMEOUT_MS,
      collectors: [
        fakeCollector("claude", {
          sources: [source],
          sessionIdForSource: () => "sync-throw-session",
          parse: () =>
            Promise.resolve([makeSession({ sessionId: "sync-throw-session" })]),
        }),
      ],
    });

    manager.start();
    await waitUntil(() => importAttempts.includes("sync-throw-session"));
    // Wait well past the bound so a leaked timer would have fired its log.
    await new Promise((resolve) =>
      setTimeout(resolve, TEST_IMPORT_TIMEOUT_MS * 6)
    );
    manager.stop();

    assert.ok(
      importAttempts.includes("sync-throw-session"),
      "the throwing source's import was attempted"
    );
    assert.ok(
      !logs.some((line) => line.includes("exceeded")),
      "a synchronous throw cleared the bound's timer — no bogus timeout was logged"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
