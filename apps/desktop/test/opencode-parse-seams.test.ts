/**
 * @file opencode-parse-seams.test.ts
 * @description ISS-5238: the OpenCode parse path's failed-read seams. Every case
 * here is one instance of the same defect class — a FAILED read rendered as a
 * legitimate empty/absent value, which then resolves normally so
 * `markSourceImported` advances the DB fingerprint and the wrong result freezes
 * until the store's mtime/size moves again.
 *
 * The SQLite/parse ingest boundary is a TRUST boundary, so malformed and
 * transient-failure input there is reachable at runtime and is exercised with
 * real `node:sqlite` errors raised by real fixture databases, not with hand-built
 * error objects. Fixtures are deterministic (fixed epoch timestamps) per the
 * `test:node` determinism rule.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { parseOpenCodeTranscript } from "@repo/lib/harness/opencode/parse-opencode";
import { InvalidTokenCountError } from "@repo/lib/harness/token-counts";
import { createOpencodeCollector } from "../src/main/collectors/opencode/opencode-collector.js";
import { resolveOpencodeDiffStats } from "../src/main/collectors/opencode/opencode-diff-stats.js";
import {
  classifyOpencodeParseFailure,
  describeOpencodeCell,
  describeOpencodeParseFailure,
  OpencodeParseFailureKind,
  opencodeParseFailureAbortsLoad,
  resolveSummaryColumnProbeFailure,
} from "../src/main/collectors/opencode/opencode-parse-failure.js";
import { loadOpencodeSessionsFromDb } from "../src/main/collectors/opencode/opencode-parser.js";
import { serializeSessionToJsonl } from "../src/main/transcript-sync/opencode-materializer.js";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";

afterEach(cleanupTempDirs);

/** The message a real cross-connection `SQLITE_BUSY` carries. */
const DATABASE_LOCKED_RE = /database is locked/;
/** The refusal the collector reports when the session store could not be read. */
const STORE_UNREADABLE_RE = /session store unreadable/;
/** The message a real `SQLITE_NOTADB` whole-database verdict carries. */
const NOT_A_DATABASE_RE = /file is not a database/;

const TIME_CREATED = 1_710_000_000_000;
const TIME_UPDATED = 1_710_000_060_000;

/**
 * Size of the fixture BLOB written into a `summary_*` column. Large enough that
 * a comma-joined `String(uint8Array)` preview would be unmistakable in the log
 * (and pointless to build), small enough to keep the fixture DB cheap.
 */
const BLOB_SUMMARY_BYTES = 4096;

/**
 * `opencode.db` with `parent_id` and the optional `summary_*` columns. The
 * `message` table is created under a private name and exposed through a VIEW so
 * a fixture can make ONE session's message read fail inside SQLite itself (see
 * `withRowScopedSqliteFailure`) — the rest of the schema is the real one.
 */
const SCHEMA_DDL = `
  CREATE TABLE session (
    id TEXT PRIMARY KEY, parent_id TEXT, slug TEXT, directory TEXT NOT NULL,
    title TEXT NOT NULL, version TEXT NOT NULL, agent TEXT, model TEXT,
    permission TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
    tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL,
    tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
    tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
    summary_additions, summary_deletions, summary_files, summary_diffs
  );
  CREATE TABLE message_store (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL, data TEXT NOT NULL
  );
  CREATE TABLE part (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
  );
  CREATE VIEW message AS SELECT * FROM message_store;
`;

type SessionSpec = {
  id: string;
  parentId?: string | null;
  tokensInput?: number;
  summaryAdditions?: unknown;
  summaryDeletions?: unknown;
  summaryFiles?: unknown;
};

