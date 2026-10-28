/**
 * The SQLite snapshot fixture the ISS-5288 import tests are driven from.
 *
 * A real on-disk database built with the desktop schema's own PHYSICAL column
 * names, because the mapping's whole job is to agree with those names — a
 * hand-shaped object fixture would agree with itself and prove nothing. Kept out
 * of the test file so the suite reads as assertions rather than DDL, and so a
 * future integration suite can seed an identical snapshot.
 *
 * Not a `*.test.ts`, so the runner never collects it as a suite.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  mapSnapshotSession,
  type SkipTally,
} from "../perf-import-desktop-snapshot-mapping";
import {
  loadSnapshotBundles,
  openSnapshot,
  readSnapshotSessionIds,
} from "../perf-import-desktop-snapshot-reads";

/**
 * The desktop tables this importer reads, with the PHYSICAL column names from
 * `apps/desktop/prisma/schema.prisma`. A drift here is exactly the failure the
 * mapping tests exist to catch, so the DDL is spelled out rather than derived.
 */
export const SNAPSHOT_DDL = [
  `CREATE TABLE sessions (
     id TEXT PRIMARY KEY, name TEXT, status TEXT NOT NULL, cwd TEXT, model TEXT,
     started_at TEXT, updated_at TEXT, ended_at TEXT, awaiting_input_since TEXT,
     metadata TEXT, harness TEXT, billing_mode TEXT, repo_full_name TEXT,
     data_revision INTEGER NOT NULL DEFAULT 1, ends_with_error INTEGER,
     frustration_raw INTEGER, frustration_score_version INTEGER)`,
  `CREATE TABLE agents (
     id TEXT PRIMARY KEY, session_id TEXT NOT NULL, name TEXT, type TEXT,
     subagent_type TEXT, status TEXT NOT NULL, task TEXT, current_tool TEXT,
     started_at TEXT, updated_at TEXT, ended_at TEXT, awaiting_input_since TEXT,
     parent_agent_id TEXT, metadata TEXT)`,
  `CREATE TABLE events (
     id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT,
     event_type TEXT NOT NULL, tool_name TEXT, summary TEXT, data TEXT,
     created_at TEXT, git_branch TEXT)`,
  `CREATE TABLE token_usage (
     session_id TEXT NOT NULL, model TEXT NOT NULL,
     input_tokens BIGINT NOT NULL DEFAULT 0, output_tokens BIGINT NOT NULL DEFAULT 0,
     cache_read_tokens BIGINT NOT NULL DEFAULT 0,
     cache_write_tokens BIGINT NOT NULL DEFAULT 0,
     cache_write_5m_tokens BIGINT, cache_write_1h_tokens BIGINT,
     baseline_input BIGINT NOT NULL DEFAULT 0,
     baseline_output BIGINT NOT NULL DEFAULT 0,
     baseline_cache_read BIGINT NOT NULL DEFAULT 0,
     baseline_cache_write BIGINT NOT NULL DEFAULT 0,
     cost_usd_estimated REAL, PRIMARY KEY (session_id, model))`,
  `CREATE TABLE token_events (
     session_id TEXT NOT NULL, transport_id TEXT, model TEXT NOT NULL,
     created_at TEXT NOT NULL, input_tokens BIGINT NOT NULL DEFAULT 0,
     output_tokens BIGINT NOT NULL DEFAULT 0,
     cache_read_tokens BIGINT NOT NULL DEFAULT 0,
     cache_write_tokens BIGINT NOT NULL DEFAULT 0, cost_usd_estimated REAL,
     source_identity TEXT, cost_summary TEXT)`,
  `CREATE TABLE session_analytics (
     session_id TEXT PRIMARY KEY, started_at TEXT, started_day TEXT, status TEXT,
     harness TEXT, is_human INTEGER NOT NULL DEFAULT 0,
     human_turns INTEGER NOT NULL DEFAULT 0, agent_turns INTEGER NOT NULL DEFAULT 0,
     event_count INTEGER NOT NULL DEFAULT 0,
     tool_invocations INTEGER NOT NULL DEFAULT 0,
     error_events INTEGER NOT NULL DEFAULT 0,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     cache_read_tokens INTEGER NOT NULL DEFAULT 0,
     cache_write_tokens INTEGER NOT NULL DEFAULT 0,
     est_cost REAL NOT NULL DEFAULT 0, runtime_ms INTEGER, updated_at TEXT)`,
  `CREATE TABLE session_activity_segments (
     id TEXT PRIMARY KEY, session_id TEXT NOT NULL, phase TEXT NOT NULL,
     start_ms BIGINT NOT NULL, end_ms BIGINT NOT NULL, confidence REAL NOT NULL,
     evidence_layers JSONB, version INTEGER NOT NULL, work_item_ref TEXT,
     observed_at TEXT, subagent_id TEXT)`,
  `CREATE TABLE agent_component_session_usage (
     session_id TEXT NOT NULL, component_kind TEXT NOT NULL,
     component_key TEXT NOT NULL, git_branch TEXT NOT NULL DEFAULT '',
     agent_component_id TEXT, harness TEXT,
     invocations INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0,
     first_invoked_at TEXT, last_invoked_at TEXT, started_day TEXT,
     component_version_hash TEXT)`,
];

export type SessionSeed = {
  id: string;
  startedAt?: string | null;
  updatedAt?: string | null;
  status?: string;
};

