/**
 * @file ingest-batch-resume-cursor-store.test.ts
 * @description ISS-5161: unit coverage for `BatchResumeCursors` itself — the
 * persistence boundary of the BATCH-harness resume cursor.
 *
 * Split out of `ingest-batch-resume-durability.test.ts`, which keeps the
 * multi-process `CollectorManager` integration cases. The two files answer
 * different questions: that one asks "does an interrupted backfill resume
 * correctly across a restart", this one asks "does the cursor store itself
 * round-trip, degrade, and stay bounded". Keeping them together pushed the file
 * past the 1,000-line ceiling (AGENTS.md → File Size and Organization).
 *
 * What is pinned here: disk round-trip and terminal-outcome cleanup, the
 * fingerprint gate that makes a disk-loaded cursor honorable only while the
 * store has not moved, `clear()` releasing memory without discarding the file,
 * corrupt / foreign-version / unreadable / oversized files all degrading to "no
 * cursor" (replay the prefix once) with the right reporting, the flush throttle
 * under a persistently failing write, and both collection bounds.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BatchResumeCursors,
  MAX_CURSOR_FILE_BYTES,
  MAX_CURSOR_SOURCES,
  MAX_SESSION_IDS_PER_SOURCE,
} from "../src/main/collectors/engine/collector-manager-batch-resume.js";
import { ingestBatchResumeCursorPath } from "../src/main/collectors/engine/ingest-paths.js";

const OPENCODE = "opencode";
const STORE_SOURCE = "/store.db";
const FINGERPRINT_BEFORE_QUIT = "opencode.db:1000:512";
const FINGERPRINT_AFTER_EDIT = "opencode.db:2000:640";

test("ISS-5161: the cursor round-trips through disk and a completed source clears it", () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-5161-cursor-store-"));
  try {
    const persistPath = ingestBatchResumeCursorPath(dir);
    const writer = new BatchResumeCursors({ persistPath });
    writer.noteImported(OPENCODE, STORE_SOURCE, "s1", FINGERPRINT_BEFORE_QUIT);
    writer.noteImported(OPENCODE, STORE_SOURCE, "s2", FINGERPRINT_BEFORE_QUIT);
    writer.flush();

    const reader = new BatchResumeCursors({ persistPath });
    const seen = (id: string) =>
      reader.isImported(OPENCODE, STORE_SOURCE, id, FINGERPRINT_BEFORE_QUIT);
    assert.equal(seen("s1"), true);
    assert.equal(seen("s2"), true);
    assert.equal(seen("s3"), false);
    assert.equal(
      reader.isImported("claude", STORE_SOURCE, "s1", FINGERPRINT_BEFORE_QUIT),
      false,
      "cursors do not leak across harnesses"
    );

    // A terminal outcome must clear the cursor on DISK too, not just in memory:
    // a stale cursor that outlived its source would make the retry skip the very
    // sessions it was scheduled to re-read.
    reader.forget(OPENCODE, STORE_SOURCE);
    const afterForget = new BatchResumeCursors({ persistPath });
    assert.equal(
      afterForget.isImported(
        OPENCODE,
        STORE_SOURCE,
        "s1",
        FINGERPRINT_BEFORE_QUIT
      ),
      false
    );
    assert.equal(afterForget.size(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-5161: a disk-loaded cursor is honored only while the store fingerprint still matches", () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-5161-cursor-fingerprint-"));
  try {
    const persistPath = ingestBatchResumeCursorPath(dir);
    const writer = new BatchResumeCursors({ persistPath });
    writer.noteImported(OPENCODE, STORE_SOURCE, "s1", FINGERPRINT_BEFORE_QUIT);
    writer.flush();

    const moved = new BatchResumeCursors({ persistPath });
    assert.equal(
      moved.isImported(OPENCODE, STORE_SOURCE, "s1", FINGERPRINT_AFTER_EDIT),
      false,
      "a store that moved since the cursor was written must replay, not skip"
    );
    assert.equal(
      moved.size(),
      0,
      "the invalidated entry is dropped rather than left to gate later sessions"
    );

    // ISS-5161 (review H2): an IN-MEMORY cursor is gated exactly the same way.
    // `markSourceImported` only refuses a move that happened AFTER this pass
    // captured its snapshot; a live-watcher import between two low-duty quanta
    // moves the store BEFORE the resumed quantum's own snapshot, so nothing is
    // left to refuse and an ungated fast-forward would seal the edit away.
    const live = new BatchResumeCursors();
    live.noteImported(OPENCODE, STORE_SOURCE, "s1", FINGERPRINT_BEFORE_QUIT);
    assert.equal(
      live.isImported(OPENCODE, STORE_SOURCE, "s1", FINGERPRINT_AFTER_EDIT),
      false,
      "an in-memory fast-forward must not survive the store moving under it"
    );
    assert.equal(
      live.size(),
      0,
      "the invalidated in-memory entry is dropped, not left to gate later sessions"
    );
    // Re-recording under the moved fingerprint starts a FRESH entry, so the
    // replayed prefix is re-read rather than laundered into a cursor that now
    // claims to have been recorded under the new fingerprint.
    live.noteImported(OPENCODE, STORE_SOURCE, "s2", FINGERPRINT_AFTER_EDIT);
    assert.equal(
      live.isImported(OPENCODE, STORE_SOURCE, "s1", FINGERPRINT_AFTER_EDIT),
      false,
      "ids recorded before the move must not be revived by a later record"
    );
    assert.equal(
      live.isImported(OPENCODE, STORE_SOURCE, "s2", FINGERPRINT_AFTER_EDIT),
      true,
      "ids recorded under the current fingerprint still fast-forward"
    );

    // A collector that exposes no fingerprint records `null`, which can never be
    // proven unmoved, so it is never honored from disk.
    const unfingerprinted = new BatchResumeCursors({
      persistPath: join(dir, "no-fingerprint.json"),
    });
    unfingerprinted.noteImported(OPENCODE, STORE_SOURCE, "s1", null);
    unfingerprinted.flush();
    assert.equal(
      new BatchResumeCursors({
        persistPath: join(dir, "no-fingerprint.json"),
      }).isImported(OPENCODE, STORE_SOURCE, "s1", null),
      false
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-5161: clear() releases memory without discarding the persisted cursor", () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-5161-cursor-clear-"));
  try {
    const persistPath = ingestBatchResumeCursorPath(dir);
    const cursors = new BatchResumeCursors({ persistPath });
    cursors.noteImported(OPENCODE, STORE_SOURCE, "s1", FINGERPRINT_BEFORE_QUIT);
    // The `stop()` sequence: flush, then release memory. The disk copy is what
    // the next process resumes from, so `clear()` must not touch it.
    cursors.flush();
    cursors.clear();

    assert.equal(
      new BatchResumeCursors({ persistPath }).isImported(
        OPENCODE,
        STORE_SOURCE,
        "s1",
        FINGERPRINT_BEFORE_QUIT
      ),
      true,
      "a stopped process must leave its checkpoint behind for the next one"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-5161: a corrupt or foreign-version cursor file is reported and degrades to no cursor", () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-5161-cursor-corrupt-"));
  try {
    const persistPath = ingestBatchResumeCursorPath(dir);
    // This is unknown JSON at a persistence boundary: a truncated file must load
    // as "no cursor" (replay the prefix once, which is correct) and never as a
    // partially-trusted cursor that could skip sessions it never imported.
    writeFileSync(persistPath, '{"version":2,"cursors":{"opencode /store.db"');
    const truncatedLines: string[] = [];
    const truncated = new BatchResumeCursors({
      persistPath,
      log: (message) => truncatedLines.push(message),
    });
    assert.equal(
      truncated.isImported(
        OPENCODE,
        STORE_SOURCE,
        "s1",
        FINGERPRINT_BEFORE_QUIT
      ),
      false
    );
    assert.equal(
      truncatedLines.filter((line) => line.includes("unreadable")).length,
      1,
      `an unreadable checkpoint is reported, not swallowed: ${JSON.stringify(truncatedLines)}`
    );

    // Well-formed JSON of the wrong SHAPE is corruption, and is reported. This
    // shape is also the PREVIOUS format version's payload (a bare id array), so
    // it doubles as the "old build's file" case.
    writeFileSync(persistPath, '{"version":2,"cursors":{"k":["s1"]}}');
    const invalidLines: string[] = [];
    const invalid = new BatchResumeCursors({
      persistPath,
      log: (message) => invalidLines.push(message),
    });
    assert.equal(
      invalid.isImported(OPENCODE, STORE_SOURCE, "s1", FINGERPRINT_BEFORE_QUIT),
      false
    );
    assert.equal(
      invalidLines.filter((line) => line.includes("invalid")).length,
      1
    );

    // A different format version is an expected upgrade, not corruption: it is
    // discarded silently and costs one replayed prefix.
    writeFileSync(
      persistPath,
      JSON.stringify({
        version: 999,
        cursors: {
          "opencode /store.db": {
            fingerprint: FINGERPRINT_BEFORE_QUIT,
            sessionIds: ["s1"],
          },
        },
      })
    );
    const futureLines: string[] = [];
    const future = new BatchResumeCursors({
      persistPath,
      log: (message) => futureLines.push(message),
    });
    assert.equal(
      future.isImported(OPENCODE, STORE_SOURCE, "s1", FINGERPRINT_BEFORE_QUIT),
      false
    );
    assert.deepEqual(futureLines, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-5161: the flush throttle persists mid-pass, and a failing write neither storms nor floods the log", () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-5161-cursor-throttle-"));
  try {
    const persistPath = ingestBatchResumeCursorPath(dir);
    // Pinned clock, not the wall clock: the throttle boundary is the behavior
    // under test, so it is driven rather than waited on.
    let clock = 1_000_000;
    const cursors = new BatchResumeCursors({ persistPath, now: () => clock });
    cursors.noteImported(OPENCODE, STORE_SOURCE, "s1", FINGERPRINT_BEFORE_QUIT);
    assert.equal(
      new BatchResumeCursors({ persistPath }).isImported(
        OPENCODE,
        STORE_SOURCE,
        "s1",
        FINGERPRINT_BEFORE_QUIT
      ),
      false,
      "the hot path does not write on every session"
    );

    clock += 10_000;
    cursors.noteImported(OPENCODE, STORE_SOURCE, "s2", FINGERPRINT_BEFORE_QUIT);
    const afterInterval = new BatchResumeCursors({ persistPath });
    assert.equal(
      afterInterval.isImported(
        OPENCODE,
        STORE_SOURCE,
        "s1",
        FINGERPRINT_BEFORE_QUIT
      ),
      true,
      "once the interval elapses, a hard kill loses at most one interval of work"
    );

    // An unwritable path (the state dir is a FILE here) must not turn the
    // per-session hot path into a write storm, nor emit a line per session on the
    // monitored channel.
    const blocker = join(dir, "blocked");
    writeFileSync(blocker, "not a directory");
    let failClock = 5_000_000;
    const failures: string[] = [];
    const failing = new BatchResumeCursors({
      persistPath: join(blocker, "nested", "cursor.json"),
      log: (message) => failures.push(message),
      now: () => failClock,
    });
    for (let index = 0; index < 50; index += 1) {
      failClock += 10_000;
      failing.noteImported(
        OPENCODE,
        STORE_SOURCE,
        `s${index}`,
        FINGERPRINT_BEFORE_QUIT
      );
    }
    // Scoped to the FLUSH line: the same unwritable path also makes the initial
    // load fail with ENOTDIR, which ISS-5161 (wongk review) now reports as its
    // own once-per-instance "unreadable" line rather than swallowing it.
    const flushFailures = failures.filter((message) =>
      message.includes("flush failed")
    );
    assert.equal(
      flushFailures.length,
      1,
      `a persistently failing flush reports once, not once per session: ${flushFailures.length} lines of ${JSON.stringify(failures)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-5161: the persisted cursor is bounded on both axes", () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-5161-cursor-bounds-"));
  try {
    // Write-side: the per-source id set stops growing at the cap, degrading to a
    // replay of the tail rather than an unbounded map and an unbounded write.
    const cursors = new BatchResumeCursors();
    for (let index = 0; index < MAX_SESSION_IDS_PER_SOURCE; index += 1) {
      cursors.noteImported(
        OPENCODE,
        STORE_SOURCE,
        `s${index}`,
        FINGERPRINT_BEFORE_QUIT
      );
    }
    cursors.noteImported(
      OPENCODE,
      STORE_SOURCE,
      "over-the-cap",
      FINGERPRINT_BEFORE_QUIT
    );
    assert.equal(
      cursors.isImported(OPENCODE, STORE_SOURCE, "s0", FINGERPRINT_BEFORE_QUIT),
      true,
      "ids recorded below the cap keep fast-forwarding"
    );
    assert.equal(
      cursors.isImported(
        OPENCODE,
        STORE_SOURCE,
        "over-the-cap",
        FINGERPRINT_BEFORE_QUIT
      ),
      false,
      "past the cap the cursor stops growing and the session is simply re-read"
    );

    // Load-side: a file that accumulated orphaned source keys (a store deleted,
    // or a collector toggled off, before its source ever reached a terminal
    // outcome) cannot load without bound either. ISS-5161 (wongk review): the
    // cap now lives in the SCHEMA, so an over-cap file is rejected outright and
    // reported rather than silently truncated to an arbitrary 64-source subset.
    const persistPath = ingestBatchResumeCursorPath(dir);
    const overflowing: Record<string, unknown> = {};
    for (let index = 0; index < MAX_CURSOR_SOURCES + 25; index += 1) {
      overflowing[`opencode /store-${index}.db`] = {
        fingerprint: FINGERPRINT_BEFORE_QUIT,
        sessionIds: ["s1", "s2"],
      };
    }
    writeFileSync(
      persistPath,
      JSON.stringify({ version: 2, cursors: overflowing })
    );
    const reported: string[] = [];
    const loaded = new BatchResumeCursors({
      persistPath,
      log: (message) => reported.push(message),
    });
    assert.equal(
      loaded.size(),
      0,
      "an over-cap cursor file loads as no cursor, not as a truncated subset"
    );
    assert.equal(
      reported.some((message) => message.includes("invalid")),
      true,
      "the rejection is reported on the monitored channel"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("ISS-5161: an unreadable cursor file is reported, but a missing one is not", () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-5161-cursor-read-errors-"));
  try {
    // A missing file is the ordinary first launch — silent.
    const firstLaunchReports: string[] = [];
    const firstLaunch = new BatchResumeCursors({
      persistPath: ingestBatchResumeCursorPath(dir),
      log: (message) => firstLaunchReports.push(message),
    });
    assert.equal(firstLaunch.size(), 0);
    assert.deepEqual(
      firstLaunchReports,
      [],
      "a first launch with no cursor file reports nothing"
    );

    // A permission/IO error is NOT a first launch: it silently disables durable
    // resume, so it must reach the monitored logger. Simulated by pointing the
    // cursor at a DIRECTORY, so the read fails with EISDIR — a non-ENOENT
    // filesystem error — without needing to manufacture a permission mode that
    // a root-running CI container would ignore.
    mkdirSync(join(dir, "as-a-directory"), { recursive: true });
    const failedReports: string[] = [];
    const failed = new BatchResumeCursors({
      persistPath: join(dir, "as-a-directory"),
      log: (message) => failedReports.push(message),
    });
    assert.equal(failed.size(), 0, "an unreadable cursor loads as no cursor");
    assert.equal(
      failedReports.some((message) => message.includes("unreadable")),
      true,
      `a non-ENOENT read failure is reported, not swallowed as a first launch: ${JSON.stringify(failedReports)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-5161: an oversized cursor file is rejected before it is read", () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-5161-cursor-oversize-"));
  try {
    const persistPath = ingestBatchResumeCursorPath(dir);
    // One cursor entry plus padding that pushes the file past the byte ceiling.
    // The payload is otherwise perfectly VALID for the schema, so the only thing
    // that can reject it is the pre-read size check.
    writeFileSync(
      persistPath,
      JSON.stringify({
        version: 2,
        cursors: {
          [`${OPENCODE} ${join(dir, "opencode.db")}`]: {
            fingerprint: FINGERPRINT_BEFORE_QUIT,
            sessionIds: ["s1"],
          },
        },
        padding: "x".repeat(MAX_CURSOR_FILE_BYTES),
      })
    );
    const reported: string[] = [];
    const loaded = new BatchResumeCursors({
      persistPath,
      log: (message) => reported.push(message),
    });
    assert.equal(
      loaded.size(),
      0,
      "an oversized cursor file loads as no cursor"
    );
    assert.equal(
      reported.some((message) => message.includes("oversized")),
      true,
      `the size rejection is reported on the monitored channel: ${JSON.stringify(reported)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-5161: a stop() whose flush failed retains the tail so the write is still retried", () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-5161-cursor-clear-retry-"));
  try {
    // `stop()` is flush-then-clear, and the flush-failure path leaves `dirty` set
    // precisely so the write is RETRIED. Make that one write fail the way an
    // unwritable state dir does — the parent is a FILE, so `mkdirSync` throws
    // ENOTDIR — and the retry has to still have something left to write.
    const blocker = join(dir, "blocked");
    writeFileSync(blocker, "not a directory");
    const persistPath = join(blocker, "cursor.json");
    const failures: string[] = [];
    const cursors = new BatchResumeCursors({
      persistPath,
      log: (message) => failures.push(message),
    });
    cursors.noteImported(OPENCODE, STORE_SOURCE, "s1", FINGERPRINT_BEFORE_QUIT);
    cursors.flush();
    assert.equal(
      failures.filter((message) => message.includes("flush failed")).length,
      1,
      `the write must really have failed for this to exercise the retry path: ${JSON.stringify(failures)}`
    );

    cursors.clear();
    assert.equal(
      cursors.size(),
      1,
      "an unwritten tail must survive clear(), or the promised retry has nothing left to write"
    );

    // The obstruction goes away (a later `stop()`, or the import loop of an
    // in-process `start()`): the retained tail must still reach disk.
    rmSync(blocker, { force: true });
    cursors.flush();
    assert.equal(
      new BatchResumeCursors({ persistPath }).isImported(
        OPENCODE,
        STORE_SOURCE,
        "s1",
        FINGERPRINT_BEFORE_QUIT
      ),
      true,
      "the retried write carries the tail the failed flush was holding"
    );

    // A store with nothing outstanding still releases, so the fix cannot
    // degenerate into "clear() never clears". Deleting the file first is what
    // makes that observable: a released map re-loads from disk and finds nothing,
    // while a retained one would still serve the entry. (The memory-only arm —
    // no persistPath, so no write to retry — is pinned in
    // ingest-live-yield-starvation.test.ts.)
    cursors.clear();
    rmSync(persistPath, { force: true });
    assert.equal(
      cursors.size(),
      0,
      "once the write lands, clear() releases memory as before"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