/** Insert one session plus a user turn and an assistant turn so it parses. */
function insertSession(db: DatabaseSync, spec: SessionSpec): void {
  db.prepare(`
    INSERT INTO session (
      id, parent_id, slug, directory, title, version, agent, model, permission,
      time_created, time_updated, tokens_input, tokens_output,
      tokens_reasoning, tokens_cache_read, tokens_cache_write,
      summary_additions, summary_deletions, summary_files, summary_diffs
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    spec.id,
    spec.parentId ?? null,
    `slug-${spec.id}`,
    "/workspace/my-project",
    `Title ${spec.id}`,
    "1.15.5",
    "build",
    JSON.stringify({ id: "oc-model", providerID: "opencode" }),
    "",
    TIME_CREATED,
    TIME_UPDATED,
    spec.tokensInput ?? 10,
    0,
    0,
    0,
    0,
    (spec.summaryAdditions ?? 0) as string,
    (spec.summaryDeletions ?? 0) as string,
    (spec.summaryFiles ?? 0) as string,
    null
  );
  const insertMessage = db.prepare(
    "INSERT INTO message_store (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
  );
  insertMessage.run(
    `${spec.id}-msg-user`,
    spec.id,
    TIME_CREATED,
    TIME_CREATED,
    JSON.stringify({ role: "user", time: { created: TIME_CREATED } })
  );
  insertMessage.run(
    `${spec.id}-msg-assistant`,
    spec.id,
    TIME_CREATED + 30_000,
    TIME_CREATED + 30_000,
    JSON.stringify({
      role: "assistant",
      time: { created: TIME_CREATED + 30_000 },
    })
  );
}

/** Build an `opencode.db` at `dir` holding `specs`, returning its path. */
function writeDb(dir: string, specs: SessionSpec[]): string {
  const dbPath = path.join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_DDL);
  for (const spec of specs) {
    insertSession(db, spec);
  }
  db.close();
  return dbPath;
}

/**
 * Redefine the `message` view so reading `sessionId`'s messages raises a REAL,
 * DURABLE `ERR_SQLITE_ERROR` (`errcode` 1, "integer overflow") at
 * statement-execution time, while every other session reads normally. This is a
 * row-scoped SQLite failure that will throw identically on every tick, so
 * `parseSessionRowSafely` must DROP that session rather than wedge the corpus.
 */
function withRowScopedSqliteFailure(dbPath: string, sessionId: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec("DROP VIEW message");
  db.exec(`
    CREATE VIEW message AS SELECT id, session_id,
      CASE WHEN session_id = '${sessionId}'
        THEN abs(-9223372036854775808) ELSE time_created END AS time_created,
      time_updated, data
    FROM message_store
  `);
  db.close();
}

/**
 * Hold a REAL `EXCLUSIVE` lock on `dbPath` from a second connection, so any read
 * on another connection gets a genuine `SQLITE_BUSY` (`errcode` 5) once its
 * `busy_timeout` elapses. Returns the disposer.
 */
function withExclusiveLock(dbPath: string): () => void {
  const locker = new DatabaseSync(dbPath);
  locker.exec("PRAGMA busy_timeout = 0");
  locker.exec("BEGIN EXCLUSIVE");
  locker.exec("UPDATE session SET title = 'locked' WHERE id = 'ses_ok'");
  return () => {
    locker.exec("ROLLBACK");
    locker.close();
  };
}

/** Run `read` against `dbPath` and return the error it raised, or `null`. */
function captureSqliteError(dbPath: string, read: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 50");
    read(db);
    return null;
  } catch (error) {
    return error;
  } finally {
    db.close();
  }
}

test("ISS-5238 F1: the classifier splits RETRYABLE SQLite codes from durable ones, on real node:sqlite errors", () => {
  const dir = makeTempDir("opencode-parse-seams-");
  const dbPath = writeDb(dir, [{ id: "ses_ok" }]);
  const release = withExclusiveLock(dbPath);
  const busyError = captureSqliteError(dbPath, (db) => {
    db.prepare("SELECT * FROM session").all();
  });
  release();
  const durableError = captureSqliteError(dbPath, (db) => {
    db.prepare("SELECT * FROM no_such_table").all();
  });

  assert.ok(busyError, "captured a real SQLITE_BUSY");
  assert.equal(
    classifyOpencodeParseFailure(busyError),
    OpencodeParseFailureKind.StoreUnreadable,
    "a lock we waited out may well clear by the next tick — retry, never freeze a short read in"
  );
  assert.ok(durableError, "captured a real durable SQLite error");
  assert.equal(
    classifyOpencodeParseFailure(durableError),
    OpencodeParseFailureKind.MalformedRow,
    "a durable SQLite error will throw identically forever; rethrowing it would wedge the whole corpus, since a batch collector's throw is never marked seen"
  );
  assert.equal(
    classifyOpencodeParseFailure(
      new InvalidTokenCountError("opencode.session.input")
    ),
    OpencodeParseFailureKind.MalformedRow,
    "a corrupt token counter is a durable property of the data"
  );
});

test("ISS-5238 F1: a locked store THROWS instead of resolving to an empty list", {
  timeout: 30_000,
}, () => {
  const dir = makeTempDir("opencode-parse-seams-");
  const dbPath = writeDb(dir, [{ id: "ses_ok" }]);
  const release = withExclusiveLock(dbPath);
  try {
    assert.throws(
      () => loadOpencodeSessionsFromDb(dbPath),
      DATABASE_LOCKED_RE,
      "the batch must not resolve while the store was merely locked — resolving is what lets markSourceImported advance the fingerprint and freeze the gap in"
    );
  } finally {
    release();
  }
});

test("ISS-5238 F1: the collector REJECTS the tick on a locked store and reports it on the monitored channel", {
  timeout: 30_000,
}, async () => {
  const dir = makeTempDir("opencode-parse-seams-");
  const dbPath = writeDb(dir, [{ id: "ses_ok" }]);
  const logs: string[] = [];
  const collector = createOpencodeCollector({
    dataDir: dir,
    fingerprintPath: path.join(dir, "fingerprint.txt"),
    log: (message) => logs.push(message),
  });
  const release = withExclusiveLock(dbPath);
  try {
    await assert.rejects(
      () => collector.parse(dbPath),
      STORE_UNREADABLE_RE,
      "a rejected parse leaves the batch collector unmarked, so the next tick retries"
    );
  } finally {
    release();
  }
  assert.ok(
    logs.some((message) =>
      message.startsWith("collector opencode import failed:")
    ),
    "reported on the monitored collector-import-failed channel"
  );
});

test("ISS-5238 F1: a RETRYABLE failure at the ROW boundary rethrows instead of dropping that session", () => {
  const dir = makeTempDir("opencode-parse-seams-");
  const dbPath = writeDb(dir, [{ id: "ses_ok" }, { id: "ses_busy" }]);
  // A REAL cross-connection SQLITE_BUSY, captured once and re-raised from the
  // per-session read — the row boundary a live lock cannot be scheduled onto.
  const release = withExclusiveLock(dbPath);
  const busyError = captureSqliteError(dbPath, (db) => {
    db.prepare("SELECT * FROM session").all();
  });
  release();
  assert.ok(busyError, "captured a real SQLITE_BUSY");

  assert.throws(
    () =>
      loadOpencodeSessionsFromDb(dbPath, {
        wrapRowReaders: (readers) => ({
          ...readers,
          readMessages: (sessionId) => {
            if (sessionId === "ses_busy") {
              throw busyError;
            }
            return readers.readMessages(sessionId);
          },
        }),
      }),
    DATABASE_LOCKED_RE,
    "a row we could not read THIS tick must abort the batch — dropping it resolves the parse, which advances the fingerprint and freezes the gap in until the DB's mtime/size moves"
  );
});

test("ISS-5238 F1: a DURABLE row-scoped SQLite failure drops that session instead of wedging the corpus", () => {
  const dir = makeTempDir("opencode-parse-seams-");
  const dbPath = writeDb(dir, [{ id: "ses_ok" }, { id: "ses_durable" }]);
  withRowScopedSqliteFailure(dbPath, "ses_durable");
  const load = loadOpencodeSessionsFromDb(dbPath);
  assert.deepEqual(
    load.sessions.map((session) => session.sessionId),
    ["opencode-ses_ok"],
    "the healthy sibling still imports — a permanently-bad row must never block the whole store"
  );
  assert.deepEqual(
    load.droppedSessions.map((dropped) => dropped.sessionId),
    ["ses_durable"],
    "and the drop is recorded rather than rendered as a legitimate absence"
  );
});

test("ISS-5238 F1: a malformed row is dropped, reported, and does NOT block its healthy siblings", () => {
  const dir = makeTempDir("opencode-parse-seams-");
  // A negative token counter makes `readStorageTokenCount` throw
  // `InvalidTokenCountError` inside `buildTokensByModel` for this row only.
  const dbPath = writeDb(dir, [
    { id: "ses_ok" },
    { id: "ses_bad", tokensInput: -5 },
  ]);
  const logs: string[] = [];
  const load = loadOpencodeSessionsFromDb(dbPath, {
    log: (message) => logs.push(message),
  });
  assert.deepEqual(
    load.sessions.map((session) => session.sessionId),
    ["opencode-ses_ok"],
    "the healthy sibling still imports — one bad row must not wedge the corpus"
  );
  assert.deepEqual(
    load.droppedSessions.map((dropped) => dropped.sessionId),
    ["ses_bad"],
    "the drop is REPORTED rather than rendered as a legitimate absence"
  );
  assert.ok(
    logs.some(
      (message) =>
        message.startsWith("collector opencode import failed:") &&
        message.includes("ses_bad") &&
        message.includes(dbPath)
    ),
    "named on the monitored channel, with the store the value came from"
  );
});

test("ISS-5238 F2: a dropped parent's subagents are WITHHELD, not re-flattened to top level", async () => {
  const dir = makeTempDir("opencode-parse-seams-");
  const dbPath = writeDb(dir, [
    { id: "ses_root", tokensInput: -5 },
    { id: "ses_child", parentId: "ses_root" },
  ]);
  const logs: string[] = [];
  const collector = createOpencodeCollector({
    dataDir: dir,
    fingerprintPath: path.join(dir, "fingerprint.txt"),
    log: (message) => logs.push(message),
  });
  const sessions = await collector.parse(dbPath);
  assert.deepEqual(
    sessions.map((session) => session.sessionId),
    [],
    "the child is not published as its own top-level session — that is the ISS-4649 outcome through a different door, and it sticks the same way"
  );
  assert.ok(
    logs.some((message) => message.includes("withheld 1 subagent session")),
    "the withheld child is reported on the monitored channel"
  );
});

test("ISS-5238 F2: a child whose root legitimately held no messages IS still re-emitted", async () => {
  const dir = makeTempDir("opencode-parse-seams-");
  const dbPath = writeDb(dir, [{ id: "ses_child", parentId: "ses_root" }]);
  // The root row exists in `session` (so the linkage names it) but has no
  // messages, which the parser drops legitimately — the pre-ISS-5238 re-emit
  // must survive for that case.
  const db = new DatabaseSync(dbPath);
  db.prepare(`
    INSERT INTO session (
      id, parent_id, slug, directory, title, version, agent, model, permission,
      time_created, time_updated, tokens_input, tokens_output,
      tokens_reasoning, tokens_cache_read, tokens_cache_write,
      summary_additions, summary_deletions, summary_files, summary_diffs
    ) VALUES ('ses_root', NULL, 'slug', '/w/p', 't', '1', 'build', NULL, '',
      ${TIME_CREATED}, ${TIME_UPDATED}, 0, 0, 0, 0, 0, 0, 0, 0, NULL)
  `).run();
  db.close();
  const collector = createOpencodeCollector({
    dataDir: dir,
    fingerprintPath: path.join(dir, "fingerprint.txt"),
  });
  const sessions = await collector.parse(dbPath);
  assert.deepEqual(
    sessions.map((session) => session.sessionId),
    ["opencode-ses_child"],
    "no session vanishes when the root was absent for a legitimate reason"
  );
});

test("ISS-5238 F5: a non-numeric summary column never becomes a NaN diffStat", () => {
  const dir = makeTempDir("opencode-parse-seams-");
  const dbPath = writeDb(dir, [
    { id: "ses_nan", summaryAdditions: "not-a-number", summaryFiles: 2 },
  ]);
  const logs: string[] = [];
  const [session] = loadOpencodeSessionsFromDb(dbPath, {
    log: (message) => logs.push(message),
  }).sessions;
  assert.ok(session, "the session still imports");
  assert.equal(
    session.diffStats,
    null,
    "the summary columns are refused wholesale rather than half-trusted"
  );
  assert.ok(
    logs.some(
      (message) =>
        message.includes("summary_additions") && message.includes("ses_nan")
    ),
    "the unusable column is reported on the monitored channel, naming the session"
  );
});

test("ISS-5238 F5: a negative summary column never becomes a negative diffStat", () => {
  const dir = makeTempDir("opencode-parse-seams-");
  const dbPath = writeDb(dir, [
    { id: "ses_neg", summaryAdditions: -3, summaryFiles: 1 },
  ]);
  const [session] = loadOpencodeSessionsFromDb(dbPath).sessions;
  assert.ok(session);
  assert.equal(
    session.diffStats,
    null,
    "counts floor at 0 — a negative cell is not a count"
  );
});

test("ISS-5238 F5: valid summary columns are unchanged", () => {
  const dir = makeTempDir("opencode-parse-seams-");
  const dbPath = writeDb(dir, [
    {
      id: "ses_good",
      summaryAdditions: 12,
      summaryDeletions: 3,
      summaryFiles: 2,
    },
  ]);
  const [session] = loadOpencodeSessionsFromDb(dbPath).sessions;
  assert.deepEqual(session?.diffStats, {
    filesChanged: 2,
    linesAdded: 12,
    linesRemoved: 3,
  });
});

test("ISS-5238 F5: a session with an unusable summary column still round-trips through the CLOUD reader", async () => {
  const dir = makeTempDir("opencode-parse-seams-");
  const dbPath = writeDb(dir, [
    { id: "ses_nan", summaryAdditions: "not-a-number", summaryFiles: 2 },
  ]);
  const [session] = loadOpencodeSessionsFromDb(dbPath).sessions;
  assert.ok(session);
  // End-to-end: a `NaN` here serializes as `null`, the cloud's `diffStatsSchema`
  // (`z.number()`) rejects the session HEADER line, and `parse-opencode.ts`
  // discards the ENTIRE session — every valid message/tool/token line with it —
  // while the desktop write "succeeded" so the materializer fingerprint advanced
  // and the projection froze in a state the cloud can never render.
  const parsed = await parseOpenCodeTranscript(
    serializeSessionToJsonl(session).trimEnd().split("\n")
  );
  assert.equal(
    parsed?.sessionId,
    "opencode-ses_nan",
    "the cloud reader accepts the session instead of discarding it wholesale"
  );
});

test("ISS-5238 F5: a BLOB summary column is described by byteLength, never stringified", () => {
  const dir = makeTempDir("opencode-parse-seams-");
  // A real BLOB in a `summary_*` column. `node:sqlite` hands this back as a
  // `Uint8Array`, and the diagnostic must describe it WITHOUT materializing it:
  // `String(uint8Array)` builds a comma-joined decimal string several times the
  // blob's size, which on a multi-megabyte cell throws `RangeError: Invalid
  // string length` inside the `report` callback — a throw that escapes into
  // `parseSessionRowSafely`, classifies as MalformedRow, and drops a session
  // whose only problem was an odd column type.
  const blob = new Uint8Array(BLOB_SUMMARY_BYTES);
  const dbPath = writeDb(dir, [
    { id: "ses_blob", summaryAdditions: blob, summaryFiles: 2 },
  ]);
  const logs: string[] = [];
  const load = loadOpencodeSessionsFromDb(dbPath, {
    log: (message) => logs.push(message),
  });
  const [session] = load.sessions;
  assert.ok(session, "the session still imports rather than being dropped");
  assert.deepEqual(
    load.droppedSessions,
    [],
    "an odd column type is not a malformed row"
  );
  assert.equal(
    session.diffStats,
    null,
    "the summary columns are refused wholesale rather than half-trusted"
  );
  assert.ok(
    logs.some((message) =>
      message.includes(`Uint8Array ${BLOB_SUMMARY_BYTES} bytes`)
    ),
    "the diagnostic names the blob by byteLength instead of quoting its contents"
  );
  assert.ok(
    !logs.some((message) => message.includes("0,0,0,0")),
    "and no comma-joined byte preview leaks into the log"
  );
});

