/**
 * @file rehearsal-build-store.test.ts
 * @description ISS-5303 — behaviour coverage for the reachable helpers of
 * `scripts/rehearsal-build-store.ts` (ISS-5104 Phase A of the DATA_REVISION
 * rebuild rehearsal).
 *
 * Scope, deliberately: the transcript-selection, guard and store-probe helpers.
 * `openRehearsalDb`, `runBootImport` and `main` are not driven here — they open
 * a real SQLite store and start a CollectorManager, which is a rehearsal, not a
 * unit test. Importing the module is safe: `main()` sits behind the
 * `process.argv[1] === import.meta.url` guard the file's own header promises,
 * so nothing runs on import.
 *
 * Nothing in this file writes outside a `mkdtemp` directory, and the only real
 * data it reads is the frozen golden corpus (read-only — `stageGoldenCorpus`
 * copies out of it and never into it).
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import {
  assertBackfillsClean,
  collectSessionStates,
  listStagedClaudeMains,
  REHEARSAL_NOW_ISO,
  runRehearsalBackfills,
  stageCorpusIntoTemp,
} from "../scripts/rehearsal-build-store.js";
import { listDossierDirs } from "../src/main/collectors/golden/corpus-layout.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";

/** Fragment of the table-existence probe `collectSessionStates` issues first. */
const SQLITE_MASTER_PROBE = "sqlite_master";
/** The correlated COUNT the session query uses when the table is present. */
const INVOCATION_SUBQUERY = "FROM agent_component_invocations i";
/** The literal the session query falls back to on an old merge-base store. */
const ZERO_INVOCATION_FALLBACK = "0 AS invocation_count";
const INVOCATION_TABLE = "agent_component_invocations";

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeStagingDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "iss5303-rehearsal-staging-"));
  tempDirs.push(dir);
  return dir;
}

/** Write one staged dossier: `<stagingDir>/<sessionId>/<file>` for each file. */
function writeDossier(
  stagingDir: string,
  sessionId: string,
  files: string[]
): void {
  const dir = join(stagingDir, sessionId);
  mkdirSync(dir, { recursive: true });
  for (const file of files) {
    writeFileSync(join(dir, file), "");
  }
}

/**
 * A database stand-in for the two helpers that only read through
 * `db.prisma.client.$queryRawUnsafe`. Records every SQL string so a test can
 * assert which shape of query was actually issued, not merely that one was.
 */
function fakeDb(respond: (sql: string) => unknown[]): {
  db: SqliteAgentDatabase;
  queries: string[];
} {
  const queries: string[] = [];
  const client = {
    $queryRawUnsafe: (sql: string) => {
      queries.push(sql);
      return Promise.resolve(respond(sql));
    },
  };
  return {
    db: { prisma: { client } } as unknown as SqliteAgentDatabase,
    queries,
  };
}

describe("listStagedClaudeMains", () => {
  test("returns the Claude mains and skips codex, opencode and scaffolding", () => {
    // The two transcript backfills this list feeds are single-harness and
    // default to the Claude adapters, so handing them a codex rollout or an
    // opencode store would be a parse error per file, not a wider import.
    const stagingDir = makeStagingDir();
    writeDossier(stagingDir, "aaa", ["aaa.jsonl"]);
    writeDossier(stagingDir, "bbb", ["rollout-2026-01-01T00-00-00-bbb.jsonl"]);
    writeDossier(stagingDir, "ccc", ["opencode.db"]);
    writeDossier(stagingDir, "zzz", ["zzz.jsonl"]);
    writeDossier(stagingDir, "_templates", ["dossier.md"]);
    writeDossier(stagingDir, ".hidden", ["config"]);
    writeFileSync(join(stagingDir, "loose.txt"), "");

    assert.deepEqual(listStagedClaudeMains(stagingDir), [
      join(stagingDir, "aaa", "aaa.jsonl"),
      join(stagingDir, "zzz", "zzz.jsonl"),
    ]);
  });

  test("fails loudly on a dossier with no recognizable transcript", () => {
    // An incomplete dossier must abort the rehearsal, never be silently
    // dropped: a skipped dossier is a store that quietly disagrees with the
    // corpus, and Phase B would then compare against a manifest missing it.
    const stagingDir = makeStagingDir();
    writeDossier(stagingDir, "ddd", ["notes.txt"]);

    assert.throws(
      () => listStagedClaudeMains(stagingDir),
      (error: Error) =>
        error.message.includes("ddd") &&
        error.message.includes("expected raw/ddd.jsonl")
    );
  });

  test("returns nothing for a staging dir that was never created", () => {
    const stagingDir = makeStagingDir();

    assert.deepEqual(listStagedClaudeMains(join(stagingDir, "absent")), []);
  });
});

describe("stageCorpusIntoTemp", () => {
  test("stages the real frozen corpus and yields exactly its Claude mains", () => {
    // Covers the repo-root walk from `import.meta.url` — the one part of this
    // script that silently breaks if the file ever moves, since a wrong root
    // means an empty corpus dir and `stageGoldenCorpus` copying zero dossiers.
    const stagingDir = stageCorpusIntoTemp();
    tempDirs.push(stagingDir);

    const dossiers = listDossierDirs(stagingDir);
    const mains = listStagedClaudeMains(stagingDir);
    // Re-derived independently of the production classifier: a staged Claude
    // dossier is one holding `<id>.jsonl` with no opencode store and no codex
    // rollouts beside it.
    const expected = dossiers
      .filter(({ sessionId, dir }) => {
        const files = readdirSync(dir);
        return (
          files.includes(`${sessionId}.jsonl`) &&
          !files.some((file) => file.endsWith(".db")) &&
          !files.some((file) => file.startsWith("rollout-"))
        );
      })
      .map(({ sessionId, dir }) => join(dir, `${sessionId}.jsonl`));

    assert.ok(dossiers.length > 0, "the staged corpus has no dossiers at all");
    assert.ok(mains.length > 0, "the staged corpus has no Claude dossiers");
    assert.ok(
      mains.length < dossiers.length,
      "the frozen corpus holds codex and opencode dossiers that must be filtered out; if that is no longer true, this assertion is the thing to revisit"
    );
    assert.deepEqual(mains, expected);
    for (const main of mains) {
      assert.ok(existsSync(main), `staged main ${main} does not exist`);
      assert.equal(basename(main), `${basename(dirname(main))}.jsonl`);
    }
  });
});

