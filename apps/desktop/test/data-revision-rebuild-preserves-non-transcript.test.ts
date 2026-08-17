/**
 * @file data-revision-rebuild-preserves-non-transcript.test.ts
 * @description ISS-4606 — a DATA_REVISION rebuild re-parses a session from its
 * transcript, so it may only tear down what that transcript can re-derive.
 * `rebuildSessionFromParse` used to delete `events`, `session_artifact_links`,
 * `pull_requests`, and the `claude_code_*` OTel tables WHOLESALE, destroying
 * rows only a non-transcript producer ever writes:
 *
 *   - hook-stream events (Notification / SessionStart / UserPromptSubmit)
 *   - the `commit_sha_correlation` PR link minted by the post-boot maintenance
 *     pass — the FEA-4379 guarantee, which covered re-import but not rebuild
 *   - the PR lifecycle (`state`/`merged_at`/`closed_at`/`opened_at`) written by
 *     GitHub enrichment
 *
 * None of it survives a transcript re-read, so the rebuild was where it went
 * permanently missing. This drives the REAL `runDataRevisionRebuild` against the
 * production `openSqliteAgentDatabase` (no Electron) and asserts each survives,
 * with negative controls proving the parser-owned teardown still runs.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DATA_REVISION } from "../src/main/collectors/engine/data-revision.js";
import { runDataRevisionRebuild } from "../src/main/collectors/engine/data-revision-rebuild.js";
import { COMMIT_SHA_CORRELATION_METHOD } from "../src/main/database/pr-link-maintenance.js";
import { PrState } from "../src/main/enrichment/types.js";
import {
  ClaudeCodeOtelTableName,
  ClaudeCodePermissionDecision,
  ClaudeCodePermissionSource,
} from "../src/main/otel/claude-code-persistence.js";
import { openTestDb } from "./agent-db-test-utils.js";
import {
  fakeCollector,
  makePopulatedSession as makeSession,
} from "./normalized-session-test-utils.js";

const REPO = "owner/repo";
const HEAD_SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const SID = "iss4606-rebuild";
const PR_NUMBER = 42;
const MERGED_AT = "2026-06-06T00:00:00.000Z";
const CLOSED_AT = "2026-06-06T00:00:01.000Z";
const OPENED_AT = "2026-06-05T00:00:00.000Z";
const HOOK_EVENT_TYPES = [
  "Notification",
  "SessionStart",
  "UserPromptSubmit",
] as const;
/** A parser-owned event type — the negative control. */
const PARSER_EVENT_TYPE = "Stop";
const CLAUDE_CODE_OTEL_TABLES = [
  ClaudeCodeOtelTableName.CostEvent,
  ClaudeCodeOtelTableName.PermissionEvent,
  ClaudeCodeOtelTableName.ApiRequest,
] as const;

type Db = Awaited<ReturnType<typeof openTestDb>>;