/** Build a real snapshot database on disk and hand its path to `run`. */
export async function withSnapshot<T>(
  seed: (db: DatabaseSync) => void,
  run: (path: string) => Promise<T> | T
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "perf-import-"));
  const path = join(dir, "agent-dashboard.sqlite");
  const db = new DatabaseSync(path);
  try {
    for (const statement of SNAPSHOT_DDL) {
      db.exec(statement);
    }
    seed(db);
  } finally {
    db.close();
  }
  try {
    return await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function insertSession(db: DatabaseSync, seed: SessionSeed): void {
  db.prepare(
    `INSERT INTO sessions (id, name, status, cwd, model, started_at, updated_at,
       ended_at, metadata, harness, billing_mode, repo_full_name, data_revision,
       ends_with_error, frustration_raw, frustration_score_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    seed.id,
    `Session ${seed.id}`,
    seed.status ?? "active",
    "/tmp/worktree",
    "claude-opus-4-6",
    seed.startedAt === undefined ? "2026-08-01T10:00:00.000Z" : seed.startedAt,
    seed.updatedAt === undefined ? "2026-08-01T11:00:00.000Z" : seed.updatedAt,
    "2026-08-01T11:30:00.000Z",
    JSON.stringify({ slug: `slug-${seed.id}`, gitBranch: "main" }),
    "claude",
    "subscription",
    "closedloop-ai/symphony",
    79,
    0,
    12,
    3
  );
}

/** A fully-populated session: every related table carries a row. */
export function seedRichSession(db: DatabaseSync, id: string): void {
  insertSession(db, { id });
  db.prepare(
    `INSERT INTO agents (id, session_id, name, type, subagent_type, status, task,
       current_tool, started_at, updated_at, parent_agent_id, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `agent-${id}`,
    id,
    "main",
    "primary",
    null,
    "running",
    "do the thing",
    "Read",
    "2026-08-01T10:00:00.000Z",
    "2026-08-01T11:00:00.000Z",
    null,
    JSON.stringify({ pid: 42 })
  );
  db.prepare(
    `INSERT INTO events (id, session_id, agent_id, event_type, tool_name, summary,
       data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `event-${id}`,
    id,
    `agent-${id}`,
    "PreToolUse",
    "Read",
    "turn text that must not ride this lane",
    JSON.stringify({ heavy: "blob" }),
    "2026-08-01T10:05:00.000Z"
  );
  db.prepare(
    `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, cache_write_5m_tokens,
       cache_write_1h_tokens, baseline_input, baseline_output,
       baseline_cache_read, baseline_cache_write, cost_usd_estimated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, "claude-opus-4-6", 100, 200, 300, 400, 150, 250, 7, 8, 9, 10, 1.5);
  db.prepare(
    `INSERT INTO token_events (session_id, transport_id, model, created_at,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       cost_usd_estimated, source_identity, cost_summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    `transport-${id}`,
    "claude-opus-4-6",
    "2026-08-01T10:06:00.000Z",
    10,
    20,
    30,
    40,
    0.25,
    JSON.stringify({
      availability: "available",
      scheme: "claude.transcript.entry.uuid",
      sourceRecordIds: ["a"],
    }),
    JSON.stringify({
      completeness: "partial",
      reason: "legacy_record",
      subtotalUsd: 0.25,
      lanes: [{ basis: "api_estimated", subtotalUsd: 0.25 }],
    })
  );
  db.prepare(
    `INSERT INTO session_analytics (session_id, started_at, started_day, status,
       harness, is_human, human_turns, agent_turns, event_count, tool_invocations,
       error_events, input_tokens, output_tokens, cache_read_tokens,
       cache_write_tokens, est_cost, runtime_ms, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    "2026-08-01T10:00:00.000Z",
    "2026-08-01",
    "active",
    "claude",
    1,
    3,
    5,
    8,
    4,
    0,
    100,
    200,
    300,
    400,
    1.5,
    3_600_000,
    "2026-08-01T11:00:00.000Z"
  );
  db.prepare(
    `INSERT INTO session_activity_segments (id, session_id, phase, start_ms,
       end_ms, confidence, evidence_layers, version, work_item_ref, observed_at,
       subagent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `seg-${id}`,
    id,
    "implement",
    1_786_151_948_897,
    1_786_151_954_944,
    0.75,
    JSON.stringify(["structural"]),
    16,
    null,
    "2026-08-01T10:10:00.000Z",
    null
  );
  db.prepare(
    `INSERT INTO agent_component_session_usage (session_id, component_kind,
       component_key, git_branch, agent_component_id, harness, invocations,
       error_count, first_invoked_at, last_invoked_at, started_day,
       component_version_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    "command",
    "/babysit-pr",
    "",
    "component-1",
    "claude",
    2,
    1,
    "2026-08-01T10:02:00.000Z",
    "2026-08-01T10:20:00.000Z",
    "2026-08-01",
    "hash-1"
  );
}

/**
 * Map every session in a snapshot, returning the payload objects and the skip
 * tally — the reads + mapping pair exactly as `importSnapshot` drives it, so a
 * caller asserts against the production path rather than the mapper alone.
 */
export function mapSnapshot(path: string): {
  sessions: Record<string, unknown>[];
  skips: SkipTally;
} {
  const db = openSnapshot(path);
  const skips: SkipTally = {};
  const sessions: Record<string, unknown>[] = [];
  try {
    const ids = readSnapshotSessionIds(db);
    for (const bundle of loadSnapshotBundles(db, ids)) {
      const mapped = mapSnapshotSession(bundle, skips);
      if (mapped !== null) {
        sessions.push(mapped);
      }
    }
  } finally {
    db.close();
  }
  return { sessions, skips };
}