test("ISS-5238: a FAILED summary-column probe is not reported as a legacy schema", () => {
  const dir = makeTempDir("opencode-parse-seams-");
  const dbPath = writeDb(dir, [{ id: "ses_ok" }]);
  const release = withExclusiveLock(dbPath);
  const busyError = captureSqliteError(dbPath, (db) => {
    db.prepare("PRAGMA table_info(session)").all();
  });
  release();
  const durableError = captureSqliteError(dbPath, (db) => {
    db.prepare("PRAGMA table_info(session)").all();
    db.prepare("SELECT * FROM no_such_table").all();
  });
  assert.ok(busyError, "captured a real SQLITE_BUSY from the schema probe");
  assert.ok(durableError, "captured a real durable SQLite error");

  // A transient lock may well clear before the following SELECT. Answering
  // `false` would drop every summary-derived diff stat for the WHOLE store while
  // the load still resolves, so `markSourceImported` advances the fingerprint and
  // the loss freezes in until the DB's mtime/size moves again.
  const retryableLogs: string[] = [];
  assert.throws(
    () =>
      resolveSummaryColumnProbeFailure(busyError, (message) =>
        retryableLogs.push(message)
      ),
    DATABASE_LOCKED_RE,
    "a retryable probe failure rethrows so the batch load rejects and the tick is retried"
  );
  assert.deepEqual(
    retryableLogs,
    [],
    "and it is not passed off as a legacy schema on the way out"
  );

  // A durable failure WILL fail identically on every tick, and a batch
  // collector's throw is never marked seen — rethrowing would wedge the corpus.
  const durableLogs: string[] = [];
  assert.equal(
    resolveSummaryColumnProbeFailure(durableError, (message) =>
      durableLogs.push(message)
    ),
    false,
    "a durable probe failure falls back to the legacy shape rather than wedging the corpus"
  );
  assert.ok(
    durableLogs.some(
      (message) =>
        message.includes("summary-column probe failed durably") &&
        message.includes("summary_* diff stats are unavailable")
    ),
    "and the degraded state is reported on the monitored channel, not silently assumed"
  );
});

