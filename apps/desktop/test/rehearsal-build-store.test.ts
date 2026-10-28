/**
 * @file rehearsal-build-store.test.ts
 * @description ISS-5303 — behaviour coverage for the reachable helpers of
 * `scripts/rehearsal-build-store.ts` (ISS-5104 Phase A of the DATA_REVISION
 * rebuild rehearsal).
 *
 * Scope, deliberately: the transcript-selection, guard and store-probe helpers,
 * plus `injectMissingSourceFixture` against a real (empty) store — the fixture's
 * subject IS what it writes and re-writes, and no counter can stand in for that.
 * `runBootImport` and `main` are still not driven here: they stage the whole
 * frozen corpus through a CollectorManager, which is a rehearsal, not a unit
 * test. Importing the module is safe: `main()` sits behind the
 * `process.argv[1] === import.meta.url` guard the file's own header promises,
 * so nothing runs on import.
 *
 * Nothing in this file writes outside a `mkdtemp` directory.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { afterAll, describe, test } from "vitest";
import {
  assertBackfillsClean,
  assertHarnessCaptured,
  assertOwnerIdentityClaimed,
  claimRehearsalOwnerIdentity,
  collectSessionStates,
  injectMissingSourceFixture,
  listStagedClaudeMains,
  listStagedCodexRollouts,
  REHEARSAL_BACKFILL,
  REHEARSAL_NOW_ISO,
  REHEARSAL_UNOWNED_SESSION_PREDICATE,
  runRehearsalBackfills,
} from "../scripts/rehearsal-build-store.js";
import { DESKTOP_AGENT_STATUS } from "../src/main/database/db-constants.js";
import { UNOWNED_SESSION_PREDICATE } from "../src/main/database/session-owner-identity.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { insertInvocations } from "./agent-components-test-fixtures.js";
import { openTestDb } from "./agent-db-test-utils.js";

/** Fragment of the table-existence probe `collectSessionStates` issues first. */
const SQLITE_MASTER_PROBE = "sqlite_master";
/** The correlated COUNT the session query uses when the table is present. */
const INVOCATION_SUBQUERY = "FROM agent_component_invocations i";
/** The literal the session query falls back to on an old merge-base store. */
const ZERO_INVOCATION_FALLBACK = "0 AS invocationCount";
const INVOCATION_TABLE = "agent_component_invocations";
/** ISS-9284: the two tables the Branches view's per-session count joins. */
const BRANCH_LINK_TABLE = "session_artifact_links";
const ARTIFACT_TABLE = "artifacts";
/**
 * The join that makes the branch count a BRANCH count. Without the
 * `kind = 'branch'` predicate the query would count every artifact link —
 * commits, PRs and ClosedLoop docs included — and a lost branch would hide
 * inside a total that barely moved.
 */
const BRANCH_ARTIFACT_JOIN = "art.kind = 'branch'";
/** The literal the branch count falls back to when the link tables are absent. */
const ZERO_BRANCH_FALLBACK = "0 AS branchCount";
/**
 * Both owner identity columns, summed. A single-column probe would call a
 * session that kept `user_id` and lost `organization_id` preserved.
 */
const OWNER_IDENTITY_EXPRESSION =
  "((s.user_id IS NOT NULL) + (s.organization_id IS NOT NULL))";
/**
 * The unowned predicate the claim copies from `UNOWNED_SESSION_PREDICATE`. The
 * failure must name it: it is the thing that stops selecting when the claim
 * silently reaches nothing. Hoisted per ultracite's useTopLevelRegex.
 */
const RE_UNOWNED_PREDICATE = /user_id IS NULL AND organization_id IS NULL/;

const tempDirs: string[] = [];