test("ISS-4606: the DATA_REVISION rebuild preserves every non-transcript-sourced row", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss4606-rebuild-"));
  const db = await openTestDb(dir);
  try {
    // The PR must be a real artifact ref so the RE-PARSE re-derives the same
    // row: `pull_requests.id` is a deterministic hash of
    // (harness, sessionId, prUrl), and the preserved-field seed is keyed by it.
    const session = makeSession({
      sessionId: SID,
      artifacts: {
        prs: [
          {
            number: String(PR_NUMBER),
            repo: REPO,
            url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
          },
        ],
        issues: [],
        repo: REPO,
      },
    });
    await db.importer.importSession(session, "claude");

    const minted = await seedCorrelationLink(db);
    assert.equal(minted, 1, "the maintenance pass minted the correlation link");
    await seedHookEvents(db);
    await seedEnrichedPullRequest(db);
    await seedClaudeCodeOtelRows(db);

    assert.deepEqual(
      await snapshot(db),
      {
        correlationLinks: 1,
        parserMethodLinks: 1,
        hookEvents: HOOK_EVENT_TYPES.length,
        staleParserEvents: 1,
        prState: PrState.Merged,
        prMergedAt: MERGED_AT,
        prClosedAt: CLOSED_AT,
        prOpenedAt: OPENED_AT,
      },
      "precondition: every seeded row is present before the rebuild"
    );

    await db.run(
      "UPDATE sessions SET data_revision = 1, status = 'inactive' WHERE id = $1",
      SID
    );
    const result = await runDataRevisionRebuild({
      collectors: [
        fakeCollector("claude", {
          sources: [`/fake/${SID}.jsonl`],
          parse: () => Promise.resolve([session]),
          sessionIdForSource: () => SID,
        }),
      ],
      db,
    });
    assert.equal(result.rebuilt, 1, "precondition: the session was rebuilt");

    const after = await snapshot(db);

    // --- preserved: nothing here is re-derivable from the transcript ---
    assert.equal(
      after.correlationLinks,
      1,
      "the minted commit_sha_correlation link survives the rebuild (FEA-4379)"
    );
    assert.equal(
      after.hookEvents,
      HOOK_EVENT_TYPES.length,
      "hook-stream events survive the rebuild"
    );
    assert.equal(
      after.prState,
      PrState.Merged,
      "the enrichment-written PR state survives the rebuild"
    );
    assert.equal(after.prMergedAt, MERGED_AT, "merged_at survives the rebuild");
    assert.equal(after.prClosedAt, CLOSED_AT, "closed_at survives the rebuild");
    assert.equal(after.prOpenedAt, OPENED_AT, "opened_at survives the rebuild");

    // --- negative controls: the parser-owned teardown still runs ---
    assert.equal(
      after.parserMethodLinks,
      0,
      "a parser-method link the re-parse no longer yields is still cleared"
    );
    assert.equal(
      after.staleParserEvents,
      0,
      "a stale parser-owned event is still purged and re-derived"
    );

    // Relocated from `data-revision-rebuild.test.ts` (grandfathered, shrink-only):
    // the claude_code_* OTel rows arrive by push and no transcript re-read can
    // re-derive them, so they must outlive the rebuild — matching the Codex OTel
    // sibling already pinned as preserved there.
    for (const tableName of CLAUDE_CODE_OTEL_TABLES) {
      const [row] = await db.prisma.client.$queryRawUnsafe<{ cnt: number }[]>(
        `SELECT COUNT(*) AS cnt FROM ${tableName} WHERE session_id = $1`,
        SID
      );
      assert.equal(
        Number(row.cnt),
        1,
        `${tableName} rows survive the rebuild (OTel push is not re-derivable)`
      );
    }
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-4606: a compacted session keeps its token_usage baseline ledger across a rebuild", async () => {
  // `baseline_*` holds the tokens that rolled out of a COMPACTED transcript:
  // `replace` moves the old totals there when a re-derivation comes back lower,
  // and every read site folds them back into effective totals. The transcript no
  // longer contains that history, so a rebuild that dropped the row zeroed them
  // and permanently undercounted local and synced usage — measured 9999 -> 0.
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss4606-baseline-"));
  const db = await openTestDb(dir);
  const sessionId = "iss4606-compacted";
  try {
    const session = makeSession({ sessionId });
    await db.importer.importSession(session, "claude");
    await db.run(
      `UPDATE token_usage
          SET baseline_input = 9999, baseline_output = 8888,
              baseline_cache_read = 777, baseline_cache_write = 66
        WHERE session_id = $1`,
      sessionId
    );
    const before = await readBaselines(db, sessionId);
    assert.deepEqual(
      before,
      [
        {
          model: "claude-sonnet-4-5",
          input: 9999,
          output: 8888,
          cacheRead: 777,
          cacheWrite: 66,
        },
      ],
      "precondition: the compaction ledger is populated"
    );

    await db.run(
      "UPDATE sessions SET data_revision = 1, status = 'inactive' WHERE id = $1",
      sessionId
    );
    const result = await runDataRevisionRebuild({
      collectors: [
        fakeCollector("claude", {
          sources: [`/fake/${sessionId}.jsonl`],
          parse: () => Promise.resolve([session]),
          sessionIdForSource: () => sessionId,
        }),
      ],
      db,
    });
    assert.equal(result.rebuilt, 1, "precondition: the session was rebuilt");

    assert.deepEqual(
      await readBaselines(db, sessionId),
      before,
      "the compaction ledger survives the rebuild intact"
    );
    // The ledger is restored BEFORE the after-fingerprint is taken, so an
    // otherwise byte-identical re-derivation stays a true sync no-op.
    assert.deepEqual(
      result.changedSessionIds,
      [],
      "restoring the ledger does not itself mark the session changed"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function readBaselines(db: Db, sessionId: string) {
  const rows = await db.prisma.client.$queryRawUnsafe<
    {
      model: string;
      baseline_input: bigint | number;
      baseline_output: bigint | number;
      baseline_cache_read: bigint | number;
      baseline_cache_write: bigint | number;
    }[]
  >(
    `SELECT model, baseline_input, baseline_output, baseline_cache_read, baseline_cache_write
       FROM token_usage WHERE session_id = $1 ORDER BY model`,
    sessionId
  );
  return rows.map((row) => ({
    model: row.model,
    input: Number(row.baseline_input),
    output: Number(row.baseline_output),
    cacheRead: Number(row.baseline_cache_read),
    cacheWrite: Number(row.baseline_cache_write),
  }));
}

/**
 * Mint a `commit_sha_correlation` PR link through the REAL maintenance pass, the
 * only producer of that method. A `git_commit` link on the same commit artifact
 * rides along as the negative control: the re-parsed fixture yields no artifact
 * refs, so the parser-owned teardown must clear it.
 */
async function seedCorrelationLink(db: Db): Promise<number> {
  // The import already created the PR artifact from the session's ref; give it
  // the enrichment-supplied head SHA the correlation pass matches on.
  await db.run(
    `UPDATE artifacts SET head_sha = $1
       WHERE kind = 'pull_request' AND repo_full_name = $2 AND pr_number = ${PR_NUMBER}`,
    HEAD_SHA,
    REPO
  );
  await db.run(
    `INSERT INTO artifacts (id, identity_key, kind, repo_full_name, sha, created_at, last_seen_at)
       VALUES ('commit-art', $1, 'commit', $2, $3, 't1', 't1')`,
    `commit:${REPO}:${HEAD_SHA}`,
    REPO,
    HEAD_SHA
  );
  await db.run(
    `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence, is_primary, status, extractor_version, observed_at, created_at)
       VALUES ('link-commit', $1, 'commit-art', 'created', 'git_commit', '{}', 0, 'confirmed', 1, 't1', 't1')`,
    SID
  );
  return await db.correlateCommitShaPrLinks();
}

/**
 * Hook-only event types the importer never re-emits, plus a stale row of a
 * parser-owned type as the negative control.
 */
async function seedHookEvents(db: Db): Promise<void> {
  let index = 0;
  for (const eventType of HOOK_EVENT_TYPES) {
    index++;
    await db.run(
      `INSERT INTO events (id, session_id, event_type, created_at)
         VALUES ($1, $2, $3, $4)`,
      `hook-evt-${index}`,
      SID,
      eventType,
      `2026-06-07T10:00:0${index}.000Z`
    );
  }
  await db.run(
    `INSERT INTO events (id, session_id, event_type, created_at)
       VALUES ('stale-parser-evt', $1, $2, '2026-06-07T10:00:09.000Z')`,
    SID,
    PARSER_EVENT_TYPE
  );
}

/**
 * Put the PR row into its post-lifecycle-write shape on the row the import
 * already created.
 *
 * PLN-1535 M5: previously seeded through the desktop enrichment writer, which
 * this milestone deleted along with the rest of the dead local sweep. The
 * subject of these tests is the data-revision rebuild's preservation of
 * non-transcript columns, not who wrote them — so the fixture writes the same
 * columns directly, matching the COALESCE-preserve statement the deleted writer
 * issued, and every assertion below is unchanged.
 */
async function seedEnrichedPullRequest(db: Db): Promise<void> {
  await db.run(
    `UPDATE pull_requests SET
       state = $1,
       branch_name = COALESCE($2, branch_name),
       merged_at = COALESCE(merged_at, $3),
       closed_at = COALESCE(closed_at, $4),
       opened_at = COALESCE(opened_at, $5)
     WHERE repo_full_name = $6 AND pr_number = $7`,
    PrState.Merged,
    "feat/iss-4606",
    MERGED_AT,
    CLOSED_AT,
    OPENED_AT,
    REPO,
    PR_NUMBER
  );
}

/** OTel-pushed rows — no transcript re-read can produce these. */
async function seedClaudeCodeOtelRows(db: Db): Promise<void> {
  await db.run(
    `INSERT INTO ${ClaudeCodeOtelTableName.CostEvent} (id, session_id, model, cost_usd, observed_at, data_revision, created_at, updated_at)
     VALUES ($1, $2, 'claude-sonnet-4-5', 1.25, '2026-06-07T10:00:40.000Z', $3, '2026-06-07T10:00:40.000Z', '2026-06-07T10:00:40.000Z')`,
    `${SID}-otel-cost`,
    SID,
    DATA_REVISION
  );
  await db.run(
    `INSERT INTO ${ClaudeCodeOtelTableName.PermissionEvent} (id, session_id, tool_name, decision, source, observed_at, data_revision, created_at, updated_at)
     VALUES ($1, $2, 'Bash', $3, $4, '2026-06-07T10:00:41.000Z', $5, '2026-06-07T10:00:41.000Z', '2026-06-07T10:00:41.000Z')`,
    `${SID}-otel-permission`,
    SID,
    ClaudeCodePermissionDecision.Allow,
    ClaudeCodePermissionSource.Hook,
    DATA_REVISION
  );
  await db.run(
    `INSERT INTO ${ClaudeCodeOtelTableName.ApiRequest} (id, session_id, model, tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation, cost_usd, started_at, duration_ms, data_revision, created_at, updated_at)
     VALUES ($1, $2, 'claude-sonnet-4-5', 100, 50, 10, 5, 1.75, '2026-06-07T10:00:42.000Z', 2500, $3, '2026-06-07T10:00:42.000Z', '2026-06-07T10:00:42.000Z')`,
    `${SID}-otel-api-request`,
    SID,
    DATA_REVISION
  );
}

async function snapshot(db: Db) {
  const [links, hookEvents, staleParserEvents, pr] = await Promise.all([
    db.prisma.client.$queryRawUnsafe<{ method: string; cnt: number }[]>(
      `SELECT method, COUNT(*) AS cnt FROM session_artifact_links
         WHERE session_id = $1 GROUP BY method`,
      SID
    ),
    db.prisma.client.$queryRawUnsafe<{ cnt: number }[]>(
      `SELECT COUNT(*) AS cnt FROM events
         WHERE session_id = $1 AND event_type IN ('Notification', 'SessionStart', 'UserPromptSubmit')`,
      SID
    ),
    db.prisma.client.$queryRawUnsafe<{ cnt: number }[]>(
      "SELECT COUNT(*) AS cnt FROM events WHERE id = 'stale-parser-evt'"
    ),
    db.prisma.client.$queryRawUnsafe<
      {
        state: string | null;
        merged_at: string | null;
        closed_at: string | null;
        opened_at: string | null;
      }[]
    >(
      "SELECT state, merged_at, closed_at, opened_at FROM pull_requests WHERE session_id = $1",
      SID
    ),
  ]);
  const byMethod = new Map(links.map((r) => [r.method, Number(r.cnt)]));
  return {
    correlationLinks: byMethod.get(COMMIT_SHA_CORRELATION_METHOD) ?? 0,
    parserMethodLinks: byMethod.get("git_commit") ?? 0,
    hookEvents: Number(hookEvents[0].cnt),
    staleParserEvents: Number(staleParserEvents[0].cnt),
    prState: pr[0]?.state ?? null,
    prMergedAt: pr[0]?.merged_at ?? null,
    prClosedAt: pr[0]?.closed_at ?? null,
    prOpenedAt: pr[0]?.opened_at ?? null,
  };
}