test("ISS-5238: a WHOLE-DATABASE corruption verdict aborts the load instead of dropping one session", () => {
  const dir = makeTempDir("opencode-parse-seams-");
  const dbPath = writeDb(dir, [{ id: "ses_ok" }, { id: "ses_corrupt" }]);
  // A REAL `SQLITE_NOTADB` (errcode 26), raised by pointing `node:sqlite` at a
  // file that is not a database at all. Captured once, then re-raised from the
  // per-session read — the message/part boundary wongk described.
  const notADbPath = path.join(dir, "not-a-database.db");
  writeFileSync(notADbPath, "this file is emphatically not a SQLite database");
  const corruptError = captureSqliteError(notADbPath, (db) => {
    db.prepare("SELECT * FROM session").all();
  });
  assert.ok(corruptError, "captured a real whole-database SQLite verdict");
  assert.equal(
    classifyOpencodeParseFailure(corruptError),
    OpencodeParseFailureKind.StoreCorrupt,
    "SQLITE_NOTADB is a verdict on the database, not on one row"
  );

  assert.throws(
    () =>
      loadOpencodeSessionsFromDb(dbPath, {
        wrapRowReaders: (readers) => ({
          ...readers,
          readMessages: (sessionId) => {
            if (sessionId === "ses_corrupt") {
              throw corruptError;
            }
            return readers.readMessages(sessionId);
          },
        }),
      }),
    NOT_A_DATABASE_RE,
    "importing ses_ok and checkpointing over a store SQLite declared malformed would present a partial corpus as a complete one"
  );
});

