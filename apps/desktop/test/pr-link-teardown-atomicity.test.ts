/**
 * @file pr-link-teardown-atomicity.test.ts
 * @description ISS-8905 (whitlockk on #6457, thread PRRT_kwDOQ4gDpM6eYK54): the
 * `normalized_pr` slice of `session_artifact_links` is torn down and rebuilt
 * inside the pull-requests phase's OWN transaction.
 *
 * Before this, the artifact-links phase deleted that slice and only the LATER
 * pull-requests phase restored it — two separate tolerant transaction groups. A
 * failed pull-requests group therefore left the DELETE durably committed while
 * the fingerprint comparison and watermark bump that describe it rolled back with
 * the failure. Usually the next pass re-derived the link and bumped then. But when
 * the deletion WAS the correct final state — the PR no longer derives from the
 * transcript — the next pass inherited an already-emptied slice, observed no
 * change, and the cloud kept the retired link indefinitely, with no error
 * surfaced anywhere. That is the silent, durable case
 * {@link SILENT_RETIREMENT_TEST} drives end to end.
 *
 * Every test drives the REAL ingest path (`db.importer.importSession`) or the
 * REAL single-transaction rebuild (`db.rebuildSessionFromParse`) against a live
 * SQLite store, and reads selection back through the REAL incremental scan
 * (`listUpdatedSessionCursorRows`). Failures are injected with SQLite triggers, so
 * a group fails the way production fails it — mid-transaction — rather than by
 * stubbing a seam.
 *
 * THE ORDERING CONSTRAINT the fix has to survive:
 * `persistNormalizedPullRequests` mints its link
 * `WHERE NOT EXISTS (… session_id, artifact_id)`, and the table carries a unique
 * `(session_id, artifact_id, relation)`. Before the fix the artifact-links DELETE
 * ran BEFORE `persistArtifactLinks`, so no stale `normalized_pr` row could be
 * present when the extractor wrote its links. Moving that teardown later makes a
 * stale row briefly visible to the extractor, and it must neither COLLIDE with an
 * extractor link on the same natural key nor SHADOW the phase's own re-mint.
 *
 * WHICH TESTS ACTUALLY DISCRIMINATE THE FIX, stated because the distinction is
 * not obvious and a reader will otherwise over-trust this file. Three of the six
 * go red against a pre-fix variant: the two failure-injection tests, and the
 * DIFFERENT-relation ordering test. The SAME-relation ordering test and the
 * isolated-vs-rebuild parity test pass against both pre-fix variants by
 * construction — a same-relation extractor ref upserts `method` over the stale
 * row whether or not anything tore it down, and the parity test asserts two paths
 * agree, which they also did before. They are safety and equivalence properties
 * of the new interleaving, not regression coverage for the teardown move; each
 * carries a note saying so at its own site.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { makePopulatedSession } from "./normalized-session-test-utils.js";
import {
  selectedSince,
  updatedAtOf,
} from "./session-sync-cursor-test-utils.js";

const SESSION_ID = "iss8905-session";
const REBUILD_SESSION_ID = "iss8905-rebuild-session";

/**
 * The two `session_artifact_links.method` values under test, spelled as literals
 * rather than imported from `pr-link-maintenance.ts` / the extractor.
 *
 * The duplication IS the test: a fixture that builds its expectation out of the
 * same constant the production code writes stays green when that constant is
 * mutated, because both sides move together. These are the wire values a stored
 * row actually carries, so they are asserted independently.
 */
const NORMALIZED_PR_METHOD = "normalized_pr";
/** The method the ref extractor stamps on a PR URL it saw in a tool use. */
const PR_URL_IN_TOOL_USE_METHOD = "pr_url_in_tool_use";
/** The method it stamps when the PR URL came out of a `gh pr create`. */
const PR_CREATE_OUTPUT_METHOD = "pr_create_output";

const PR_REPO = "closedloop-ai/closedloop-ai";
const PR_NUMBER = 8905;
const PR_URL = `https://github.com/${PR_REPO}/pull/${PR_NUMBER}`;

