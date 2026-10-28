import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ISS-6756 — the persisted `component_key_normalized` column, the trigger that
 * derives it, and the `(component_kind, component_key_normalized)` index the two
 * org-scoped identity reads exist to use.
 *
 * Almost none of this is expressible in Prisma's DSL — the fold function, the
 * trigger, and the backfill live only in migration SQL, and the index is
 * hand-authored so it can be built CONCURRENTLY. Nothing else in the repo would
 * notice if a statement were dropped, renamed, or had its expression quietly
 * changed, so each assertion below is scoped to ONE parsed statement.
 *
 * The load-bearing invariant is that the BACKFILL and the TRIGGER derive the
 * column through the SAME function: a backfilled row and a freshly written row
 * that disagreed about the fold would make the reads return different rows for
 * the same identity depending only on when the row was written.
 *
 * Reads declarative migration.sql DDL only — not implementation source, and not
 * schema.prisma, which the `no-raw-text-source-scan` gate forbids scanning as
 * text. The schema's `@@index(..., map: ...)` name is held in step with the DDL
 * by the integration suite instead, which reads the index the migration actually
 * built out of `pg_indexes` on a live database.
 */

const COLUMN_MIGRATION =
  "20260820120000_iss6756_component_session_usage_normalized_key";
const BACKFILL_MIGRATION =
  "20260820120100_iss6756_backfill_component_key_normalized";
const INDEX_MIGRATION =
  "20260820120200_iss6756_component_session_usage_normalized_key_index";

const TABLE = "agent_component_session_usage";
const COLUMN = "component_key_normalized";
const FOLD_FUNCTION = "agent_component_session_usage_normalized_key";
const TRIGGER_FUNCTION = "set_agent_component_session_usage_normalized_key";
const TRIGGER = "agent_component_session_usage_normalized_key_sync";
const INDEX = "agent_component_session_usage_kind_key_norm_idx";

/** PostgreSQL truncates identifiers past NAMEDATALEN-1, silently. */
const MAX_IDENTIFIER_LENGTH = 63;

/**
 * The fold function's body, whitespace-normalized, asserted as ONE exact string.
 *
 * Not a set of `toContain` probes over the file. Three distinct mutations hide
 * from those and none of them hides from this:
 *   • dropping the `E` prefix — under `standard_conforming_strings=on` the
 *     escapes stop being escapes and `btrim` starts stripping the literal
 *     characters `\`, `t`, `n`, `u`, `0`, `B`, `f`, `r`, `A`, `2`, `F`, `E`
 *     off both ends of every key, so `deploy-2000` folds to `deploy-`;
 *   • dropping a member of the set (a `toContain(" ")` for the bare SPACE is
 *     vacuous against any SQL file, so probes cannot cover the commonest one);
 *   • ADDING a code point JS does not trim (U+200B ZERO WIDTH SPACE is the
 *     obvious one), which makes the stored fold strictly stronger than
 *     `normalizeComponentKey` and hides rows from the reads.
 *
 * The set is JS `String.prototype.trim`'s WhiteSpace + LineTerminator, exactly.
 */
const EXPECTED_FOLD_BODY = String.raw`SELECT btrim( lower($1), E'\t\n\u000B\f\r \u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF' )`;

const LINE_COMMENT_G = /--[^\n]*/g;
const BLOCK_COMMENT_G = /\/\*[\s\S]*?\*\//g;
const WHITESPACE_G = /\s+/g;