test("ISS-5238: a locked store's schema probe rejects the whole load", () => {
  const dir = makeTempDir("opencode-parse-seams-");
  const dbPath = writeDb(dir, [{ id: "ses_ok" }]);
  const release = withExclusiveLock(dbPath);
  try {
    // Production wiring: `hasSummaryColumns` runs before the session SELECT, so
    // this proves the probe's failure reaches the load's caller rather than
    // being absorbed into a `false`.
    assert.throws(
      () => loadOpencodeSessionsFromDb(dbPath),
      DATABASE_LOCKED_RE,
      "the load rejects instead of resolving with summary stats silently dropped"
    );
  } finally {
    release();
  }
});

/**
 * A failure kind this build does not know, typed as a bare `string` so reaching
 * the exhaustive `default` needs one narrowing assertion rather than a double
 * cast. Only a version-skewed peer can produce it.
 */
const FUTURE_FAILURE_KIND: string = "someKindThisBuildDoesNotKnow";

/** No patch parts accumulated — the fallback source has nothing to offer. */
const ZERO_PATCH_TOTALS = { added: 0, removed: 0, filesChanged: 0 };

/**
 * A two-file unified diff: 3 added lines, 2 removed, 2 file headers. The `+++`
 * and `--- ` header lines are deliberately present, because the delta reader
 * must exclude them from the line counts while the file counter reads them.
 */