/**
 * The method the removed commit-SHA correlation pass stamped on stored links. Also spelled independently —
 * the production constant is not imported, for the reason above.
 */
const COMMIT_SHA_CORRELATION_METHOD = "commit_sha_correlation";

/** Inside RECENT_ACTIVITY_MS of every clock below, so the row stays live. */
const LIVE_FILE_MTIME_MS = Date.parse("2026-06-07T11:59:00.000Z");
const FIRST_IMPORT_AT = "2026-06-07T12:00:00.000Z";
const BLOCKED_IMPORT_AT = "2026-06-07T12:01:00.000Z";
const RETRY_IMPORT_AT = "2026-06-07T12:02:00.000Z";

const BLOCK_WATERMARK_TRIGGER = "iss8905_block_watermark_advance";
const BLOCK_PR_LINK_INSERT_TRIGGER = "iss8905_block_pr_link_insert";
const ARTIFACT_LINKS = "session_artifact_links";

const SILENT_RETIREMENT_TEST =
  "ISS-8905: a retired PR link survives a failed pull-requests group and is still published on the next pass";

type Db = SqliteAgentDatabase;

/** One PR link row as the assertions compare it. */
type PrLinkRow = { relation: string; method: string };

/** The base fixture: a live session on `main`, with no PR of any kind. */
function baseSession(sessionId: string): NormalizedSession {
  return makePopulatedSession({
    sessionId,
    fileModifiedAt: LIVE_FILE_MTIME_MS,
  });
}

/**
 * The base fixture whose collected artifacts name the PR, so the pull-requests
 * phase mints a `normalized_pr` link for it. No tool use carries the URL, so the
 * ref extractor contributes nothing and that link is the ONLY PR link.
 */
function prLinkedSession(sessionId = SESSION_ID): NormalizedSession {
  const base = baseSession(sessionId);
  return {
    ...base,
    artifacts: {
      ...base.artifacts,
      prs: [{ number: String(PR_NUMBER), repo: PR_REPO }],
    },
  };
}

/** The same fixture with no recent file activity, so the import lands it
 * `inactive` — the terminal state the single-transaction rebuild admits. */
function terminalPrLinkedSession(sessionId: string): NormalizedSession {
  return { ...prLinkedSession(sessionId), fileModifiedAt: null };
}

/**
 * The interleaving the ordering constraint is about: the session still names the
 * PR in its collected artifacts (so the pull-requests phase wants to mint) AND a
 * tool use quotes the PR's URL in its OUTPUT, so the ref extractor emits its own
 * `referenced` link for the SAME artifact in the EARLIER phase. The command is
 * deliberately NOT a `gh pr view/diff/review` — that classifies as
 * `relation: "reviewed"`, a different natural key, and would not exercise the
 * collision at all.
 *
 * `artifactLinkId` hashes `(session, "pull_request", "<repo>#<number>",
 * relation)` and `persistNormalizedPullRequests` mints on exactly that key with
 * `relation: "referenced"` — so this extractor ref lands on the SAME row id and
 * the SAME unique `(session_id, artifact_id, relation)` as the stale
 * `normalized_pr` row left over from a previous pass.
 */
function prReferencedInToolUseSession(
  sessionId = SESSION_ID
): NormalizedSession {
  const linked = prLinkedSession(sessionId);
  return {
    ...linked,
    toolUses: [
      {
        id: "toolu_git_log_1",
        providerToolUseId: "toolu_git_log_1",
        name: "Bash",
        kind: "builtin",
        timestamp: "2026-06-07T10:00:01.000Z",
        input: { command: "git log --oneline -1" },
        output: `abc1234 Land the change (${PR_URL})`,
      },
    ],
  };
}

/** The same, terminal, for the rebuild path. */
function terminalPrReferencedInToolUseSession(
  sessionId: string
): NormalizedSession {
  return { ...prReferencedInToolUseSession(sessionId), fileModifiedAt: null };
}

