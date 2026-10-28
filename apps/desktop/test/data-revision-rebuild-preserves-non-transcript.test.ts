/**
 * @file data-revision-rebuild-preserves-non-transcript.test.ts
 * @description ISS-4606 — a DATA_REVISION rebuild re-parses a session from its
 * transcript, so it may only tear down what that transcript can re-derive.
 * `rebuildSessionFromParse` used to delete `events`, `session_artifact_links`,
 * `agents`, `pull_requests`, and the `claude_code_*` OTel tables WHOLESALE,
 * destroying rows only a non-transcript producer ever writes:
 *
 *   - hook-stream events (Notification / SessionStart / UserPromptSubmit)
 *   - a `commit_sha_correlation` PR link stored by the removed post-boot
 *     correlation pass — the FEA-4379 guarantee, which covered re-import but not
 *     rebuild
 *   - the live-hook spawner's non-terminal (`working`) subagent `agents` rows
 *   - the PR lifecycle (`closed_at`/`opened_at`) written by
 *     GitHub enrichment
 *
 * None of it survives a transcript re-read, so the rebuild was where it went
 * permanently missing. This drives the REAL `runDataRevisionRebuild` against the
 * production `openSqliteAgentDatabase` (no Electron) and asserts each survives,
 * with negative controls proving the parser-owned teardown still runs.
 *
 * ISS-10644 adds the `agent_id` half of the `events` teardown. Every event this
 * file seeded left `agent_id` NULL, and a NULL never matches an `IN` list, so
 * the id-scoped sweep ISS-5107 added could delete everything or nothing without
 * moving a single assertion here.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  NormalizedSession,
  NormalizedSubagent,
} from "@repo/lib/harness/types";
import { test } from "vitest";
import { runDataRevisionRebuild } from "../src/main/collectors/engine/data-revision-rebuild.js";
import { effectiveDataRevision } from "../src/main/collectors/engine/effective-data-revision.js";
import { DESKTOP_AGENT_STATUS } from "../src/main/database/db-constants.js";
import { mintParserSubagentAgentIds } from "../src/main/database/import-metadata-builders.js";
import { COMMIT_SHA_CORRELATION_METHOD } from "../src/main/database/pr-link-maintenance.js";
import { mainAgentId } from "../src/main/database/write-core-main-agent-spine.js";
import {
  ClaudeCodeOtelTableName,
  ClaudeCodePermissionDecision,
  ClaudeCodePermissionSource,
} from "../src/main/otel/claude-code-otel-signal-contract.js";
import { openTestDb } from "./agent-db-test-utils.js";
import {
  fakeCollector,
  makePopulatedSession as makeSession,
} from "./normalized-session-test-utils.js";

const REPO = "owner/repo";
const HEAD_SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const SID = "iss4606-rebuild";
const PR_NUMBER = 42;
const CLOSED_AT = "2026-06-06T00:00:01.000Z";
const OPENED_AT = "2026-06-05T00:00:00.000Z";
const HOOK_EVENT_TYPES = [
  "Notification",
  "SessionStart",
  "UserPromptSubmit",
] as const;
/** A parser-owned event type — the negative control. */
const PARSER_EVENT_TYPE = "Stop";
/** The `description` the live-hook spawner turns into the subagent row's name. */
const HOOK_SUBAGENT_NAME = "hook-spawned subagent";
/** Lands in the hook row's `metadata`, the column the SubagentStop match reads. */
const HOOK_NATIVE_SUBAGENT_ID = "agent-iss4606";
/** A parser-namespace subagent id — matched by the import's own scoped purge. */
const STALE_PARSER_SUBAGENT_ID = "iss4606-agents-parser-sub-stale";
/**
 * One subagent per terminal status the parser can write, so the re-parse covers
 * both arms of the `status IN ('completed', 'error')` purge the rebuild now
 * relies on. Dropping either arm leaves the seeded corruption in place.
 */