const ANY_CREATE_INDEX_RE = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i;
const ANY_UPDATE_RE = /\bUPDATE\s+"?agent_component_session_usage"?/i;
const TRANSACTION_CONTROL_RE =
  /\b(?:BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\b/i;
const DOLLAR_QUOTE_RE = /\$[A-Za-z_]*\$/;
const DROP_OR_ALTER_INDEX_RE = /\b(?:DROP|ALTER)\s+INDEX\b/i;
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

const COLUMN_SQL = normalizeWhitespace(
  stripSqlComments(readMigration(COLUMN_MIGRATION))
);
const BACKFILL_SQL = normalizeWhitespace(
  stripSqlComments(readMigration(BACKFILL_MIGRATION))
);
const INDEX_SQL = normalizeWhitespace(
  stripSqlComments(readMigration(INDEX_MIGRATION))
);

/** The `CREATE FUNCTION <fold>` statement alone, so assertions stay per-object. */
function foldFunctionStatement(): string {
  const marker = `CREATE FUNCTION "${FOLD_FUNCTION}"`;
  const start = COLUMN_SQL.indexOf(marker);
  if (start === -1) {
    throw new Error(
      `${COLUMN_MIGRATION}: no CREATE FUNCTION "${FOLD_FUNCTION}" statement was found in migration.sql`
    );
  }
  const end = COLUMN_SQL.indexOf("CREATE FUNCTION", start + marker.length);
  return end === -1 ? COLUMN_SQL.slice(start) : COLUMN_SQL.slice(start, end);
}

describe(`${COLUMN_MIGRATION} (column + fold + trigger)`, () => {
  it("adds the column NOT NULL with a constant default so the ALTER stays metadata-only", () => {
    // A constant DEFAULT is a catalog change in PostgreSQL 11+ — no table
    // rewrite — which is what keeps the ACCESS EXCLUSIVE lock on this
    // continuously-written ingest table down to microseconds. A volatile or
    // expression default would rewrite the table under that lock.
    expect(COLUMN_SQL).toContain(
      `ALTER TABLE "${TABLE}" ADD COLUMN "${COLUMN}" TEXT NOT NULL DEFAULT ''`
    );
  });

  it("folds lower-then-trim, the order normalizeComponentKey uses", () => {
    // `normalizeComponentKey` (packages/api/src/types/agent-component-analytics.ts)
    // is `(componentKey ?? name ?? "").toLowerCase().trim()`. The reads normalize
    // their query side with it, so the stored side has to fold identically.
    expect(foldFunctionStatement()).toContain(
      `CREATE FUNCTION "${FOLD_FUNCTION}"("value" TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE STRICT AS $$ ${EXPECTED_FOLD_BODY} $$`
    );
  });

  it("trims JS's whole whitespace set, exactly — no member dropped, none added", () => {
    // Scoped to the fold function's own statement, not the file: a migration-wide
    // substring match would let another statement's text satisfy an assertion
    // about this one (packages/database/AGENTS.md).
    expect(foldFunctionStatement()).toContain(EXPECTED_FOLD_BODY);
  });

  it("derives the column from the fold function inside the trigger function", () => {
    // Via the function, not an inlined copy of the expression: the backfill
    // calls the same one, and that shared call is what makes a backfilled row
    // and a trigger-written row provably agree.
    expect(COLUMN_SQL).toContain(
      `NEW."${COLUMN}" := "${FOLD_FUNCTION}"(NEW."component_key")`
    );
  });

  it("fires BEFORE INSERT unconditionally and on UPDATE of either fold column", () => {
    // BEFORE INSERT is unconditional on purpose: the cloud writer
    // (`persistSessionComponentUsage`) keeps running its PRE-deploy raw INSERT
    // for as long as the old revision serves traffic, and every row it lands in
    // that window must still get the fold or the new reads go blind to the
    // newest usage. The UPDATE arm names BOTH columns — `component_key` so the
    // fold follows it, and the folded column itself because declaring it in
    // schema.prisma makes it writable on the generated client, so a direct
    // `update({ data: { componentKeyNormalized } })` would otherwise persist a
    // fold no read can find. Everything else — including the ingest upsert's
    // `DO UPDATE SET`, which names neither — stays off the trigger path.
    expect(COLUMN_SQL).toContain(
      `CREATE TRIGGER "${TRIGGER}" BEFORE INSERT OR UPDATE OF "component_key", "${COLUMN}" ON "${TABLE}" FOR EACH ROW EXECUTE FUNCTION "${TRIGGER_FUNCTION}"()`
    );
  });

  it("carries neither the backfill nor the index build", () => {
    // Both are deliberately separate migrations. Either one here would hold this
    // file's ACCESS EXCLUSIVE lock for the length of a full-table rewrite or an
    // index build instead of for a catalog update.
    expect(ANY_UPDATE_RE.test(COLUMN_SQL)).toBe(false);
    expect(ANY_CREATE_INDEX_RE.test(COLUMN_SQL)).toBe(false);
  });
});

describe(`${BACKFILL_MIGRATION} (backfill)`, () => {
  it("rewrites the column through the SAME fold function the trigger calls", () => {
    expect(BACKFILL_SQL).toContain(
      `UPDATE "${TABLE}" SET "${COLUMN}" = "${FOLD_FUNCTION}"("component_key")`
    );
  });

  it("is retry-idempotent: its predicate is exactly the population it eliminates", () => {
    // Prisma's deploy-recovery re-runs a migration it marked rolled back, and an
    // operator may apply it by hand twice. `IS DISTINCT FROM` (not `<>`) so a
    // row can never be skipped on a NULL comparison.
    expect(BACKFILL_SQL).toContain(
      `WHERE "${COLUMN}" IS DISTINCT FROM "${FOLD_FUNCTION}"("component_key")`
    );
  });

  it("does not re-declare the fold expression", () => {
    // The inlined expression appearing here would be the SSOT drift this file
    // exists to prevent: two definitions that can be edited apart — and with the
    // trim set now spelled out, a hand-copied twin is exactly the thing that
    // would be copied wrong.
    expect(BACKFILL_SQL).not.toContain("btrim");
  });

  it("refuses to rewrite more rows inline than the lock budget affords", () => {
    // whitlockk: `migrate deploy` gives an operator no point between the sibling
    // migration and this one at which to pre-drain, so the size at which the
    // inline rewrite stops being safe has to be CHECKED here rather than
    // documented and hoped for. Deleting the guard is what this pins.
    expect(BACKFILL_SQL).toContain(
      "max_inline_rows CONSTANT bigint := 2000000"
    );
    expect(BACKFILL_SQL).toContain("RAISE EXCEPTION");
  });

  it("decides that with a BOUNDED probe, not a whole-table count", () => {
    // An unbounded `count(*)` would add a full scan of the table to every
    // deploy — including the overwhelmingly common one where the answer is 0 —
    // to answer a yes/no question that stops being open after ceiling+1 rows.
    expect(BACKFILL_SQL).toContain("LIMIT max_inline_rows + 1");
  });
});

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
    expect(
      INDEX_SQL.match(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/gi) ?? []
    ).toHaveLength(1);
  });

  it("is built on the exact (kind, folded key) prefix the reads can prove", () => {
    // Kind first: both reads bind `component_kind` to a scalar and the folded key
    // to an `IN`, and neither binds `agent_component_id` or `agent_session_id` at
    // all. Reordering these would stop the equality prefix working.
    expect(parsed[0].name).toBe(INDEX);
    expect(parsed[0].table).toBe(TABLE);
    expect(parsed[0].keys).toBe(`"component_kind", "${COLUMN}"`);
  });

  it("is a non-unique CONCURRENTLY build with no IF NOT EXISTS", () => {
    expect(parsed[0].concurrent).toBe(true);
    // Non-unique: a plan-only perf index. UNIQUE would be a correctness
    // constraint and would also make the migration ineligible for the preview
    // skip list it is registered in.
    expect(parsed[0].unique).toBe(false);
    // A retry must fail closed (SQLSTATE 42P07) against a same-named INVALID
    // remnant rather than record the migration applied over a broken index.
    expect(parsed[0].ifNotExists).toBe(false);
  });

  it("fits PostgreSQL's identifier limit without silent truncation", () => {
    // Read the length off the PARSED name: asserting the constant against itself
    // would only fail if someone edited the expectation.
    expect(parsed[0].name.length).toBeLessThanOrEqual(MAX_IDENTIFIER_LENGTH);
  });

  it("stays bare top-level SQL so Prisma does not wrap it in a transaction", () => {
    // Any of these pushes `migrate deploy` onto its single-transaction fallback,
    // where a CONCURRENTLY statement fails with SQLSTATE 25001.
    expect(TRANSACTION_CONTROL_RE.test(INDEX_SQL)).toBe(false);
    expect(DOLLAR_QUOTE_RE.test(INDEX_SQL)).toBe(false);
    expect(DROP_OR_ALTER_INDEX_RE.test(INDEX_SQL)).toBe(false);
  });
});