describe("runRehearsalBackfills", () => {
  test("refuses to run over an empty file list, without touching the store", () => {
    // Both backfills swallow per-file failures into a counter instead of
    // throwing, so a run over zero files reports zero errors and passes
    // vacuously. The guard has to fire BEFORE any database work, or a
    // rehearsal against a corpus with no Claude dossiers looks green.
    const stagingDir = makeStagingDir();
    writeDossier(stagingDir, "cdx", ["rollout-2026-01-01T00-00-00-cdx.jsonl"]);
    let databaseTouched = false;
    const db = {
      get prisma(): never {
        databaseTouched = true;
        throw new Error("the vacuity guard let the backfills reach the store");
      },
    } as unknown as SqliteAgentDatabase;

    return assert
      .rejects(
        () => runRehearsalBackfills(db, stagingDir, () => undefined),
        (error: Error) =>
          error.message.includes("no staged Claude main transcripts") &&
          error.message.includes("pass vacuously")
      )
      .then(() => {
        assert.equal(databaseTouched, false);
      });
  });
});

describe("assertBackfillsClean", () => {
  test("accepts a run with no per-file errors", () => {
    assert.doesNotThrow(() => assertBackfillsClean({ errors: 0, scanned: 30 }));
  });

  test("names both counters when a backfill reported per-file errors", () => {
    assert.throws(
      () => assertBackfillsClean({ errors: 2, scanned: 30 }),
      (error: Error) =>
        error.message.includes("2 per-file error(s)") &&
        error.message.includes("30 scanned")
    );
  });

  test("does not treat a zero-scan run as an error", () => {
    // Vacuity is runRehearsalBackfills' guard, not this one's — this helper
    // only ever speaks to the error counter, and conflating the two would make
    // the caller's own empty-list message unreachable.
    assert.doesNotThrow(() => assertBackfillsClean({ errors: 0, scanned: 0 }));
  });
});

describe("collectSessionStates", () => {
  test("counts invocation rows per session when the table exists", async () => {
    // COUNT(*) comes back from SQLite as a BigInt; the manifest is JSON, so an
    // uncoerced count would serialize-fail or land as a string and make Phase
    // B's before/after comparison meaningless. deepEqual is strict, so 52n
    // would not satisfy 52 here.
    const { db, queries } = fakeDb((sql) =>
      sql.includes(SQLITE_MASTER_PROBE)
        ? [{ name: INVOCATION_TABLE }]
        : [
            {
              id: "s1",
              data_revision: 61n,
              invocation_count: 52n,
              analytics_count: 1n,
            },
            {
              id: "s2",
              data_revision: 60n,
              invocation_count: 0n,
              analytics_count: 0n,
            },
          ]
    );

    const states = await collectSessionStates(db);

    assert.deepEqual(states, [
      { id: "s1", dataRevision: 61, invocationCount: 52, analyticsCount: 1 },
      { id: "s2", dataRevision: 60, invocationCount: 0, analyticsCount: 0 },
    ]);
    assert.ok(
      queries[1]?.includes(INVOCATION_SUBQUERY),
      "the session query must count the real invocation rows when the table is present"
    );
  });

  test("reports zero invocations against a store predating the table", async () => {
    // An old merge-base store has no `agent_component_invocations`. Selecting
    // from it anyway would abort Phase A with a SQL error instead of building
    // the store the rehearsal exists to build.
    const { db, queries } = fakeDb((sql) =>
      sql.includes(SQLITE_MASTER_PROBE)
        ? []
        : [
            {
              id: "s1",
              data_revision: 61n,
              invocation_count: 0n,
              analytics_count: 2n,
            },
          ]
    );

    const states = await collectSessionStates(db);

    assert.deepEqual(states, [
      { id: "s1", dataRevision: 61, invocationCount: 0, analyticsCount: 2 },
    ]);
    assert.ok(
      queries[1]?.includes(ZERO_INVOCATION_FALLBACK),
      "the session query must substitute a literal zero when the table is absent"
    );
    assert.ok(
      !queries[1]?.includes(INVOCATION_TABLE),
      "the session query must not reference a table this store does not have"
    );
  });

  test("probes before selecting, and reports an empty store as empty", async () => {
    const { db, queries } = fakeDb(() => []);

    assert.deepEqual(await collectSessionStates(db), []);
    assert.equal(queries.length, 2);
    assert.ok(queries[0]?.includes(SQLITE_MASTER_PROBE));
  });
});

describe("REHEARSAL_NOW_ISO", () => {
  test("is a canonical UTC instant", () => {
    // Handed straight to `openSqliteAgentDatabase({ now })` in both rehearsal
    // phases. A local-offset or non-canonical string would still parse but
    // would put the two phases on different clocks, and the fixed clock is the
    // whole reason a rerun is byte-reproducible.
    assert.equal(new Date(REHEARSAL_NOW_ISO).toISOString(), REHEARSAL_NOW_ISO);
    assert.ok(REHEARSAL_NOW_ISO.endsWith("Z"));
  });
});