const PARSER_SUBAGENTS: NormalizedSubagent[] = [
  {
    id: "parsed-ok",
    name: "Parsed subagent",
    type: "explorer",
    task: "parsed task",
    status: DESKTOP_AGENT_STATUS.COMPLETED,
    startedAt: "2026-06-07T10:00:10.000Z",
    endedAt: "2026-06-07T10:00:20.000Z",
  },
  {
    id: "parsed-failed",
    name: "Parsed failed subagent",
    type: "explorer",
    task: "parsed failing task",
    status: DESKTOP_AGENT_STATUS.ERROR,
    startedAt: "2026-06-07T10:00:30.000Z",
    endedAt: "2026-06-07T10:00:40.000Z",
  },
];
const CLAUDE_CODE_OTEL_TABLES = [
  ClaudeCodeOtelTableName.CostEvent,
  ClaudeCodeOtelTableName.PermissionEvent,
  ClaudeCodeOtelTableName.ApiRequest,
] as const;
/**
 * The type the ISS-10644 fixture keys its agent-scoped events to. It must be one
 * the import's unconditional `event_type IN (...)` purge does NOT name: that
 * DELETE clears its types whatever `agent_id` they carry, so a row of one of
 * them can say nothing about the id-scoped sweep. Derived from
 * {@link HOOK_EVENT_TYPES}, which is exactly that set, so the two cannot drift.
 */
const AGENT_KEYED_EVENT_TYPE = HOOK_EVENT_TYPES[0];
/** Chosen to sort dropped < main < retained, the order `ORDER BY id` returns. */
const DROPPED_AGENT_EVENT_ID = "iss10644-evt-dropped";
const MAIN_AGENT_EVENT_ID = "iss10644-evt-main";
const RETAINED_AGENT_EVENT_ID = "iss10644-evt-retained";

type Db = Awaited<ReturnType<typeof openTestDb>>;

test("ISS-4606: the effectiveDataRevision() rebuild preserves every non-transcript-sourced row", async () => {
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

    await seedCorrelationLink(db);
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
        prClosedAt: CLOSED_AT,
        prOpenedAt: OPENED_AT,
      },
      "precondition: every seeded row is present before the rebuild"
    );

    const result = await rebuildSessionOnce(db, session);
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

    const result = await rebuildSessionOnce(db, session);
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

