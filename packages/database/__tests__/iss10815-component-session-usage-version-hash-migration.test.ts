import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ISS-10815 — the `(component_kind, component_version_hash)` index the detail
 * route's usage-fingerprint resolution exists to use.
 *
 * `packages/database/AGENTS.md` requires a focused DDL test for every new index,
 * and none of what this file asserts is expressible in Prisma's DSL: the index is
 * hand-authored so it can be built CONCURRENTLY, and its migration header argues
 * for four properties — the column ORDER, the CONCURRENTLY build, the deliberate
 * ABSENCE of `IF NOT EXISTS`, and the single bare statement — that nothing else
 * in the repo would notice being edited away (tamsinb, whitlockk). Modeled on the
 * sibling one column over,
 * `iss6756-component-session-usage-normalized-key-migration.test.ts`.
 *
 * Reads declarative migration.sql DDL only — not implementation source, and not
 * schema.prisma, which the `no-raw-text-source-scan` gate forbids scanning as
 * text. The schema's `@@index(..., map: ...)` name is held in step with the DDL
 * by the integration suite instead, which reads the index the migration actually
 * built out of `pg_indexes` on a live database.
 */

const INDEX_MIGRATION =
  "20260921190000_iss10815_component_session_usage_version_hash_index";

const TABLE = "agent_component_session_usage";
const INDEX = "agent_component_session_usage_kind_version_hash_idx";
/** The ISS-6756 index one column over, which this one must NOT replace. */
const SIBLING_INDEX = "agent_component_session_usage_kind_key_norm_idx";

/** PostgreSQL truncates identifiers past NAMEDATALEN-1, silently. */
const MAX_IDENTIFIER_LENGTH = 63;

const LINE_COMMENT_G = /--[^\n]*/g;
const BLOCK_COMMENT_G = /\/\*[\s\S]*?\*\//g;
const WHITESPACE_G = /\s+/g;

const TRANSACTION_CONTROL_RE =
  /\b(?:BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\b/i;
const DOLLAR_QUOTE_RE = /\$[A-Za-z_]*\$/;
const DROP_OR_ALTER_INDEX_RE = /\b(?:DROP|ALTER)\s+INDEX\b/i;
const ANY_DDL_BESIDES_INDEX_RE =
  /\b(?:ALTER\s+TABLE|CREATE\s+(?:TABLE|FUNCTION|TRIGGER)|UPDATE|DELETE\s+FROM)\b/i;
const ANY_CREATE_INDEX_G = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/gi;
const CREATE_INDEX_G =
  /CREATE\s+(UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(IF\s+NOT\s+EXISTS\s+)?"([^"]+)"\s+ON\s+"([^"]+)"\s*\(([^)]*)\)/gi;

function readMigration(name: string): string {
  return readFileSync(
    join(
      import.meta.dirname,
      "..",
      "prisma",
      "migrations",
      name,
      "migration.sql"
    ),
    "utf8"
  );
}

function stripSqlComments(sql: string): string {
  return sql.replace(BLOCK_COMMENT_G, " ").replace(LINE_COMMENT_G, " ");
}

function normalizeWhitespace(value: string): string {
  return value.replace(WHITESPACE_G, " ").trim();
}

const INDEX_SQL = normalizeWhitespace(
  stripSqlComments(readMigration(INDEX_MIGRATION))
);

describe(`${INDEX_MIGRATION} (index)`, () => {
  const parsed = [...INDEX_SQL.matchAll(CREATE_INDEX_G)].map((match) => ({
    unique: Boolean(match[1]),
    concurrent: Boolean(match[2]),
    ifNotExists: Boolean(match[3]),
    name: match[4],
    table: match[5],
    keys: normalizeWhitespace(match[6]),
  }));

  it("builds exactly one index and nothing else", () => {
    // Two assertions, deliberately: the second proves the first is exhaustive —
    // a statement the strict regex cannot parse would otherwise be absent from
    // `parsed` and the length check alone would still pass.
    expect(parsed).toHaveLength(1);
    expect(INDEX_SQL.match(ANY_CREATE_INDEX_G) ?? []).toHaveLength(1);
  });

  it("carries no other DDL or data statement", () => {
    // CONCURRENTLY cannot share a migration with anything Prisma would wrap, and
    // a rewrite smuggled in beside it would hold this hot ingest table's lock for
    // the length of that rewrite instead of for an online build.
    expect(ANY_DDL_BESIDES_INDEX_RE.test(INDEX_SQL)).toBe(false);
  });

  it("is built on (kind, version hash) IN THAT ORDER, the prefix the read binds", () => {
    // `resolveUsageContentIdentity` binds `component_kind` to a scalar and
    // `component_version_hash` to a scalar, and GROUPS BY
    // `component_key_normalized` — the folded key is the value it solves for, so
    // the sibling index cannot serve it. Reordering these columns, or swapping
    // the second for the folded key, silently returns the read to the
    // cross-tenant `component_kind` scan this index exists to remove.
    expect(parsed[0].name).toBe(INDEX);
    expect(parsed[0].table).toBe(TABLE);
    expect(parsed[0].keys).toBe(`"component_kind", "component_version_hash"`);
  });

  it("is a non-unique CONCURRENTLY build with no IF NOT EXISTS", () => {
    expect(parsed[0].concurrent).toBe(true);
    // Non-unique: a plan-only perf index. UNIQUE would be a correctness
    // constraint — two sessions may carry the same kind and version hash — and
    // would also make the migration ineligible for the preview skip list it is
    // registered in.
    expect(parsed[0].unique).toBe(false);
    // A retry after a cancelled or crashed build must fail closed (SQLSTATE
    // 42P07) against a same-named INVALID remnant rather than record the
    // migration APPLIED over a permanently-unusable index. Also required by the
    // concurrent-index lint, scripts/lint/destructive-migrations/index-ddl.ts.
    expect(parsed[0].ifNotExists).toBe(false);
  });

  it("does not drop or replace the ISS-6756 sibling index", () => {
    // The two answer different questions: the sibling serves the reads that BIND
    // the folded key, which this one cannot. Removing it here would push those
    // back onto a cross-tenant scan while this file's header still claimed it
    // stayed.
    expect(INDEX_SQL).not.toContain(SIBLING_INDEX);
    expect(DROP_OR_ALTER_INDEX_RE.test(INDEX_SQL)).toBe(false);
  });

  it("fits PostgreSQL's identifier limit without silent truncation", () => {
    // Read the length off the PARSED name: asserting the constant against itself
    // would only fail if someone edited the expectation.
    expect(parsed[0].name.length).toBeLessThanOrEqual(MAX_IDENTIFIER_LENGTH);
  });

  it("stays bare top-level SQL so Prisma does not wrap it in a transaction", () => {
    // Either of these pushes `migrate deploy` onto its single-transaction
    // fallback, where a CONCURRENTLY statement fails with SQLSTATE 25001.
    expect(TRANSACTION_CONTROL_RE.test(INDEX_SQL)).toBe(false);
    expect(DOLLAR_QUOTE_RE.test(INDEX_SQL)).toBe(false);
  });
});