/**
 * The interleaving with NO upsert conflict to mask it: a `gh pr create` tool use,
 * so the extractor emits its ref on relation `created` while the stale
 * `normalized_pr` row sits on relation `referenced`.
 *
 * That difference is the whole point. When both land on the same relation, the
 * unique `(session_id, artifact_id, relation)` makes `LINK_UPSERT_CONFLICT`
 * overwrite `method` unconditionally, so the stale row leaves this phase's slice
 * whether or not the phase tears its slice down — which is why the same-relation
 * test below cannot tell a working teardown from a missing one. On a DIFFERENT
 * relation the two rows coexist, and only the phase's own DELETE can retire the
 * stale one.
 */
function prCreatedInToolUseSession(): NormalizedSession {
  const linked = prLinkedSession(SESSION_ID);
  return {
    ...linked,
    toolUses: [
      {
        id: "toolu_pr_create_1",
        providerToolUseId: "toolu_pr_create_1",
        name: "Bash",
        kind: "builtin",
        timestamp: "2026-06-07T10:00:01.000Z",
        input: { command: "gh pr create --fill" },
        output: `Creating pull request...\n${PR_URL}`,
      },
    ],
  };
}

function write(db: Db, sql: string, ...params: unknown[]): Promise<unknown> {
  return db.prisma.write((client) => client.$executeRawUnsafe(sql, ...params));
}

/**
 * Every session→PR link row, read through a join on the artifact kind rather
 * than by recomputing the artifact id, so the assertion cannot agree with a
 * wrong id by deriving it the same wrong way.
 */
function prLinkRows(db: Db, sessionId = SESSION_ID): Promise<PrLinkRow[]> {
  return db.prisma.client.$queryRawUnsafe<PrLinkRow[]>(
    `SELECT sal.relation AS relation, sal.method AS method
       FROM ${ARTIFACT_LINKS} sal
       JOIN artifacts a ON a.id = sal.artifact_id
      WHERE sal.session_id = $1 AND a.kind = 'pull_request'
      ORDER BY sal.relation, sal.method`,
    sessionId
  );
}

/** Every link row of the session, PR-owned or not, for a whole-set comparison. */
function allLinkRows(db: Db, sessionId: string): Promise<PrLinkRow[]> {
  return db.prisma.client.$queryRawUnsafe<PrLinkRow[]>(
    `SELECT relation, method FROM ${ARTIFACT_LINKS}
      WHERE session_id = $1 ORDER BY relation, method, artifact_id`,
    sessionId
  );
}