test("ISS-4606: the rebuild spares live-hook agent rows and still re-derives the parser's own", async () => {
  // The rebuild's `agents` teardown was the last unscoped delete on this path.
  // The parser writes subagent rows ONLY with a terminal status, so
  // `importPhaseEvents`'s scoped purge already covers everything a re-parse can
  // re-derive; the extra rows the wholesale delete took were the live-hook
  // spawner's `status = 'working'` ones, pushed by a hook with no transcript to
  // re-read them from. The teardown is now the `<id>-main` spine alone.
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss4606-agents-"));
  const db = await openTestDb(dir);
  const sessionId = "iss4606-agents";
  try {
    // The fixture carries one subagent per terminal status the parser can write,
    // so the re-parse genuinely re-derives both arms of `importPhaseEvents`'s
    // purge predicate — the teardown this change hands sole ownership to.
    const session = makeSession({ sessionId, subagents: PARSER_SUBAGENTS });
    const parserAgentIds = mintParserSubagentAgentIds(session);
    const mainId = mainAgentId(sessionId);
    await db.importer.importSession(session, "claude");

    // The REAL live-hook producer: a `Task` PreToolUse spawns the subagent row.
    await db.processEvent(
      "PreToolUse",
      {
        session_id: sessionId,
        tool_name: "Task",
        tool_input: {
          description: HOOK_SUBAGENT_NAME,
          prompt: "hook prompt",
          subagent_id: HOOK_NATIVE_SUBAGENT_ID,
        },
      },
      "claude"
    );
    // Negative control 1: a parser-namespace TERMINAL subagent row the re-parsed
    // fixture no longer yields. The import's own purge must still clear it.
    await db.run(
      `INSERT INTO agents (id, session_id, name, type, subagent_type, status, started_at, updated_at, parent_agent_id)
         VALUES ($1, $2, 'stale', 'subagent', NULL, $3, $4, $4, $5)`,
      STALE_PARSER_SUBAGENT_ID,
      sessionId,
      DESKTOP_AGENT_STATUS.COMPLETED,
      "2026-01-01T00:01:00.000Z",
      mainId
    );
    // Negative control 2: corrupt every parser-OWNED row — the `<id>-main` spine
    // and both re-derivable subagents. A teardown that stops covering any of them
    // leaves the corruption in place, because both re-inserts below are
    // ON CONFLICT DO NOTHING and can never refresh a surviving row.
    await db.run(
      "UPDATE agents SET name = 'corrupted', task = 'corrupted', started_at = '1999-01-01T00:00:00.000Z' WHERE id IN ($1, $2, $3)",
      mainId,
      ...PARSER_SUBAGENTS.map((sub) => parserAgentIds.get(sub.id))
    );

    const before = await readAgents(db, sessionId);
    const hookAgent = before.find((row) => row.name === HOOK_SUBAGENT_NAME);
    assert.equal(
      hookAgent?.status,
      DESKTOP_AGENT_STATUS.WORKING,
      "precondition: the live hook spawned a non-terminal subagent row"
    );
    assert.equal(
      before.some((row) => row.id === STALE_PARSER_SUBAGENT_ID),
      true,
      "precondition: the stale parser subagent row is present"
    );

    const result = await rebuildSessionOnce(db, session);
    assert.equal(result.rebuilt, 1, "precondition: the session was rebuilt");

    const after = await readAgents(db, sessionId);
    // --- preserved: a hook push is not re-derivable from a transcript ---
    assert.deepEqual(
      after.find((row) => row.id === hookAgent?.id),
      hookAgent,
      "the live-hook subagent row survives the rebuild unchanged"
    );
    // --- negative controls: the parser-owned teardown still runs ---
    assert.equal(
      after.some((row) => row.id === STALE_PARSER_SUBAGENT_ID),
      false,
      "a stale parser-namespace subagent row is still cleared"
    );
    assert.deepEqual(
      PARSER_SUBAGENTS.map((sub) => {
        const row = after.find((r) => r.id === parserAgentIds.get(sub.id));
        return { name: row?.name, status: row?.status, task: row?.task };
      }),
      PARSER_SUBAGENTS.map((sub) => ({
        name: sub.name,
        status: sub.status,
        task: sub.task,
      })),
      "both re-derivable parser subagents heal, so the import's purge covers every status it writes"
    );
    assert.equal(
      after.find((row) => row.id === mainId)?.name,
      "main",
      "the main-agent spine is torn down and re-derived, healing its corruption"
    );
    assert.equal(
      after.find((row) => row.id === mainId)?.startedAt,
      session.startedAt,
      "the re-derived spine carries the re-parsed start, not the corrupted one"
    );

    // FEA-3659 interaction: `agents` is one of the fingerprinted synced child-row
    // projections, so a preserved row must be preserved IDENTICALLY — a teardown
    // that churned it would score every later rebuild as changed and re-push a
    // byte-identical session forever. Rebuild the now-settled session again and
    // assert the surviving hook row makes it a true sync no-op.
    const second = await rebuildSessionOnce(db, session);
    assert.equal(second.rebuilt, 1, "precondition: the session rebuilt again");
    assert.deepEqual(
      second.changedSessionIds,
      [],
      "a preserved hook agent row does not itself mark the session changed"
    );
    assert.deepEqual(
      await readAgents(db, sessionId),
      after,
      "a repeat rebuild leaves the agent rows byte-identical"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-10644: the rebuild keeps hook events keyed to the main spine and to a re-minted subagent", async () => {
  // The sweep's input is the purged subagent set MINUS the ids the reparse
  // re-mints, so a stable-id subagent is deleted and re-created by the same
  // phase and its hook-only events must ride through. Sweeping the whole purged
  // set instead — the shape #7397 replaced — takes them.
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss10644-retained-"));
  const db = await openTestDb(dir);
  const sessionId = "iss10644-retained";
  try {
    const fixture = await seedAgentKeyedEvents(db, sessionId);
    assert.deepEqual(
      await readAgentKeyedEvents(db, sessionId),
      [
        { id: DROPPED_AGENT_EVENT_ID, agentId: fixture.droppedAgentId },
        { id: MAIN_AGENT_EVENT_ID, agentId: fixture.mainId },
        { id: RETAINED_AGENT_EVENT_ID, agentId: fixture.retainedAgentId },
      ],
      "precondition: one event per agent-id class, each carrying a non-null agent_id"
    );
    assert.ok(
      (await readAgents(db, sessionId)).some(
        (row) => row.id === fixture.retainedAgentId
      ),
      "precondition: the importer minted the retained subagent's agents row, so its id really is in the purged set the sweep subtracts from"
    );

    const result = await rebuildSessionOnce(db, fixture.session);
    assert.equal(result.rebuilt, 1, "precondition: the session was rebuilt");

    const after = await readAgentKeyedEvents(db, sessionId);
    assert.deepEqual(
      after.find((row) => row.id === MAIN_AGENT_EVENT_ID),
      { id: MAIN_AGENT_EVENT_ID, agentId: fixture.mainId },
      "an event keyed to the main spine survives the rebuild"
    );
    assert.deepEqual(
      after.find((row) => row.id === RETAINED_AGENT_EVENT_ID),
      { id: RETAINED_AGENT_EVENT_ID, agentId: fixture.retainedAgentId },
      "an event keyed to a subagent the reparse re-mints survives the rebuild"
    );
    assert.ok(
      (await readAgents(db, sessionId)).some(
        (row) => row.id === fixture.retainedAgentId
      ),
      "the reparse re-mints that agents row, so the event above rode through the sweep instead of never entering it"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-10644: the rebuild sweeps hook events keyed to a subagent the reparse drops", async () => {
  // The other half of the same `agent_id IN (...)` arm: a terminal parser-
  // namespace subagent the reparse no longer yields loses its `agents` row, so
  // its events are left naming nothing. `events.agent_id` has no FK, so nothing
  // else refuses the strand.
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss10644-dropped-"));
  const db = await openTestDb(dir);
  const sessionId = "iss10644-dropped";
  try {
    const fixture = await seedAgentKeyedEvents(db, sessionId);
    assert.equal(
      (await readAgentKeyedEvents(db, sessionId)).some(
        (row) => row.id === DROPPED_AGENT_EVENT_ID
      ),
      true,
      "precondition: the dropped agent's event is present before the rebuild"
    );

    const result = await rebuildSessionOnce(db, fixture.session);
    assert.equal(result.rebuilt, 1, "precondition: the session was rebuilt");

    assert.equal(
      (await readAgentKeyedEvents(db, sessionId)).some(
        (row) => row.id === DROPPED_AGENT_EVENT_ID
      ),
      false,
      "an event keyed to a subagent the reparse drops is swept (ISS-5107)"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Every column the live-hook spawner writes, so "survives unchanged" means the
 * whole hook-owned payload — `task` (the delegation prompt) and `metadata` (the
 * native subagent id `resolveNativeSubagentTranscriptPath` reads back) above
 * all — not just the row's continued existence.
 */
async function readAgents(db: Db, sessionId: string) {
  const rows = await db.prisma.client.$queryRawUnsafe<
    {
      id: string;
      name: string | null;
      type: string | null;
      subagent_type: string | null;
      status: string;
      task: string | null;
      current_tool: string | null;
      started_at: string | null;
      ended_at: string | null;
      parent_agent_id: string | null;
      metadata: string | null;
    }[]
  >(
    `SELECT id, name, type, subagent_type, status, task, current_tool,
            started_at, ended_at, parent_agent_id, metadata
       FROM agents WHERE session_id = $1 ORDER BY id`,
    sessionId
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    subagentType: row.subagent_type,
    status: row.status,
    task: row.task,
    currentTool: row.current_tool,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    parentAgentId: row.parent_agent_id,
    metadata: row.metadata,
  }));
}

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
 * Store a `commit_sha_correlation` PR link, the shape the removed correlation
 * pass left on disk. A `git_commit` link on a commit artifact rides along as the
 * negative control: the re-parsed fixture yields no artifact refs, so the
 * parser-owned teardown must clear it.
 */
async function seedCorrelationLink(db: Db): Promise<void> {
  await db.run(
    `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence, is_primary, status, extractor_version, observed_at, created_at)
       SELECT 'link-correlation', $1, id, 'created', $2, '{}', 0, 'confirmed', 1, 't1', 't1'
         FROM artifacts
        WHERE kind = 'pull_request' AND repo_full_name = $3 AND pr_number = ${PR_NUMBER}`,
    SID,
    COMMIT_SHA_CORRELATION_METHOD,
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
       branch_name = COALESCE($1, branch_name),
       closed_at = COALESCE(closed_at, $2),
       opened_at = COALESCE(opened_at, $3)
     WHERE repo_full_name = $4 AND pr_number = $5`,
    "feat/iss-4606",
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
    effectiveDataRevision()
  );
  await db.run(
    `INSERT INTO ${ClaudeCodeOtelTableName.PermissionEvent} (id, session_id, tool_name, decision, source, observed_at, data_revision, created_at, updated_at)
     VALUES ($1, $2, 'Bash', $3, $4, '2026-06-07T10:00:41.000Z', $5, '2026-06-07T10:00:41.000Z', '2026-06-07T10:00:41.000Z')`,
    `${SID}-otel-permission`,
    SID,
    ClaudeCodePermissionDecision.Allow,
    ClaudeCodePermissionSource.Hook,
    effectiveDataRevision()
  );
  await db.run(
    `INSERT INTO ${ClaudeCodeOtelTableName.ApiRequest} (id, session_id, model, tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation, cost_usd, started_at, duration_ms, data_revision, created_at, updated_at)
     VALUES ($1, $2, 'claude-sonnet-4-5', 100, 50, 10, 5, 1.75, '2026-06-07T10:00:42.000Z', 2500, $3, '2026-06-07T10:00:42.000Z', '2026-06-07T10:00:42.000Z')`,
    `${SID}-otel-api-request`,
    SID,
    effectiveDataRevision()
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
        closed_at: string | null;
        opened_at: string | null;
      }[]
    >(
      "SELECT closed_at, opened_at FROM pull_requests WHERE session_id = $1",
      SID
    ),
  ]);
  const byMethod = new Map(links.map((r) => [r.method, Number(r.cnt)]));
  return {
    correlationLinks: byMethod.get(COMMIT_SHA_CORRELATION_METHOD) ?? 0,
    parserMethodLinks: byMethod.get("git_commit") ?? 0,
    hookEvents: Number(hookEvents[0].cnt),
    staleParserEvents: Number(staleParserEvents[0].cnt),
    prClosedAt: pr[0]?.closed_at ?? null,
    prOpenedAt: pr[0]?.opened_at ?? null,
  };
}

/** Leave the session behind `DATA_REVISION` and rebuild it from the same parse. */
async function rebuildSessionOnce(db: Db, session: NormalizedSession) {
  await db.run(
    "UPDATE sessions SET data_revision = 1, status = 'inactive' WHERE id = $1",
    session.sessionId
  );
  return await runDataRevisionRebuild({
    collectors: [
      fakeCollector("claude", {
        sources: [`/fake/${session.sessionId}.jsonl`],
        parse: () => Promise.resolve([session]),
        sessionIdForSource: () => session.sessionId,
      }),
    ],
    db,
  });
}

/**
 * Import a session carrying both subagent classes the ISS-5107 sweep separates —
 * one the reparse re-mints, one it does not — and key one event to each, plus one
 * to the main spine. Three classes, because the sweep's `agent_id IN (...)` list
 * has to include exactly one of them.
 */
async function seedAgentKeyedEvents(db: Db, sessionId: string) {
  const session = makeSession({ sessionId, subagents: [PARSER_SUBAGENTS[0]] });
  const retainedAgentId = mintParserSubagentAgentIds(session).get(
    PARSER_SUBAGENTS[0].id
  );
  if (!retainedAgentId) {
    throw new Error("fixture: the parser subagent minted no agent id");
  }
  const mainId = mainAgentId(sessionId);
  const droppedAgentId = `${sessionId}-parser-sub-dropped`;
  await db.importer.importSession(session, "claude");
  // A terminal parser-namespace row the re-parsed fixture does not yield, so the
  // phase purges it and the reparse never re-mints it.
  await db.run(
    `INSERT INTO agents (id, session_id, name, type, subagent_type, status, started_at, updated_at, parent_agent_id)
       VALUES ($1, $2, 'dropped', 'subagent', NULL, $3, $4, $4, $5)`,
    droppedAgentId,
    sessionId,
    DESKTOP_AGENT_STATUS.COMPLETED,
    "2026-01-01T00:01:00.000Z",
    mainId
  );
  const keyedEvents: [string, string][] = [
    [MAIN_AGENT_EVENT_ID, mainId],
    [RETAINED_AGENT_EVENT_ID, retainedAgentId],
    [DROPPED_AGENT_EVENT_ID, droppedAgentId],
  ];
  for (const [eventId, agentId] of keyedEvents) {
    await db.run(
      `INSERT INTO events (id, session_id, agent_id, event_type, created_at)
         VALUES ($1, $2, $3, $4, '2026-06-07T10:00:05.000Z')`,
      eventId,
      sessionId,
      agentId,
      AGENT_KEYED_EVENT_TYPE
    );
  }
  return { session, mainId, retainedAgentId, droppedAgentId };
}

/**
 * The fixture's own events only. Filtering on the hook-only type keeps the
 * importer's re-derived rows — which carry agent ids of their own — out of the
 * read, so a changed re-derivation cannot move these assertions.
 */
async function readAgentKeyedEvents(db: Db, sessionId: string) {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { id: string; agent_id: string | null }[]
  >(
    `SELECT id, agent_id FROM events
       WHERE session_id = $1 AND event_type = $2 ORDER BY id`,
    sessionId,
    AGENT_KEYED_EVENT_TYPE
  );
  return rows.map((row) => ({ id: row.id, agentId: row.agent_id }));
}
