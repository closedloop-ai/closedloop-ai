/**
 * @file opencode-collector-fingerprint.test.ts
 * @description The first-party OpenCode collector's source-snapshot contract.
 *
 * OpenCode is a BATCH harness: `listSources()` returns one store sentinel and
 * `parse()` loads every session from it, so the only thing that tells the engine
 * the store is imported is the persisted fingerprint. Split out of
 * `ingest-orchestrator.test.ts` (grandfathered shrink-only under the root
 * AGENTS.md line-count contract) so this collector-owned contract has its own
 * home rather than growing the manager suite.
 */
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createOpencodeCollector } from "../src/main/collectors/opencode/opencode-collector.js";
import { loadOpencodeSessionsFromDb } from "../src/main/collectors/opencode/opencode-parser.js";
import { writeOpencodeDb } from "./opencode-store-fixture.js";

/** Ultracite `useTopLevelRegex`: assertion matchers live at module scope. */
const DURABLE_PROBE_REPORT = /summary-column probe failed durably/;

test("first-party OpenCode collector does not persist changed fingerprint after stale parse", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-fingerprint-drift-"));
  const previousOpenCodeDir = process.env.OPENCODE_DATA_DIR;
  try {
    process.env.OPENCODE_DATA_DIR = dir;
    const dbPath = join(dir, "opencode.db");
    const fingerprintPath = join(dir, "state", "opencode-fingerprint");
    writeFileSync(dbPath, "original");
    const collector = createOpencodeCollector({ fingerprintPath });
    assert.deepEqual(collector.listSources(), [dbPath]);
    const staleSnapshot = {
      fingerprint: collector.sourceFingerprint?.(dbPath) ?? null,
    };

    appendFileSync(dbPath, "changed");
    // ISS-5028 (wongk review): refusing is not enough — the engine has to be
    // able to TELL it was refused, because the same sentinel returns as pending
    // on the next resume and must not be counted as a finished source.
    assert.equal(
      collector.markSourceImported?.(dbPath, staleSnapshot),
      false,
      "a snapshot that moved under the pass reports an uncommitted import"
    );

    assert.deepEqual(collector.listSources(), [dbPath]);
    assert.equal(
      collector.markSourceImported?.(dbPath, {
        fingerprint: collector.sourceFingerprint?.(dbPath) ?? null,
      }),
      true,
      "a current snapshot reports a committed import"
    );
    assert.deepEqual(collector.listSources(), []);
  } finally {
    if (previousOpenCodeDir === undefined) {
      Reflect.deleteProperty(process.env, "OPENCODE_DATA_DIR");
    } else {
      process.env.OPENCODE_DATA_DIR = previousOpenCodeDir;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-5161: an unreadable store is refused and reported, and never advances the fingerprint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-unreadable-store-"));
  const previousOpenCodeDir = process.env.OPENCODE_DATA_DIR;
  try {
    process.env.OPENCODE_DATA_DIR = dir;
    const dbPath = join(dir, "opencode.db");
    const fingerprintPath = join(dir, "state", "opencode-fingerprint");
    // Present, non-empty, and not a SQLite database — the shape a truncated or
    // half-written store takes on disk.
    writeFileSync(dbPath, "this is not a sqlite database");
    const lines: string[] = [];
    const collector = createOpencodeCollector({
      fingerprintPath,
      log: (message) => lines.push(message),
    });

    assert.deepEqual(collector.listSources(), [dbPath]);
    await assert.rejects(
      () => collector.parse(dbPath),
      "an unreadable store must refuse the parse, not resolve to an empty corpus"
    );
    // ISS-4649's lesson, applied to the whole load: the engine catches a
    // per-source parse rejection WITHOUT logging, so a refusal that only rejects
    // is invisible to an operator. It must report itself on the monitored
    // `collector <key> import failed: …` channel.
    assert.equal(
      lines.filter((line) =>
        line.startsWith("collector opencode import failed:")
      ).length,
      1,
      `the refusal must reach the monitored channel: ${JSON.stringify(lines)}`
    );
    // And nothing may be sealed behind it: the sentinel is still pending, so the
    // store is retried rather than frozen as a successfully-imported empty corpus.
    assert.deepEqual(
      collector.listSources(),
      [dbPath],
      "a refused parse must leave the store pending"
    );
  } finally {
    if (previousOpenCodeDir === undefined) {
      Reflect.deleteProperty(process.env, "OPENCODE_DATA_DIR");
    } else {
      process.env.OPENCODE_DATA_DIR = previousOpenCodeDir;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-5161/ISS-5238: a session-schema PRAGMA that FAILS is reported, never passed off as a legacy schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-pragma-unreadable-"));
  try {
    const dbPath = join(dir, "opencode.db");
    // A valid SQLite file whose `session` relation cannot be described: the
    // PRAGMA resolves the view, fails to find its base table, and THROWS. A
    // missing `session` table would instead answer successfully with no rows,
    // which is the legacy-schema case and must stay distinct from this one.
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE VIEW session AS SELECT * FROM missing_table;");
    db.close();

    // Pre-fix this returned `false` — indistinguishable from a legacy schema —
    // so the loader dropped the `summary_*` columns from its SELECT,
    // `resolveDiffStats` fell back to patch accumulation for EVERY session, the
    // parse resolved, and `markSourceImported` froze the wrong corpus behind the
    // unchanged-DB fingerprint gate (the ISS-4649 shape, on the same PRAGMA).
    //
    // ISS-5161 answered that by wrapping EVERY probe failure in a "schema
    // unreadable" throw. ISS-5238 (wongk review) splits it by retryability
    // instead: this fixture's `SQLITE_ERROR` is DURABLE, so propagating it would
    // wedge the corpus forever (a batch collector's throw is never marked seen).
    // It falls back to the legacy shape but SAYS SO on the monitored channel —
    // which is the assertion that now carries ISS-5161's intent, because a
    // silent `false` is precisely the conflation both tickets exist to prevent.
    const lines: string[] = [];
    assert.throws(
      () => loadOpencodeSessionsFromDb(dbPath, { log: (m) => lines.push(m) }),
      "a session store whose schema cannot be read must refuse the load, so the fingerprint is not advanced over it"
    );
    assert.equal(
      lines.filter((line) => DURABLE_PROBE_REPORT.test(line)).length,
      1,
      `the failed probe must announce its legacy fallback on the monitored channel rather than reading as a legacy schema: ${JSON.stringify(lines)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-5302: a FRESH collector drops an unchanged store on its first listSources, off the persisted fingerprint alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-fingerprint-coldstart-"));
  try {
    const dbPath = writeOpencodeDb(dir, [{ id: "ses_1" }]);
    const fingerprintPath = join(dir, "state", "opencode-fingerprint");

    // Pass one: the store is pending, parses, and is sealed. `markSourceImported`
    // writes the fingerprint to disk, which is the ONLY thing that survives the
    // process.
    const first = createOpencodeCollector({ dataDir: dir, fingerprintPath });
    assert.deepEqual(first.listSources(), [dbPath]);
    assert.equal((await first.parse(dbPath)).length, 1);
    assert.equal(
      first.markSourceImported?.(dbPath, {
        fingerprint: first.sourceFingerprint?.(dbPath) ?? null,
      }),
      true
    );

    // Pass two is a DIFFERENT collector with its own in-memory ingest state —
    // the next launch. It has parsed nothing, so the only reason it can skip is
    // the fingerprint it read back off disk. OpenCode is a BATCH harness, so
    // this gate is what stops every launch re-reading the whole store.
    const relaunched = createOpencodeCollector({
      dataDir: dir,
      fingerprintPath,
    });
    assert.deepEqual(
      relaunched.listSources(),
      [],
      "an unchanged store must not be re-offered to a fresh process"
    );

    // And the gate is a comparison, not a latch: move the store's mtime (no
    // clock read — an explicit instant, so this cannot race) and the SAME
    // collector offers it again. Without this half the assertion above would
    // hold just as well for a collector that had stopped listing anything.
    const moved = new Date(1_710_000_600_000);
    utimesSync(dbPath, moved, moved);
    assert.deepEqual(relaunched.listSources(), [dbPath]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
