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
 * What is pinned here: round-trip and terminal-outcome cleanup, the fingerprint
 * gate that makes a persisted cursor honorable only while the store has not
 * moved, `clear()` releasing memory without discarding what is persisted,
 * corrupt / foreign-version / unreadable / oversized payloads all degrading to
 * "no cursor" (replay the prefix once) with the right reporting, the flush
 * throttle under a persistently failing write, and both collection bounds.
 *
 * ISS-9839 moved the medium from a JSON file to SQLite behind an injected port,
 * so these cases drive an in-memory stand-in for that port
 * (`batchResumeCursorMedium`) rather than a temp directory. That is a repair of
 * test MECHANICS: every expectation below is the one ISS-5161 established, and
 * none was weakened to accommodate the move. The cases that must prove the
 * cursor really reaches the SQLite table live in
 * `ingest-batch-resume-cursor-sqlite.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  BatchResumeCursors,
  MAX_CURSOR_PAYLOAD_BYTES,
  MAX_CURSOR_SOURCES,
  MAX_SESSION_IDS_PER_SOURCE,
  type PersistedBatchResumeCursors,
} from "../src/main/collectors/engine/collector-manager-batch-resume.js";
import { batchResumeCursorMedium } from "./helpers/batch-resume-cursor-fixtures.js";

const OPENCODE = "opencode";
const STORE_SOURCE = "/store.db";
const FINGERPRINT_BEFORE_QUIT = "opencode.db:1000:512";
const FINGERPRINT_AFTER_EDIT = "opencode.db:2000:640";
/**
 * The format version the current build writes, declared HERE rather than
 * imported from the module under test. A test that reads its expectation from
 * the constant it polices cannot fail when that constant moves or is deleted —
 * the duplication IS the test (mirrors `codex-collector-surface.test.ts`).
 */
const CURRENT_PERSIST_VERSION = 2;

test("ISS-5161: the cursor round-trips through the store and a completed source clears it", async () => {
  const medium = batchResumeCursorMedium();
  const writer = new BatchResumeCursors({ store: medium.port });
  await writer.noteImported(
    OPENCODE,
    STORE_SOURCE,
    "s1",
    FINGERPRINT_BEFORE_QUIT
  );
  await writer.noteImported(
    OPENCODE,
    STORE_SOURCE,
    "s2",
    FINGERPRINT_BEFORE_QUIT
  );
  await writer.flush();

  const reader = new BatchResumeCursors({ store: medium.port });
  const seen = (id: string) =>
    reader.isImported(OPENCODE, STORE_SOURCE, id, FINGERPRINT_BEFORE_QUIT);
  assert.equal(await seen("s1"), true);
  assert.equal(await seen("s2"), true);
  assert.equal(await seen("s3"), false);
  assert.equal(
    await reader.isImported(
      "claude",
      STORE_SOURCE,
      "s1",
      FINGERPRINT_BEFORE_QUIT
    ),
    false,
    "cursors do not leak across harnesses"
  );

  // A terminal outcome must clear the cursor in the DURABLE store too, not just
  // in memory: a stale cursor that outlived its source would make the retry skip
  // the very sessions it was scheduled to re-read.
  await reader.forget(OPENCODE, STORE_SOURCE);
  const afterForget = new BatchResumeCursors({ store: medium.port });
  assert.equal(
    await afterForget.isImported(
      OPENCODE,
      STORE_SOURCE,
      "s1",
      FINGERPRINT_BEFORE_QUIT
    ),
    false
  );
  assert.equal(await afterForget.size(), 0);
});

test("ISS-5161: a persisted cursor is honored only while the store fingerprint still matches", async () => {
  const medium = batchResumeCursorMedium();
  const writer = new BatchResumeCursors({ store: medium.port });
  await writer.noteImported(
    OPENCODE,
    STORE_SOURCE,
    "s1",
    FINGERPRINT_BEFORE_QUIT
  );
  await writer.flush();

  const moved = new BatchResumeCursors({ store: medium.port });
  assert.equal(
    await moved.isImported(
      OPENCODE,
      STORE_SOURCE,
      "s1",
      FINGERPRINT_AFTER_EDIT
    ),
    false,
    "a store that moved since the cursor was written must replay, not skip"
  );
  assert.equal(
    await moved.size(),
    0,
    "the invalidated entry is dropped rather than left to gate later sessions"
  );

  // ISS-5161 (review H2): an IN-MEMORY cursor is gated exactly the same way.
  // `markSourceImported` only refuses a move that happened AFTER this pass
  // captured its snapshot; a live-watcher import between two low-duty quanta
  // moves the store BEFORE the resumed quantum's own snapshot, so nothing is
  // left to refuse and an ungated fast-forward would seal the edit away.
  const live = new BatchResumeCursors();
  await live.noteImported(
    OPENCODE,
    STORE_SOURCE,
    "s1",
    FINGERPRINT_BEFORE_QUIT
  );
  assert.equal(
    await live.isImported(OPENCODE, STORE_SOURCE, "s1", FINGERPRINT_AFTER_EDIT),
    false,
    "an in-memory fast-forward must not survive the store moving under it"
  );
  assert.equal(
    await live.size(),
    0,
    "the invalidated in-memory entry is dropped, not left to gate later sessions"
  );
  // Re-recording under the moved fingerprint starts a FRESH entry, so the
  // replayed prefix is re-read rather than laundered into a cursor that now
  // claims to have been recorded under the new fingerprint.
  await live.noteImported(OPENCODE, STORE_SOURCE, "s2", FINGERPRINT_AFTER_EDIT);
  assert.equal(
    await live.isImported(OPENCODE, STORE_SOURCE, "s1", FINGERPRINT_AFTER_EDIT),
    false,
    "ids recorded before the move must not be revived by a later record"
  );
  assert.equal(
    await live.isImported(OPENCODE, STORE_SOURCE, "s2", FINGERPRINT_AFTER_EDIT),
    true,
    "ids recorded under the current fingerprint still fast-forward"
  );

  // A collector that exposes no fingerprint records `null`, which can never be
  // proven unmoved, so it is never honored from the persisted payload.
  const unfingerprintedMedium = batchResumeCursorMedium();
  const unfingerprinted = new BatchResumeCursors({
    store: unfingerprintedMedium.port,
  });
  await unfingerprinted.noteImported(OPENCODE, STORE_SOURCE, "s1", null);
  await unfingerprinted.flush();
  assert.equal(
    await new BatchResumeCursors({
      store: unfingerprintedMedium.port,
    }).isImported(OPENCODE, STORE_SOURCE, "s1", null),
    false
  );
});

test("ISS-5161: clear() releases memory without discarding the persisted cursor", async () => {
  const medium = batchResumeCursorMedium();
  const cursors = new BatchResumeCursors({ store: medium.port });
  await cursors.noteImported(
    OPENCODE,
    STORE_SOURCE,
    "s1",
    FINGERPRINT_BEFORE_QUIT
  );
  // The `stop()` sequence: flush, then release memory. The persisted copy is
  // what the next process resumes from, so `clear()` must not touch it.
  await cursors.flush();
  cursors.clear();

  assert.equal(
    await new BatchResumeCursors({ store: medium.port }).isImported(
      OPENCODE,
      STORE_SOURCE,
      "s1",
      FINGERPRINT_BEFORE_QUIT
    ),
    true,
    "a stopped process must leave its checkpoint behind for the next one"
  );
});

test("ISS-5161: a corrupt or foreign-version cursor is reported and degrades to no cursor", async () => {
  // This is unknown JSON at a persistence boundary: a truncated payload must
  // load as "no cursor" (replay the prefix once, which is correct) and never as
  // a partially-trusted cursor that could skip sessions it never imported.
  const truncatedMedium = batchResumeCursorMedium();
  truncatedMedium.payload = {
    version: CURRENT_PERSIST_VERSION,
    cursors: '{"opencode /store.db"',
  };
  const truncatedLines: string[] = [];
  const truncated = new BatchResumeCursors({
    store: truncatedMedium.port,
    log: (message) => truncatedLines.push(message),
  });
  assert.equal(
    await truncated.isImported(
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
  // shape is also the PREVIOUS format version's payload (a bare id array), so it
  // doubles as the "old build's cursor under the current version" case.
  const invalidMedium = batchResumeCursorMedium();
  invalidMedium.payload = {
    version: CURRENT_PERSIST_VERSION,
    cursors: '{"k":["s1"]}',
  };
  const invalidLines: string[] = [];
  const invalid = new BatchResumeCursors({
    store: invalidMedium.port,
    log: (message) => invalidLines.push(message),
  });
  assert.equal(
    await invalid.isImported(
      OPENCODE,
      STORE_SOURCE,
      "s1",
      FINGERPRINT_BEFORE_QUIT
    ),
    false
  );
  assert.equal(
    invalidLines.filter((line) => line.includes("invalid")).length,
    1
  );

  // A different format version is an expected upgrade, not corruption: the whole
  // store is discarded silently and costs one replayed prefix (ISS-9837 R3).
  const futureMedium = batchResumeCursorMedium();
  futureMedium.payload = {
    version: CURRENT_PERSIST_VERSION + 997,
    cursors: JSON.stringify({
      "opencode /store.db": {
        fingerprint: FINGERPRINT_BEFORE_QUIT,
        sessionIds: ["s1"],
      },
    }),
  };
  const futureLines: string[] = [];
  const future = new BatchResumeCursors({
    store: futureMedium.port,
    log: (message) => futureLines.push(message),
  });
  assert.equal(
    await future.isImported(
      OPENCODE,
      STORE_SOURCE,
      "s1",
      FINGERPRINT_BEFORE_QUIT
    ),
    false
  );
  assert.deepEqual(futureLines, []);
});

test("ISS-5161: the flush throttle persists mid-pass, and a failing write neither storms nor floods the log", async () => {
  const medium = batchResumeCursorMedium();
  // Pinned clock, not the wall clock: the throttle boundary is the behavior
  // under test, so it is driven rather than waited on.
  let clock = 1_000_000;
  const cursors = new BatchResumeCursors({
    store: medium.port,
    now: () => clock,
  });
  await cursors.noteImported(
    OPENCODE,
    STORE_SOURCE,
    "s1",
    FINGERPRINT_BEFORE_QUIT
  );
  assert.equal(
    await new BatchResumeCursors({ store: medium.port }).isImported(
      OPENCODE,
      STORE_SOURCE,
      "s1",
      FINGERPRINT_BEFORE_QUIT
    ),
    false,
    "the hot path does not write on every session"
  );

  clock += 10_000;
  await cursors.noteImported(
    OPENCODE,
    STORE_SOURCE,
    "s2",
    FINGERPRINT_BEFORE_QUIT
  );
  const afterInterval = new BatchResumeCursors({ store: medium.port });
  assert.equal(
    await afterInterval.isImported(
      OPENCODE,
      STORE_SOURCE,
      "s1",
      FINGERPRINT_BEFORE_QUIT
    ),
    true,
    "once the interval elapses, a hard kill loses at most one interval of work"
  );

  // An unwritable store must not turn the per-session hot path into a write
  // storm, nor emit a line per session on the monitored channel.
  const blockedMedium = batchResumeCursorMedium();
  blockedMedium.writeError = new Error("SQLITE_READONLY");
  let failClock = 5_000_000;
  const failures: string[] = [];
  const failing = new BatchResumeCursors({
    store: blockedMedium.port,
    log: (message) => failures.push(message),
    now: () => failClock,
  });
  for (let index = 0; index < 50; index += 1) {
    failClock += 10_000;
    await failing.noteImported(
      OPENCODE,
      STORE_SOURCE,
      `s${index}`,
      FINGERPRINT_BEFORE_QUIT
    );
  }
  const flushFailures = failures.filter((message) =>
    message.includes("flush failed")
  );
  assert.equal(
    flushFailures.length,
    1,
    `a persistently failing flush reports once, not once per session: ${flushFailures.length} lines of ${JSON.stringify(failures)}`
  );
});

test("ISS-5161: the persisted cursor is bounded on both axes", async () => {
  // Write-side: the per-source id set stops growing at the cap, degrading to a
  // replay of the tail rather than an unbounded map and an unbounded write.
  const cursors = new BatchResumeCursors();
  for (let index = 0; index < MAX_SESSION_IDS_PER_SOURCE; index += 1) {
    await cursors.noteImported(
      OPENCODE,
      STORE_SOURCE,
      `s${index}`,
      FINGERPRINT_BEFORE_QUIT
    );
  }
  await cursors.noteImported(
    OPENCODE,
    STORE_SOURCE,
    "over-the-cap",
    FINGERPRINT_BEFORE_QUIT
  );
  assert.equal(
    await cursors.isImported(
      OPENCODE,
      STORE_SOURCE,
      "s0",
      FINGERPRINT_BEFORE_QUIT
    ),
    true,
    "ids recorded below the cap keep fast-forwarding"
  );
  assert.equal(
    await cursors.isImported(
      OPENCODE,
      STORE_SOURCE,
      "over-the-cap",
      FINGERPRINT_BEFORE_QUIT
    ),
    false,
    "past the cap the cursor stops growing and the session is simply re-read"
  );

  // Load-side: a payload that accumulated orphaned source keys (a store deleted,
  // or a collector toggled off, before its source ever reached a terminal
  // outcome) cannot load without bound either. ISS-5161 (whitlockk review): the cap
  // lives in the SCHEMA, so an over-cap payload is rejected outright and
  // reported rather than silently truncated to an arbitrary 64-source subset.
  const overflowing: Record<string, unknown> = {};
  for (let index = 0; index < MAX_CURSOR_SOURCES + 25; index += 1) {
    overflowing[`opencode /store-${index}.db`] = {
      fingerprint: FINGERPRINT_BEFORE_QUIT,
      sessionIds: ["s1", "s2"],
    };
  }
  const medium = batchResumeCursorMedium();
  medium.payload = {
    version: CURRENT_PERSIST_VERSION,
    cursors: JSON.stringify(overflowing),
  };
  const reported: string[] = [];
  const loaded = new BatchResumeCursors({
    store: medium.port,
    log: (message) => reported.push(message),
  });
  assert.equal(
    await loaded.size(),
    0,
    "an over-cap cursor loads as no cursor, not as a truncated subset"
  );
  assert.equal(
    reported.some((message) => message.includes("invalid")),
    true,
    "the rejection is reported on the monitored channel"
  );
});

test("ISS-5161: an unreadable cursor is reported, but an absent one is not", async () => {
  // Nothing persisted is the ordinary first launch — silent.
  const firstLaunchReports: string[] = [];
  const firstLaunch = new BatchResumeCursors({
    store: batchResumeCursorMedium().port,
    log: (message) => firstLaunchReports.push(message),
  });
  assert.equal(await firstLaunch.size(), 0);
  assert.deepEqual(
    firstLaunchReports,
    [],
    "a first launch with no persisted cursor reports nothing"
  );

  // A read that THROWS is NOT a first launch: it silently disables durable
  // resume, so it must reach the monitored logger. The port reports "nothing
  // persisted yet" as `null`, so the two can never be confused.
  const failedMedium = batchResumeCursorMedium();
  failedMedium.readError = new Error("SQLITE_IOERR");
  const failedReports: string[] = [];
  const failed = new BatchResumeCursors({
    store: failedMedium.port,
    log: (message) => failedReports.push(message),
  });
  assert.equal(
    await failed.size(),
    0,
    "an unreadable cursor loads as no cursor"
  );
  assert.equal(
    failedReports.some((message) => message.includes("unreadable")),
    true,
    `a read failure is reported, not swallowed as a first launch: ${JSON.stringify(failedReports)}`
  );
});

test("ISS-5161: an oversized cursor is rejected before it is read", async () => {
  const medium = batchResumeCursorMedium();
  // The size is measured on the payload the port reports, and the pre-read check
  // is the only thing that can reject this one — the content is never parsed.
  medium.payload = {
    version: CURRENT_PERSIST_VERSION,
    cursors: "x".repeat(MAX_CURSOR_PAYLOAD_BYTES + 1),
  };
  const reported: string[] = [];
  const loaded = new BatchResumeCursors({
    store: medium.port,
    log: (message) => reported.push(message),
  });
  assert.equal(
    await loaded.size(),
    0,
    "an oversized cursor loads as no cursor"
  );
  assert.equal(
    reported.some((message) => message.includes("oversized")),
    true,
    `the size rejection is reported on the monitored channel: ${JSON.stringify(reported)}`
  );
});

test("ISS-9839: an over-budget payload this module PRODUCED is never persisted", async () => {
  // davetho review: the read gate bounds what is MATERIALIZED, not what is
  // stored. The collection caps admit far more than the ceiling, so the module
  // can produce a payload the reader will refuse — and without a write gate it
  // is serialized, cloned across the db-host boundary and persisted first, only
  // to be discarded on the next launch.
  const medium = batchResumeCursorMedium();
  const reported: string[] = [];
  const cursors = new BatchResumeCursors({
    store: medium.port,
    log: (message) => reported.push(message),
  });
  const oversizedId = "s".repeat(MAX_CURSOR_PAYLOAD_BYTES);
  await cursors.noteImported(
    OPENCODE,
    STORE_SOURCE,
    oversizedId,
    FINGERPRINT_BEFORE_QUIT
  );
  await cursors.flush();

  // Snapshotted rather than asserted through `medium.payload` directly:
  // `assert.equal` narrows its first argument to the expected type, which would
  // leave the property typed `null` for the shrink assertions below.
  const afterOversizedFlush = medium.payload;
  assert.equal(
    afterOversizedFlush,
    null,
    "an over-budget payload is refused before the write, not persisted and then rejected on read"
  );
  assert.equal(
    reported.some((message) => message.includes("oversized")),
    true,
    `the refusal is reported on the monitored channel: ${JSON.stringify(reported)}`
  );
  // The pass itself stays correct — the degradation is a replayed prefix, never
  // a cursor that forgets what it imported.
  assert.equal(
    await cursors.isImported(
      OPENCODE,
      STORE_SOURCE,
      oversizedId,
      FINGERPRINT_BEFORE_QUIT
    ),
    true,
    "the refused write leaves the in-memory cursor intact"
  );

  // And the gate is not a permanent off-switch: `dirty` is retained, so once the
  // map shrinks back under the ceiling the very next flush writes it.
  await cursors.noteImported(
    OPENCODE,
    "/second.db",
    "small",
    FINGERPRINT_BEFORE_QUIT
  );
  await cursors.forget(OPENCODE, STORE_SOURCE);
  const afterShrink = medium.payload;
  assert.notEqual(
    afterShrink,
    null,
    "a payload back under the ceiling is written, so the refusal did not clear the pending flush"
  );
  assert.equal(
    afterShrink?.cursors.includes(oversizedId),
    false,
    "the written payload is the shrunk one"
  );
});

test("ISS-5161: a stop() whose flush failed retains the tail so the write is still retried", async () => {
  // `stop()` is flush-then-clear, and the flush-failure path leaves `dirty` set
  // precisely so the write is RETRIED. Make that one write fail the way an
  // unwritable store does, and the retry has to still have something left to
  // write.
  const medium = batchResumeCursorMedium();
  medium.writeError = new Error("SQLITE_READONLY");
  const failures: string[] = [];
  const cursors = new BatchResumeCursors({
    store: medium.port,
    log: (message) => failures.push(message),
  });
  await cursors.noteImported(
    OPENCODE,
    STORE_SOURCE,
    "s1",
    FINGERPRINT_BEFORE_QUIT
  );
  await cursors.flush();
  assert.equal(
    failures.filter((message) => message.includes("flush failed")).length,
    1,
    `the write must really have failed for this to exercise the retry path: ${JSON.stringify(failures)}`
  );

  cursors.clear();
  assert.equal(
    await cursors.size(),
    1,
    "an unwritten tail must survive clear(), or the promised retry has nothing left to write"
  );

  // The obstruction goes away (a later `stop()`, or the import loop of an
  // in-process `start()`): the retained tail must still reach the store.
  medium.writeError = null;
  await cursors.flush();
  assert.equal(
    await new BatchResumeCursors({ store: medium.port }).isImported(
      OPENCODE,
      STORE_SOURCE,
      "s1",
      FINGERPRINT_BEFORE_QUIT
    ),
    true,
    "the retried write carries the tail the failed flush was holding"
  );

  // A store with nothing outstanding still releases, so the fix cannot
  // degenerate into "clear() never clears". Discarding the persisted payload
  // first is what makes that observable: a released map re-loads and finds
  // nothing, while a retained one would still serve the entry. (The memory-only
  // arm — no store, so no write to retry — is pinned in
  // ingest-live-yield-starvation.test.ts.)
  cursors.clear();
  medium.payload = null;
  assert.equal(
    await cursors.size(),
    0,
    "once the write lands, clear() releases memory as before"
  );
});

test("ISS-9837 C3: a failed write ADVANCES the throttle, so an unwritable store is not a per-session write storm", async () => {
  // The sibling case above pins the once-per-instance log. This one pins the
  // other half of C3, which that case cannot see: on failure `lastFlushAt` is
  // advanced anyway. Without it `flushIfDue` is true for EVERY subsequent
  // session, so an unwritable store turns the import hot path into one write
  // attempt per session (ISS-5161 review H2). The clock is held STILL after the
  // first flush comes due, so the only thing that can make a second attempt due
  // is the throttle failing to advance.
  const medium = batchResumeCursorMedium();
  medium.writeError = new Error("SQLITE_READONLY");
  let attempts = 0;
  let clock = 1_000_000;
  const counting = {
    byteLength: () => medium.port.byteLength(),
    read: () => medium.port.read(),
    write: (payload: PersistedBatchResumeCursors) => {
      attempts += 1;
      return medium.port.write(payload);
    },
  };
  const cursors = new BatchResumeCursors({ store: counting, now: () => clock });
  await cursors.noteImported(
    OPENCODE,
    STORE_SOURCE,
    "s0",
    FINGERPRINT_BEFORE_QUIT
  );
  // One step past the interval brings the first flush due; every later session
  // sees the same instant.
  clock += 10_000;
  for (let index = 1; index <= 50; index += 1) {
    await cursors.noteImported(
      OPENCODE,
      STORE_SOURCE,
      `s${index}`,
      FINGERPRINT_BEFORE_QUIT
    );
  }
  assert.equal(
    attempts,
    1,
    `a failing write must not be retried once per session: ${attempts} attempts for 50 sessions`
  );
  assert.equal(
    await cursors.size(),
    1,
    "the failed write keeps its entry, so the retry still has something to write"
  );
});
