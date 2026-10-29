import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS } from "../scripts/preview-heavy-migrations-core.mjs";

/**
 * ISS-10565 — the `(agent_session_id, created_at)` index the Branch analytics
 * refresh pass probes once per session to ask whether it received anything
 * since it was materialized (`branchSessionReceivedSinceMaterializedSql`).
 * Without it every probe reads the session's whole history, which is the cost
 * this index exists to remove. The plan that uses it is pinned by
 * `apps/api/app/branches/branch-analytics-rollup-completeness.integration.test.ts`
 * ("re-reads only the history of a session that received an event ...").
 *
 * Reads declarative migration.sql DDL only, per `packages/database/AGENTS.md`.
 */

const INDEX_MIGRATION =
  "20261006160000_iss10565_token_events_session_received_index";

const LINE_COMMENT_G = /--[^\n]*/g;
const WHITESPACE_G = /\s+/g;
const TRANSACTION_CONTROL_RE =
  /\b(?:BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\b/i;
const ANY_CREATE_INDEX_G = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/gi;
const CREATE_INDEX_G =
  /CREATE\s+(UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(IF\s+NOT\s+EXISTS\s+)?"([^"]+)"\s+ON\s+"([^"]+)"\s*\(([^)]*)\)/gi;

const INDEX_SQL = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "prisma",
    "migrations",
    INDEX_MIGRATION,
    "migration.sql"
  ),
  "utf8"
)
  .replace(LINE_COMMENT_G, " ")
  .replace(WHITESPACE_G, " ")
  .trim();

describe(`${INDEX_MIGRATION} (index)`, () => {
  const parsed = [...INDEX_SQL.matchAll(CREATE_INDEX_G)].map((match) => ({
    unique: Boolean(match[1]),
    concurrent: Boolean(match[2]),
    ifNotExists: Boolean(match[3]),
    name: match[4],
    table: match[5],
    keys: match[6].replace(WHITESPACE_G, " ").trim(),
  }));

  it("builds exactly one index", () => {
    expect(parsed).toHaveLength(1);
    expect(INDEX_SQL.match(ANY_CREATE_INDEX_G) ?? []).toHaveLength(1);
  });

  it("keys on (session, receive time) in that order, the probe's equality then range", () => {
    expect(parsed[0]).toMatchObject({
      name: "agent_session_token_events_agent_session_id_created_at_idx",
      table: "agent_session_token_events",
      keys: `"agent_session_id", "created_at"`,
    });
  });

  it("is a non-unique CONCURRENTLY build with no IF NOT EXISTS, outside any transaction", () => {
    expect(parsed[0]).toMatchObject({
      unique: false,
      concurrent: true,
      ifNotExists: false,
    });
    expect(TRANSACTION_CONTROL_RE.test(INDEX_SQL)).toBe(false);
  });

  it("is skipped on preview schemas like every perf-only concurrent index", () => {
    expect(PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS).toContain(
      INDEX_MIGRATION
    );
  });
});