const SUMMARY_DIFF_TEXT = [
  "--- a/src/one.ts",
  "+++ b/src/one.ts",
  "@@ -1,2 +1,3 @@",
  "-const a = 1;",
  "+const a = 2;",
  "+const b = 3;",
  "--- a/docs/two.md",
  "+++ b/docs/two.md",
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n");

// ─── The classifier's own edges (ISS-5302) ───────────────────────────────────
// `classifyOpencodeParseFailure` takes `unknown` at a real catch boundary, so a
// throw carrying no SQLite shape at all is reachable and must land somewhere
// deliberate rather than falling through a shape assumption.

test("ISS-5238: a throw carrying no node:sqlite shape at all is a ROW verdict, never a store one", () => {
  // A non-object throw (`throw "boom"`, a rejected non-Error) cannot be a SQLite
  // refusal: nothing about it says the store could not be served. Classifying it
  // as retryable would wedge the whole corpus behind one bad row forever, since
  // a batch collector's throw is never marked seen.
  assert.equal(
    classifyOpencodeParseFailure("boom"),
    OpencodeParseFailureKind.MalformedRow
  );
  assert.equal(
    classifyOpencodeParseFailure(null),
    OpencodeParseFailureKind.MalformedRow
  );
  // Same for an object whose `code` is the wrong TYPE — the schema refuses it
  // rather than reading a numeric `code` as the closed-handle sentinel.
  assert.equal(
    classifyOpencodeParseFailure({ code: 42 }),
    OpencodeParseFailureKind.MalformedRow
  );
  assert.equal(
    opencodeParseFailureAbortsLoad(classifyOpencodeParseFailure("boom")),
    false,
    "so it drops one session instead of aborting the batch"
  );
});

test("ISS-5238: the drop reason describes a non-Error throw instead of going blank", () => {
  // This string is the `droppedSessions[].reason` and the monitored
  // `collector opencode import failed: …` line. An empty or `undefined` reason
  // makes a real drop indistinguishable from a clean load in the log.
  assert.equal(
    describeOpencodeParseFailure(new Error("real error")),
    "real error"
  );
  assert.equal(describeOpencodeParseFailure("thrown string"), "thrown string");
  assert.equal(describeOpencodeParseFailure(404), "404");
});

test("ISS-5238: a foreign object cell is previewed WITHOUT invoking its own toString", () => {
  // The preview runs inside `resolveOpencodeDiffStats`'s `report` callback,
  // which is called from `parseSessionRow` — so a throw from the diagnostic
  // itself would escape into `parseSessionRowSafely` and drop a session whose
  // only sin was an odd column type. `Object.prototype.toString` is bounded and
  // total; the cell's own is neither.
  const hostile = {
    toString() {
      throw new Error("a foreign toString must never be called");
    },
  };
  assert.equal(describeOpencodeCell(hostile), "object [object Object]");
  assert.equal(describeOpencodeCell([1, 2, 3]), "object [object Array]");
  // `null` is NOT an object here — it takes the primitive branch, so the
  // preview still names the type a reader can act on.
  assert.equal(describeOpencodeCell(null), 'object "null"');
});

test("ISS-5238: an unrecognized failure kind aborts the load rather than silently dropping a session", () => {
  // The `switch` is exhaustive at compile time (`const exhaustive: never`), so
  // this is only reachable across a version skew — a kind persisted or produced
  // by a build that knows a member this one does not. The fallback direction is
  // what matters: TRUTHY means abort (leave the fingerprint unadvanced and
  // retry), which is the safe side. NOTE (ISS-5302): the declared return type is
  // `boolean` but the default arm returns the kind VALUE, so this asserts
  // truthiness rather than `=== true`.
  const verdict = opencodeParseFailureAbortsLoad(
    FUTURE_FAILURE_KIND as OpencodeParseFailureKind
  );
  assert.ok(
    verdict,
    "an unknown kind must abort the load, never drop a session on a verdict this build cannot read"
  );
  assert.notEqual(verdict, false);
});

// ─── Aggregate diffStats resolution (ISS-5302) ───────────────────────────────
// `resolveOpencodeDiffStats` is reached transitively through the parser above;
// these drive it directly because a fixture DB cannot vary the summary/patch
// combinations independently of everything else the row carries.

test("ISS-5238: a BLANK summary cell is a legitimate empty, not a corrupt one", () => {
  // `""` and `"   "` both read as 0 with NOTHING reported. Treating whitespace
  // as corrupt would report the monitored channel on ordinary empty stores and
  // discard the whole summary triple for them.
  const messages: string[] = [];
  const stats = resolveOpencodeDiffStats(
    {
      summary_additions: "   ",
      summary_deletions: "",
      summary_files: 0,
      summary_diffs: null,
    },
    true,
    ZERO_PATCH_TOTALS,
    (message) => messages.push(message)
  );

  assert.equal(
    stats,
    null,
    "an empty summary is an ABSENT diff, never a fabricated zero triple"
  );
  assert.deepEqual(
    messages,
    [],
    "a blank cell is not reported as 'not a non-negative integer'"
  );
});

test("ISS-5238: summary_diffs fills only the columns that are zeroed out", () => {
  const messages: string[] = [];
  const report = (message: string) => messages.push(message);

  // Columns all zero → the unified diff supplies all three figures.
  assert.deepEqual(
    resolveOpencodeDiffStats(
      {
        summary_additions: 0,
        summary_deletions: 0,
        summary_files: 0,
        summary_diffs: SUMMARY_DIFF_TEXT,
      },
      true,
      ZERO_PATCH_TOTALS,
      report
    ),
    { filesChanged: 2, linesAdded: 3, linesRemoved: 2 }
  );

  // Columns carrying data stay AUTHORITATIVE — the diff text does not overwrite
  // them, so a truncated `summary_diffs` cannot shrink a real count.
  assert.deepEqual(
    resolveOpencodeDiffStats(
      {
        summary_additions: 10,
        summary_deletions: 4,
        summary_files: 1,
        summary_diffs: SUMMARY_DIFF_TEXT,
      },
      true,
      ZERO_PATCH_TOTALS,
      report
    ),
    { filesChanged: 1, linesAdded: 10, linesRemoved: 4 }
  );

  assert.deepEqual(messages, [], "neither shape is a corrupt cell");
});

test("ISS-5238: a summary that resolves to nothing falls through to the patch accumulation", () => {
  // The fallback is an INDEPENDENTLY derived value, which is why the summary
  // path is allowed to decline. A summary_diffs carrying no +/- lines and zeroed
  // columns resolves to nothing, so the accumulated patch parts answer instead.
  const messages: string[] = [];
  const stats = resolveOpencodeDiffStats(
    {
      summary_additions: 0,
      summary_deletions: 0,
      summary_files: 0,
      summary_diffs: "diff --git a/x b/x\n@@ -0,0 +0,0 @@\n",
    },
    true,
    { added: 3, removed: 1, filesChanged: 2 },
    (message) => messages.push(message)
  );

  assert.deepEqual(stats, { filesChanged: 2, linesAdded: 3, linesRemoved: 1 });

  // A legacy store with no summary columns at all takes the same fallback.
  assert.deepEqual(
    resolveOpencodeDiffStats(
      {},
      false,
      { added: 3, removed: 1, filesChanged: 2 },
      (message) => messages.push(message)
    ),
    { filesChanged: 2, linesAdded: 3, linesRemoved: 1 }
  );
  // ...and with nothing on either side the answer stays ABSENT, never a zero
  // triple a surface would render as "no lines changed".
  assert.equal(
    resolveOpencodeDiffStats({}, false, ZERO_PATCH_TOTALS, (message) =>
      messages.push(message)
    ),
    null
  );

  // Asserted last: `assert.deepEqual` carries an `asserts actual is T`
  // signature, so checking against `[]` mid-test would narrow `messages` to
  // `never[]` and break every later `push`.
  assert.deepEqual(messages, [], "no shape here is a corrupt cell");
});