afterAll(() => {
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
    // The two transcript backfills take ONE set of harness adapters per call,
    // so each harness needs its own list and its own pass (ISS-5466 added the
    // codex one). A codex rollout in this list would be handed the Claude id
    // extractor and resolve to no session at all.
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

describe("listStagedCodexRollouts", () => {
  test("returns every codex rollout and skips claude, opencode and scaffolding", () => {
    const stagingDir = makeStagingDir();
    writeDossier(stagingDir, "aaa", ["aaa.jsonl"]);
    writeDossier(stagingDir, "bbb", [
      "rollout-2026-01-01T00-00-00-bbb.jsonl",
      "rollout-2026-01-01T00-00-01-bbb-child.jsonl",
    ]);
    writeDossier(stagingDir, "ccc", ["opencode.db"]);
    writeDossier(stagingDir, "_templates", ["dossier.md"]);

    assert.deepEqual(listStagedCodexRollouts(stagingDir), [
      join(stagingDir, "bbb", "rollout-2026-01-01T00-00-00-bbb.jsonl"),
      join(stagingDir, "bbb", "rollout-2026-01-01T00-00-01-bbb-child.jsonl"),
    ]);
  });
});

describe("assertHarnessCaptured", () => {
  test("passes when the harness captured something", () => {
    assert.doesNotThrow(() =>
      assertHarnessCaptured(REHEARSAL_BACKFILL.ActivitySegments, "codex", 11, {
        scanned: 11,
        captured: 11,
      })
    );
  });

  test("fires on scanned=0, the shape total id drift actually produces", () => {
    // The regression this test exists for: the guard first read
    // `scanned > 0 && captured === 0`, which can NEVER hold for its own subject.
    // Both backfills do `skipped++; continue;` for a transcript whose extracted
    // session id is not in `existingSessionIds` — BEFORE `scanned++` — so a
    // codex extractor that resolves nothing yields scanned=0, captured=0, and
    // the guard was inert.
    assert.throws(
      () =>
        assertHarnessCaptured(
          REHEARSAL_BACKFILL.ActivitySegments,
          "codex",
          17,
          {
            scanned: 0,
            captured: 0,
          }
        ),
      (error: Error) =>
        error.message.includes("codex") &&
        error.message.includes(REHEARSAL_BACKFILL.ActivitySegments) &&
        error.message.includes("17 staged transcript(s)") &&
        error.message.includes("covered in name only")
    );
  });

  test("fires on scanned>0 with nothing captured", () => {
    assert.throws(() =>
      assertHarnessCaptured(REHEARSAL_BACKFILL.ActivitySegments, "claude", 16, {
        scanned: 16,
        captured: 0,
      })
    );
  });

  test("fires on an artifact-link pass that scanned everything and captured nothing", () => {
    // ISS-5466 review: the shape a silent artifact-ref extraction regression
    // produces. Segments still tile (every transcript whose id resolves
    // re-tiles), so guarding segments alone left this green — while the frozen
    // corpus's real codex result is captured=28.
    assert.throws(
      () =>
        assertHarnessCaptured(REHEARSAL_BACKFILL.ArtifactLinks, "codex", 11, {
          scanned: 11,
          captured: 0,
        }),
      (error: Error) =>
        error.message.includes(REHEARSAL_BACKFILL.ArtifactLinks) &&
        error.message.includes("extraction regression")
    );
  });

  test("the two backfills are guarded independently", () => {
    // Neither counter may stand in for the other: a run where links captured in
    // bulk and segments captured nothing must still fail, and vice versa. The
    // labels are what make the failure say which one.
    assert.doesNotThrow(() =>
      assertHarnessCaptured(REHEARSAL_BACKFILL.ArtifactLinks, "claude", 16, {
        scanned: 16,
        captured: 186,
      })
    );
    assert.throws(
      () =>
        assertHarnessCaptured(
          REHEARSAL_BACKFILL.ActivitySegments,
          "claude",
          16,
          { scanned: 16, captured: 0 }
        ),
      (error: Error) =>
        error.message.includes(REHEARSAL_BACKFILL.ActivitySegments) &&
        !error.message.includes(REHEARSAL_BACKFILL.ArtifactLinks)
    );
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
          error.message.includes("no staged claude transcripts") &&
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
  test("ISS-9284: snapshots a count for every consuming view, per session", async () => {
    // COUNT(*) comes back from SQLite as a BigInt; the manifest is JSON, so an
    // uncoerced count would serialize-fail or land as a string and make Phase
    // B's before/after comparison meaningless. deepEqual is strict, so 52n
    // would not satisfy 52 here.
    //
    // The expected shape is written out rather than derived from
    // REHEARSAL_PROJECTION_TARGET: this is the assertion that fails when a view
    // stops being snapshotted, which is the whole ISS-9284 defect. A fixture
    // built from that const would agree with any mutation of it.
    const { db, queries } = fakeDb((sql) =>
      sql.includes(SQLITE_MASTER_PROBE)
        ? [
            { name: INVOCATION_TABLE },
            { name: BRANCH_LINK_TABLE },
            { name: ARTIFACT_TABLE },
          ]
        : [
            {
              id: "s1",
              dataRevision: 61n,
              invocationCount: 52n,
              branchCount: 3n,
              ownerCount: 2n,
              ownerUserId: "user-a",
              ownerOrganizationId: "org-a",
              analyticsCount: 1n,
            },
            {
              id: "s2",
              dataRevision: 60n,
              invocationCount: 0n,
              branchCount: 0n,
              ownerCount: 0n,
              analyticsCount: 0n,
            },
          ]
    );

    const states = await collectSessionStates(db);

    assert.deepEqual(states, [
      {
        id: "s1",
        dataRevision: 61,
        projections: { sessions: 52, branches: 3, owner: 2, aggregate: 1 },
        ownerIdentity: { userId: "user-a", organizationId: "org-a" },
      },
      {
        id: "s2",
        dataRevision: 60,
        projections: { sessions: 0, branches: 0, owner: 0, aggregate: 0 },
        ownerIdentity: { userId: null, organizationId: null },
      },
    ]);
    assert.ok(
      queries[1]?.includes(INVOCATION_SUBQUERY),
      "the session query must count the real invocation rows when the table is present"
    );
    assert.ok(
      queries[1]?.includes(BRANCH_ARTIFACT_JOIN),
      "the branches view must be counted from the branch-kind artifact join, not from every artifact link"
    );
    assert.ok(
      queries[1]?.includes(OWNER_IDENTITY_EXPRESSION),
      "the owner view must be counted from BOTH identity columns, so a partial blanking is a loss"
    );
  });

  test("reports zero invocations against a store predating the table", async () => {
    // An old merge-base store has no `agent_component_invocations`. Selecting
    // from it anyway would abort Phase A with a SQL error instead of building
    // the store the rehearsal exists to build.
    const { db, queries } = fakeDb((sql) =>
      sql.includes(SQLITE_MASTER_PROBE)
        ? [{ name: BRANCH_LINK_TABLE }, { name: ARTIFACT_TABLE }]
        : [
            {
              id: "s1",
              dataRevision: 61n,
              invocationCount: 0n,
              branchCount: 4n,
              ownerCount: 1n,
              analyticsCount: 2n,
            },
          ]
    );

    const states = await collectSessionStates(db);

    assert.deepEqual(states, [
      {
        id: "s1",
        dataRevision: 61,
        projections: { sessions: 0, branches: 4, owner: 1, aggregate: 2 },
        ownerIdentity: { userId: null, organizationId: null },
      },
    ]);
    assert.ok(
      queries[1]?.includes(ZERO_INVOCATION_FALLBACK),
      "the session query must substitute a literal zero when the table is absent"
    );
    assert.ok(
      !queries[1]?.includes(INVOCATION_SUBQUERY),
      "the session query must not select from a table this store does not have"
    );
    assert.ok(
      queries[1]?.includes(BRANCH_ARTIFACT_JOIN),
      "an absent invocation table must not disable the views whose tables ARE present"
    );
  });

  test("ISS-9284: reports zero branch links against a store predating the link tables", async () => {
    // The Branches view's join spans two tables; an old merge-base store may
    // have neither, and Phase A must still produce a manifest.
    const { db, queries } = fakeDb((sql) =>
      sql.includes(SQLITE_MASTER_PROBE)
        ? [{ name: INVOCATION_TABLE }]
        : [
            {
              id: "s1",
              dataRevision: 61n,
              invocationCount: 7n,
              branchCount: 0n,
              ownerCount: 2n,
              analyticsCount: 1n,
            },
          ]
    );

    const states = await collectSessionStates(db);

    assert.deepEqual(states, [
      {
        id: "s1",
        dataRevision: 61,
        projections: { sessions: 7, branches: 0, owner: 2, aggregate: 1 },
        ownerIdentity: { userId: null, organizationId: null },
      },
    ]);
    assert.ok(
      queries[1]?.includes(ZERO_BRANCH_FALLBACK),
      "the session query must substitute a literal zero when the link tables are absent"
    );
    assert.ok(
      !queries[1]?.includes(BRANCH_ARTIFACT_JOIN),
      "the session query must not join tables this store does not have"
    );
  });

  test("ISS-9284: ONE of the two branch tables present is still a zero, not a join", async () => {
    // The boundary case, and the only one that distinguishes `&&` from `||` in
    // the branch expression's guard: with both tables present or both absent the
    // two operators agree, so the sibling tests above cannot catch a flipped
    // one. Joining a table this store does not have would abort Phase A with a
    // SQL error instead of producing a manifest — the exact outcome the
    // table-existence probe exists to prevent.
    const { db, queries } = fakeDb((sql) =>
      sql.includes(SQLITE_MASTER_PROBE)
        ? [{ name: INVOCATION_TABLE }, { name: BRANCH_LINK_TABLE }]
        : [
            {
              id: "s1",
              dataRevision: 61n,
              invocationCount: 7n,
              branchCount: 0n,
              ownerCount: 2n,
              analyticsCount: 1n,
            },
          ]
    );

    const states = await collectSessionStates(db);

    assert.deepEqual(states, [
      {
        id: "s1",
        dataRevision: 61,
        projections: { sessions: 7, branches: 0, owner: 2, aggregate: 1 },
        ownerIdentity: { userId: null, organizationId: null },
      },
    ]);
    assert.ok(
      queries[1]?.includes(ZERO_BRANCH_FALLBACK),
      "a half-present join must fall back to zero, not emit the join"
    );
    assert.ok(
      !queries[1]?.includes(BRANCH_ARTIFACT_JOIN),
      "the session query must not join `artifacts` when this store has no such table"
    );
  });

  test("probes before selecting, and reports an empty store as empty", async () => {
    const { db, queries } = fakeDb(() => []);

    assert.deepEqual(await collectSessionStates(db), []);
    assert.equal(
      queries.length,
      2,
      "one probe for every projection table, then one select"
    );
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

/** A temp dir for a real store, cleaned up with the rest. */
function makeStoreDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "iss5466-rehearsal-store-"));
  tempDirs.push(dir);
  return dir;
}

/** The fixture's row in the manifest snapshot Phase B compares against. */
async function fixtureState(db: SqliteAgentDatabase, sessionId: string) {
  const state = (await collectSessionStates(db)).find(
    (s) => s.id === sessionId
  );
  if (!state) {
    throw new Error(`fixture ${sessionId} is absent from the store`);
  }
  return state;
}

describe("injectMissingSourceFixture", () => {
  test("a reused --out store comes back to the same zero-derived pre-state", async () => {
    // The reused-store retry, in miniature. The documented usage is
    // `--out <dir>`, and a second run against an existing dir re-opens the
    // store: boot maintenance materializes invocation and analytics rows for
    // the fixture out of the events the first run left behind, and the
    // source-row upserts never reach them. Phase B's positive control requires
    // a ZERO invocation pre-state (`storedRowBridgeViolations`), so a retry
    // that kept those rows would make the rehearsal reject its own control as
    // vacuous. Measured on a real second `--out` run before this fix:
    // invocationCount 3, analyticsCount 1.
    const db = await openTestDb(makeStoreDir());
    try {
      // Settle the boot chain BEFORE injecting, exactly as `main()` does, so
      // maintenance cannot race the assertions below.
      await db.whenBootMaintenanceSettled();
      const sessionId = await injectMissingSourceFixture(db);
      await insertInvocations(db.prisma, [
        {
          id: `${sessionId}-derived-by-boot-maintenance`,
          sessionId,
          componentKind: AgentComponentInvocationKind.Tool,
          componentKey: "Read",
          anchorKind: AgentComponentInvocationAnchorKind.Session,
          anchorValue: sessionId,
        },
      ]);
      await db.prisma.write((client) =>
        client.$executeRawUnsafe(
          "INSERT INTO session_analytics (session_id) VALUES ($1)",
          sessionId
        )
      );
      const seeded = await fixtureState(db, sessionId);
      assert.deepEqual(
        {
          invocationCount: seeded.projections.sessions,
          analyticsCount: seeded.projections.aggregate,
        },
        { invocationCount: 1, analyticsCount: 1 },
        "the derived rows must actually land, or the assertion below is vacuous"
      );

      await injectMissingSourceFixture(db);

      const retried = await fixtureState(db, sessionId);
      assert.equal(retried.projections.sessions, 0);
      assert.equal(retried.projections.aggregate, 0);
    } finally {
      await db.close();
    }
  });

  test("writes the canonical value on both persisted status axes", async () => {
    // `sessions.status` and `agents.status` are different vocabularies:
    // the session lifecycle set, and DESKTOP_AGENT_STATUS. A lifecycle value in
    // the agent column would give the fixture an agent state no importer can
    // produce, so repair or rollup logic keyed on agent terminality would
    // behave differently here than on imported data — and the fixture is only
    // worth anything while it is production-shaped.
    const db = await openTestDb(makeStoreDir());
    try {
      await db.whenBootMaintenanceSettled();
      const sessionId = await injectMissingSourceFixture(db);

      const rows = await db.prisma.client.$queryRawUnsafe<
        Array<{ session_status: string; agent_status: string }>
      >(
        `SELECT s.status AS session_status, a.status AS agent_status
           FROM sessions s JOIN agents a ON a.session_id = s.id
          WHERE s.id = $1`,
        sessionId
      );

      assert.deepEqual(rows, [
        {
          session_status: SESSION_STATUS.INACTIVE,
          agent_status: DESKTOP_AGENT_STATUS.COMPLETED,
        },
      ]);
    } finally {
      await db.close();
    }
  });
});

describe("ISS-9284 REHEARSAL_UNOWNED_SESSION_PREDICATE", () => {
  test("still equals the canonical UNOWNED_SESSION_PREDICATE it copies", () => {
    // The compensating guard for a deliberate copy. `rehearsal-build-store.ts`
    // runs inside a merge-base worktree and may not import
    // `session-owner-identity.ts`, so the predicate is duplicated there — but
    // THIS file runs in the PR checkout under no such constraint, so it can hold
    // the copy to the original. Widen the canonical predicate (a third identity
    // column, say) and the rehearsal would otherwise go on claiming under the
    // stale, narrower definition while its own comment claimed parity.
    assert.equal(
      REHEARSAL_UNOWNED_SESSION_PREDICATE,
      UNOWNED_SESSION_PREDICATE
    );
  });

  test("is the predicate the claim's UPDATE actually uses", () => {
    // Equality above is worthless if the constant is not what reaches the SQL.
    // Written as an independent literal, not built from the constant.
    assert.equal(
      REHEARSAL_UNOWNED_SESSION_PREDICATE,
      "user_id IS NULL AND organization_id IS NULL"
    );
  });
});

describe("ISS-9284 claimRehearsalOwnerIdentity", () => {
  test("takes an unowned store's Owner projection from empty to populated", async () => {
    // Measured on the frozen corpus: 0 of 35 sessions carried either identity
    // column, because nothing in a rehearsal signs in. Without the claim the
    // Owner view has nothing to lose and its check can never fail.
    const db = await openTestDb(makeStoreDir());
    try {
      await db.whenBootMaintenanceSettled();
      const sessionId = await injectMissingSourceFixture(db);
      const before = await fixtureState(db, sessionId);
      assert.equal(
        before.projections.owner,
        0,
        "the pre-claim store must be unowned, or the assertion below is vacuous"
      );

      const claimed = await claimRehearsalOwnerIdentity(db);

      assert.ok(claimed >= 1, "the claim must reach at least one session");
      const claimedState = await fixtureState(db, sessionId);
      assert.equal(
        claimedState.projections.owner,
        2,
        "both identity columns must be stamped — a one-column claim would make a partial blanking undetectable"
      );
    } finally {
      await db.close();
    }
  });

  test("is idempotent: a second claim matches nothing and changes nothing", async () => {
    // The documented usage is `--out <dir>`, and a reused dir re-runs Phase A
    // over a store whose sessions are already claimed.
    const db = await openTestDb(makeStoreDir());
    try {
      await db.whenBootMaintenanceSettled();
      const sessionId = await injectMissingSourceFixture(db);
      await claimRehearsalOwnerIdentity(db);

      const second = await claimRehearsalOwnerIdentity(db);

      assert.equal(
        second,
        0,
        "an already-owned session must not be re-claimed"
      );
      assert.equal((await fixtureState(db, sessionId)).projections.owner, 2);
    } finally {
      await db.close();
    }
  });
});

/**
 * PR #6728 review (whitlockk): the Branches count must be the population the
 * BRANCHES SURFACE reads, and `branch-reads.ts` admits only
 * `BRANCH_WRITE_METHOD_VALUES`. A link method the surface ignores must not be
 * countable here, or a rebuild that swaps a Wrote link for a workspace one keeps
 * the count flat while the surface loses the session.
 *
 * Driven against a REAL store rather than the SQL-shape `fakeDb` above: the
 * defect is which ROWS the query admits, and a test that only asserts the
 * fragment appears in the SQL string would pass against a predicate that never
 * matched anything.
 */
describe("ISS-9284 collectSessionStates — Branches method qualification", () => {
  /** A method the branch-ref extractor emits that is NOT write evidence. */
  const WORKSPACE_METHOD = "git_checkout";
  /** A method the Branches read admits (`BRANCH_WRITE_METHOD_VALUES`). */
  const WRITE_METHOD = "git_commit";

  async function seedBranchLink(
    db: SqliteAgentDatabase,
    sessionId: string,
    method: string
  ): Promise<void> {
    await db.prisma.write(async (client) => {
      await client.$executeRawUnsafe(
        `INSERT OR IGNORE INTO artifacts (id, identity_key, kind, branch_name, created_at, last_seen_at)
           VALUES ('art-branch', 'art-branch-key', 'branch', 'feat/x', $1, $1)`,
        REHEARSAL_NOW_ISO
      );
      await client.$executeRawUnsafe(
        `INSERT INTO session_artifact_links
           (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
           VALUES ($1, $2, 'art-branch', $3, $4, 'test', 1, $5, $5)`,
        `sal-${method}`,
        sessionId,
        method === WRITE_METHOD ? "created" : "workspace",
        method,
        REHEARSAL_NOW_ISO
      );
    });
  }

  test("counts a Wrote link and NOT a workspace link to the same branch", async () => {
    const db = await openTestDb(makeStoreDir());
    try {
      await db.whenBootMaintenanceSettled();
      const sessionId = await injectMissingSourceFixture(db);
      await seedBranchLink(db, sessionId, WRITE_METHOD);
      assert.equal(
        (await fixtureState(db, sessionId)).projections.branches,
        1,
        "a write-evidence link must be counted, or the assertion below is vacuous"
      );

      // The reviewer's exact scenario: the rebuild replaces the Wrote link with
      // a workspace one. Same branch artifact, same session, one link either
      // way — so a count over EVERY link to that artifact never moves.
      await db.prisma.write((client) =>
        client.$executeRawUnsafe(
          "DELETE FROM session_artifact_links WHERE session_id = $1",
          sessionId
        )
      );
      await seedBranchLink(db, sessionId, WORKSPACE_METHOD);

      assert.equal(
        (await fixtureState(db, sessionId)).projections.branches,
        0,
        "substituting a workspace link for a Wrote one must MOVE the count — the Branches surface just lost this session"
      );
    } finally {
      await db.close();
    }
  });
});

/**
 * PR #6728 review (whitlockk): the Owner projection's count answers blanking only,
 * so the manifest must also carry the pair's actual VALUES. Phase B's
 * reattribution check has nothing to compare without them.
 */
describe("ISS-9284 collectSessionStates — owner identity pair", () => {
  test("snapshots the claimed pair, not only how many columns are non-null", async () => {
    const db = await openTestDb(makeStoreDir());
    try {
      await db.whenBootMaintenanceSettled();
      const sessionId = await injectMissingSourceFixture(db);
      await claimRehearsalOwnerIdentity(db);
      const claimed = await fixtureState(db, sessionId);
      assert.equal(claimed.projections.owner, 2);
      assert.ok(
        claimed.ownerIdentity.userId && claimed.ownerIdentity.organizationId,
        "both identity values must reach the manifest"
      );

      // Reattribution: a DIFFERENT non-null pair. The count is unchanged at 2,
      // which is exactly why the count cannot adjudicate this.
      await db.prisma.write((client) =>
        client.$executeRawUnsafe(
          "UPDATE sessions SET user_id = 'someone-else', organization_id = 'other-org' WHERE id = $1",
          sessionId
        )
      );

      const reattributed = await fixtureState(db, sessionId);
      assert.equal(
        reattributed.projections.owner,
        2,
        "the count must be blind to this — it is the pair that has to see it"
      );
      assert.deepEqual(reattributed.ownerIdentity, {
        userId: "someone-else",
        organizationId: "other-org",
      });
      assert.notDeepEqual(reattributed.ownerIdentity, claimed.ownerIdentity);
    } finally {
      await db.close();
    }
  });

  test("reports an unowned session's pair as nulls, not as absent", async () => {
    const db = await openTestDb(makeStoreDir());
    try {
      await db.whenBootMaintenanceSettled();
      const sessionId = await injectMissingSourceFixture(db);

      assert.deepEqual((await fixtureState(db, sessionId)).ownerIdentity, {
        userId: null,
        organizationId: null,
      });
    } finally {
      await db.close();
    }
  });
});

describe("ISS-9284 assertOwnerIdentityClaimed", () => {
  test("accepts a store where at least one session carries an owner", () => {
    assert.doesNotThrow(() =>
      assertOwnerIdentityClaimed([
        {
          id: "owned",
          dataRevision: 100,
          projections: { sessions: 3, branches: 1, owner: 2, aggregate: 1 },
          ownerIdentity: { userId: "u1", organizationId: "o1" },
        },
        {
          id: "unowned",
          dataRevision: 100,
          projections: { sessions: 3, branches: 1, owner: 0, aggregate: 1 },
          ownerIdentity: { userId: null, organizationId: null },
        },
      ])
    );
  });

  test("gates on the resulting population, not on what THIS run stamped", () => {
    // The reused `--out` retry: every session was claimed by the previous run,
    // so the claim's UPDATE legitimately matches zero rows while the store is
    // fully owned. A guard keyed on the update count would abort exactly the
    // retry the rest of this file works to support.
    assert.doesNotThrow(() =>
      assertOwnerIdentityClaimed([
        {
          id: "already-owned",
          dataRevision: 100,
          projections: { sessions: 3, branches: 1, owner: 2, aggregate: 1 },
          ownerIdentity: { userId: "u1", organizationId: "o1" },
        },
      ])
    );
  });

  test("fires when NO session carries an owner, naming the predicate", () => {
    // The outcome a renamed column or a predicate that stopped selecting
    // produces. Phase B would also reject the resulting manifest, but it would
    // blame the manifest rather than the step that produced it.
    assert.throws(
      () =>
        assertOwnerIdentityClaimed([
          {
            id: "unowned",
            dataRevision: 100,
            projections: { sessions: 3, branches: 1, owner: 0, aggregate: 1 },
            ownerIdentity: { userId: null, organizationId: null },
          },
        ]),
      RE_UNOWNED_PREDICATE
    );
  });
});