async function withDb(
  run: (db: Db, setClock: (at: string) => void) => Promise<void>
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss8905-"));
  let clock = FIRST_IMPORT_AT;
  // allowImportFailures: a DELIBERATELY failed group is this suite's subject, and
  // every test asserts on the specific failure it injected.
  const db = await openTestDb(
    dir,
    { now: () => clock },
    { allowImportFailures: true }
  );
  try {
    await run(db, (at: string) => {
      clock = at;
    });
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** What the seed import left behind, for the caller to assert as its precondition. */
type SeededState = {
  prLinks: PrLinkRow[];
  updatedAt: string;
  owedToCloud: string[];
};

/**
 * The precondition every test rests on: the `normalized_pr` link landed, and the
 * cursor has already delivered the row, so a later selection assertion is about
 * the change under test rather than about the seed.
 */
const DELIVERED_SEED: SeededState = {
  prLinks: [{ relation: "referenced", method: NORMALIZED_PR_METHOD }],
  updatedAt: FIRST_IMPORT_AT,
  owedToCloud: [],
};

async function seedDeliveredPrLink(db: Db): Promise<SeededState> {
  await db.importer.importSession(prLinkedSession(), "claude");
  return {
    prLinks: await prLinkRows(db),
    updatedAt: await updatedAtOf(db, SESSION_ID),
    owedToCloud: await selectedSince(db, FIRST_IMPORT_AT, [SESSION_ID]),
  };
}

/**
 * Mint the `created` session→PR link the removed commit-SHA correlation pass
 * stamped, on the PR artifact the seed already created.
 *
 * This is what RETIRES the `normalized_pr` slice without changing one byte of
 * the session's parsed input: `persistNormalizedPullRequests` mints only
 * `WHERE NOT EXISTS` a link for the same (session, artifact) — relation-agnostic
 * — so once the maintenance pass has minted its own, the conservative link
 * correctly stops being re-derived. Metadata blob, event rows and every other
 * link stay identical, so the PR slice is the ONLY thing that moves and the
 * watermark bump the PR phase owes is the ONLY signal the cloud can get.
 */
async function mintCommitShaCorrelationLink(db: Db): Promise<void> {
  const [artifact] = await db.prisma.client.$queryRawUnsafe<{ id: string }[]>(
    "SELECT id FROM artifacts WHERE kind = 'pull_request' AND pr_number = $1",
    PR_NUMBER
  );
  await write(
    db,
    `INSERT INTO ${ARTIFACT_LINKS}
       (id, session_id, artifact_id, relation, method, evidence, is_primary,
        status, extractor_version, observed_at, created_at)
     VALUES ($1, $2, $3, 'created', $4, '{}', 0, 'confirmed', 1, $5, $5)`,
    "iss8905-correlated-link",
    SESSION_ID,
    artifact?.id,
    COMMIT_SHA_CORRELATION_METHOD,
    FIRST_IMPORT_AT
  );
}

const CORRELATED_LINK: PrLinkRow = {
  relation: "created",
  method: COMMIT_SHA_CORRELATION_METHOD,
};
const MINTED_PR_LINK: PrLinkRow = {
  relation: "referenced",
  method: NORMALIZED_PR_METHOD,
};

test(SILENT_RETIREMENT_TEST, async () => {
  await withDb(async (db, setClock) => {
    assert.deepEqual(await seedDeliveredPrLink(db), DELIVERED_SEED);
    await mintCommitShaCorrelationLink(db);

    // The next byte-identical pass therefore retires the `normalized_pr` link —
    // and every watermark advance aborts. Blocking the bump is what makes this
    // the SILENT case rather than an ordinary one: the input has not changed, so
    // neither the gate nor the events phase owes a bump of its own, and the only
    // thing that can carry the retirement to the cloud is the PR phase's.
    await write(
      db,
      `CREATE TRIGGER ${BLOCK_WATERMARK_TRIGGER}
       BEFORE UPDATE OF updated_at ON sessions
       FOR EACH ROW WHEN NEW.id = '${SESSION_ID}' AND NEW.updated_at IS NOT OLD.updated_at
       BEGIN SELECT RAISE(ABORT, 'ISS-8905 injected watermark failure'); END`
    );
    setClock(BLOCKED_IMPORT_AT);
    const blocked = await db.importer.importSession(
      prLinkedSession(),
      "claude"
    );
    await write(db, `DROP TRIGGER ${BLOCK_WATERMARK_TRIGGER}`);

    assert.deepEqual(
      blocked.failedGroups,
      ["pull_requests"],
      "the group that deletes the PR slice is the group that fails — shared fate"
    );
    assert.deepEqual(
      await prLinkRows(db),
      [CORRELATED_LINK, MINTED_PR_LINK],
      "the teardown rolled back WITH its failed bump: the row is still there, so the next pass can still observe the retirement"
    );
    assert.equal(
      await updatedAtOf(db, SESSION_ID),
      FIRST_IMPORT_AT,
      "nothing durable changed, so nothing is owed to the cursor"
    );

    setClock(RETRY_IMPORT_AT);
    await db.importer.importSession(prLinkedSession(), "claude");

    assert.deepEqual(
      await prLinkRows(db),
      [CORRELATED_LINK],
      "the retry re-derives the retirement and clears the phase's own slice"
    );
    assert.equal(
      await updatedAtOf(db, SESSION_ID),
      RETRY_IMPORT_AT,
      "the retirement reaches the cursor on the retry — the cloud must not keep a link the machine no longer has"
    );
    assert.deepEqual(
      await selectedSince(db, FIRST_IMPORT_AT, [SESSION_ID]),
      [SESSION_ID],
      "the incremental scan must re-select the session so the retired link is unpublished"
    );
  });
});

test("ISS-8905: a failed pull-requests group leaves the PR-owned slice exactly as it found it", async () => {
  await withDb(async (db, setClock) => {
    assert.deepEqual(await seedDeliveredPrLink(db), DELIVERED_SEED);

    // Abort the one INSERT only the pull-requests phase issues. Its teardown of
    // the same slice now runs in this same transaction, so the rollback has to
    // take the DELETE back with it.
    await write(
      db,
      `CREATE TRIGGER ${BLOCK_PR_LINK_INSERT_TRIGGER}
       BEFORE INSERT ON ${ARTIFACT_LINKS}
       FOR EACH ROW WHEN NEW.session_id = '${SESSION_ID}'
         AND NEW.method = '${NORMALIZED_PR_METHOD}'
       BEGIN SELECT RAISE(ABORT, 'ISS-8905 injected pull-requests failure'); END`
    );
    setClock(BLOCKED_IMPORT_AT);
    const blocked = await db.importer.importSession(
      prLinkedSession(),
      "claude"
    );
    await write(db, `DROP TRIGGER ${BLOCK_PR_LINK_INSERT_TRIGGER}`);

    assert.deepEqual(
      blocked.failedGroups,
      ["pull_requests"],
      "only the pull-requests group may fail"
    );
    assert.deepEqual(
      await prLinkRows(db),
      [{ relation: "referenced", method: NORMALIZED_PR_METHOD }],
      "delete-and-restore are all-or-nothing: a failed group must not leave the row deleted"
    );
    assert.equal(
      await updatedAtOf(db, SESSION_ID),
      FIRST_IMPORT_AT,
      "a rolled-back change owes no bump — and needs no compensating one"
    );
  });
});

/*
 * WHAT THIS TEST DOES AND DOES NOT GUARD. It proves the same-relation
 * interleaving is SAFE — no unique-constraint violation, no shadowed extractor
 * claim — but it cannot fail against either pre-fix variant, because
 * `LINK_UPSERT_CONFLICT` overwrites `method` unconditionally on the conflicting
 * key, so the stale row leaves this phase's slice whether or not the phase tears
 * its slice down. Read it as a safety property of the new interleaving, NOT as
 * regression coverage for the teardown move; the different-relation test below is
 * the one that discriminates.
 */
test("ISS-8905: a stale PR link on the SAME relation is claimed by the extractor, not collided with", async () => {
  await withDb(async (db, setClock) => {
    assert.deepEqual(await seedDeliveredPrLink(db), DELIVERED_SEED);

    // The stale `normalized_pr` row from the seed is still present when the
    // artifact-links phase runs, and the extractor's ref lands on the SAME
    // (session, artifact, relation) the unique index keys on.
    setClock(RETRY_IMPORT_AT);
    const result = await db.importer.importSession(
      prReferencedInToolUseSession(),
      "claude"
    );

    assert.equal(
      result.failedGroups,
      undefined,
      "the surviving stale row must not violate the unique (session, artifact, relation)"
    );
    assert.deepEqual(
      await prLinkRows(db),
      [{ relation: "referenced", method: PR_URL_IN_TOOL_USE_METHOD }],
      "exactly one link, claimed by the extractor: the stale row neither survived alongside it nor shadowed it"
    );
  });
});

test("ISS-8905: a stale PR link on a DIFFERENT relation is retired by the phase's own teardown, not left to accumulate", async () => {
  await withDb(async (db, setClock) => {
    assert.deepEqual(await seedDeliveredPrLink(db), DELIVERED_SEED);

    // The extractor now claims relation `created`, so nothing upserts over the
    // stale `referenced`/`normalized_pr` row and the two coexist through the
    // whole artifact-links phase. Only the pull-requests phase's own DELETE can
    // retire it — remove that DELETE and the stale row is still here afterwards,
    // permanently, because the conservative mint's `WHERE NOT EXISTS` then sees
    // the `created` row and never rewrites the slice.
    setClock(RETRY_IMPORT_AT);
    const result = await db.importer.importSession(
      prCreatedInToolUseSession(),
      "claude"
    );

    assert.equal(
      result.failedGroups,
      undefined,
      "no group may fail on the coexisting-rows interleaving"
    );
    assert.deepEqual(
      await prLinkRows(db),
      [{ relation: "created", method: PR_CREATE_OUTPUT_METHOD }],
      "the extractor's created link is the only survivor — the stale referenced row was torn down, not accumulated beside it"
    );
  });
});

test("ISS-8905: the phase's own teardown re-mints the link rather than letting the stale row shadow it", async () => {
  await withDb(async (db, setClock) => {
    assert.deepEqual(await seedDeliveredPrLink(db), DELIVERED_SEED);

    // A sentinel only a SURVIVING row can still carry. `persistNormalizedPullRequests`
    // mints `WHERE NOT EXISTS (session_id, artifact_id)`, so if the phase's own
    // DELETE did not run first, the stale row would satisfy that predicate, the
    // mint would be skipped, and the sentinel would still be here afterwards.
    const staleObservedAt = "1999-01-01T00:00:00.000Z";
    await write(
      db,
      `UPDATE ${ARTIFACT_LINKS} SET observed_at = $1
        WHERE session_id = $2 AND method = $3`,
      staleObservedAt,
      SESSION_ID,
      NORMALIZED_PR_METHOD
    );

    setClock(RETRY_IMPORT_AT);
    await db.importer.importSession(prLinkedSession(), "claude");

    const observedAt = await db.prisma.client.$queryRawUnsafe<
      { observed_at: string }[]
    >(
      `SELECT observed_at FROM ${ARTIFACT_LINKS}
        WHERE session_id = $1 AND method = $2`,
      SESSION_ID,
      NORMALIZED_PR_METHOD
    );
    assert.equal(observedAt.length, 1, "the link is still a single row");
    assert.notEqual(
      observedAt[0]?.observed_at,
      staleObservedAt,
      "the row was torn down and re-minted — a shadowed mint would have left the sentinel"
    );
  });
});

/*
 * An EQUIVALENCE property, not regression coverage: it asserts the two
 * orchestrations agree, which they also did before this change, so it passes
 * against both pre-fix variants. What it is for is the ticket's requirement that
 * `importSessionWithTx` be behavior-NEUTRAL under the moved teardown — a claim
 * that can only be proved by running both paths over the same input, and that
 * would go red if this change had made the single-transaction rebuild diverge.
 */
test("ISS-8905: the single-transaction rebuild path produces the same links as the isolated import path", async () => {
  await withDb(async (db, setClock) => {
    // Two sessions, identical inputs applied in the same order: a pass that
    // mints the `normalized_pr` link, then a pass whose extractor claims the
    // same natural key while that stale row is still present — the exact
    // interleaving the moved teardown introduces. Only the ORCHESTRATION
    // differs: `importSessionIsolated` (twelve transactions) for one,
    // `importSessionWithTx` (one) for the other. Both are terminal so the
    // rebuild's non-terminal guard admits it.
    await db.importer.importSession(
      terminalPrLinkedSession(SESSION_ID),
      "claude"
    );
    await db.importer.importSession(
      terminalPrLinkedSession(REBUILD_SESSION_ID),
      "claude"
    );

    setClock(RETRY_IMPORT_AT);
    await db.importer.importSession(
      terminalPrReferencedInToolUseSession(SESSION_ID),
      "claude"
    );
    const rebuilt = await db.rebuildSessionFromParse(
      terminalPrReferencedInToolUseSession(REBUILD_SESSION_ID),
      "claude"
    );

    assert.equal(rebuilt.rebuilt, true, "the rebuild must have run");
    assert.deepEqual(
      await allLinkRows(db, REBUILD_SESSION_ID),
      await allLinkRows(db, SESSION_ID),
      "the rebuild path is behavior-neutral under the moved teardown"
    );
    assert.deepEqual(
      await prLinkRows(db, REBUILD_SESSION_ID),
      [{ relation: "referenced", method: PR_URL_IN_TOOL_USE_METHOD }],
      "and both landed on the extractor's claim, not a surviving stale row"
    );
  });
});
