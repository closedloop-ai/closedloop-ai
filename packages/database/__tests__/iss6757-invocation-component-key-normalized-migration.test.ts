import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS } from "../scripts/preview-heavy-migrations";

/**
 * ISS-6757 — the three migrations that make the component-detail invocation
 * read's fallback arm sargable: the `component_key_normalized` column plus the
 * trigger that owns it (20260820140000), the backfill for rows that predate the
 * trigger (20260820140100), and the partial index the read is planned against
 * (20260820140200).
 *
 * NONE of the three objects is visible to Prisma: its DSL can declare neither a
 * trigger, nor a data migration, nor a partial index. So nothing else in the
 * repo would notice if the trigger lost its `lower()`, if the backfill stopped
 * being idempotent, or if the index's key list or partial predicate quietly
 * changed — and each of those failures is silent at runtime, not loud: the read
 * would return FEWER invocations rather than error. Every assertion below is
 * scoped to ONE parsed statement so a clause satisfied elsewhere in the file
 * cannot stand in for the object under test.
 *
 * Reads declarative migration.sql DDL only — not implementation source.
 */

const COLUMN_MIGRATION =
  "20260820140000_iss6757_invocation_component_key_normalized";
const BACKFILL_MIGRATION =
  "20260820140100_iss6757_backfill_invocation_component_key_normalized";
const INDEX_MIGRATION =
  "20260820140200_iss6757_invocation_component_key_normalized_index";

const TABLE = "agent_component_invocations";
const COLUMN = "component_key_normalized";
const INDEX_NAME = "idx_aci_kind_key_normalized_unattributed";
const TRIGGER_NAME = "trg_aci_fold_component_key";

/** PostgreSQL truncates identifiers past NAMEDATALEN-1, silently. */
const MAX_IDENTIFIER_LENGTH = 63;

const LINE_COMMENT_G = /--[^\n]*/g;
const BLOCK_COMMENT_G = /\/\*[\s\S]*?\*\//g;
const WHITESPACE_G = /\s+/g;
const CREATE_INDEX_HEAD_G =
  /CREATE\s+(UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(IF\s+NOT\s+EXISTS\s+)?"([^"]+)"\s+ON\s+"([^"]+)"\s*\(/gi;
const WHERE_CLAUSE_RE = /^\s*WHERE\s+([^;]+);/i;
const ANY_CREATE_INDEX_G = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/gi;
const TRANSACTION_CONTROL_RE =
  /\b(?:BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\b/i;
const DOLLAR_QUOTE_RE = /\$[A-Za-z_]*\$/;
const DROP_OR_ALTER_INDEX_RE = /\b(?:DROP|ALTER)\s+INDEX\b/i;
const CONCURRENTLY_RE = /\bCONCURRENTLY\b/i;
const NOT_NULL_RE = /NOT\s+NULL/i;
const DEFAULT_RE = /DEFAULT/i;
const FOR_EACH_ROW_RE = /FOR\s+EACH\s+ROW/i;
const ALTER_TABLE_RE = /\bALTER\s+TABLE\b/i;
const ADD_COLUMN_RE =
  /ALTER\s+TABLE\s+"([^"]+)"\s+ADD\s+COLUMN\s+"([^"]+)"\s+(\w+)\s*;/i;
const TRIGGER_FUNCTION_BODY_RE = /AS\s+\$fn\$([\s\S]*?)\$fn\$/i;
const CREATE_TRIGGER_RE =
  /CREATE\s+TRIGGER\s+(\S+)\s+([\s\S]*?)\s+ON\s+"([^"]+)"([\s\S]*?);/i;
const UPDATE_STATEMENT_RE = /UPDATE\s+"([^"]+)"\s+SET\s+([\s\S]*?);/i;
const ANY_UPDATE_G = /\bUPDATE\s+"/gi;

type ParsedIndex = {
  name: string;
  table: string;
  keys: string;
  where: string | null;
  concurrent: boolean;
  unique: boolean;
  ifNotExists: boolean;
};

const COLUMN_SQL = readMigration(COLUMN_MIGRATION);
const BACKFILL_SQL = readMigration(BACKFILL_MIGRATION);
const INDEX_SQL = readMigration(INDEX_MIGRATION);
const INDEX_CODE = stripSqlComments(INDEX_SQL);
const PARSED_INDEXES = parseCreateIndexStatements(INDEX_CODE);

describe(`${COLUMN_MIGRATION} column + trigger DDL`, () => {
  it("adds the derived column as a nullable TEXT on the invocation table", () => {
    const match = stripSqlComments(COLUMN_SQL).match(ADD_COLUMN_RE);

    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(TABLE);
    expect(match?.[2]).toBe(COLUMN);
    expect(match?.[3]?.toUpperCase()).toBe("TEXT");
    // Nullable and defaultless: `ADD COLUMN` then stays a catalog-only change
    // rather than rewriting every row under ACCESS EXCLUSIVE. The trigger and
    // the backfill are what leave no NULL behind, not a DEFAULT.
    expect(match?.[0]).not.toMatch(NOT_NULL_RE);
    expect(match?.[0]).not.toMatch(DEFAULT_RE);
  });

  it("folds with lower(component_key) — the expression the read side mirrors", () => {
    const body = stripSqlComments(COLUMN_SQL).match(TRIGGER_FUNCTION_BODY_RE);

    expect(body).not.toBeNull();
    // Asserted on the function BODY, not the whole file, so the `lower()` in a
    // neighbouring statement cannot satisfy it. `normalizeAgentComponentInvocationKey`
    // is the read-side half of this contract; the integration suite drives both.
    expect(normalizeWhitespace(body?.[1] ?? "")).toContain(
      `NEW."${COLUMN}" := lower(NEW."component_key");`
    );
  });

  it("fires BEFORE INSERT and BEFORE UPDATE OF both key columns, per row", () => {
    const match = stripSqlComments(COLUMN_SQL).match(CREATE_TRIGGER_RE);

    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(TRIGGER_NAME);
    expect(match?.[3]).toBe(TABLE);
    const timing = normalizeWhitespace(match?.[2] ?? "").toUpperCase();
    // BEFORE, so the folded value is written in the same tuple rather than
    // costing a second UPDATE. INSERT covers ingest (which, since ISS-12781,
    // writes the ISS-4923 phantom re-point at insert); `UPDATE OF component_key`
    // covers any UPDATE that re-points the key; the DERIVED column is listed too because Prisma
    // exposes it as writable, so a statement naming it directly must be
    // re-folded rather than trusted. The `relinkActiveForComputeTarget` repair
    // names neither column and stays off the trigger's cost.
    expect(timing).toBe(
      'BEFORE INSERT OR UPDATE OF "COMPONENT_KEY", "COMPONENT_KEY_NORMALIZED"'
    );
    // Read off THIS statement's own tail, not the file: a statement-level
    // trigger would see no NEW row to fold, and a migration-wide substring
    // match would let any other `FOR EACH ROW` in the file stand in for it
    // (packages/database/AGENTS.md).
    expect(normalizeWhitespace(match?.[4] ?? "")).toMatch(FOR_EACH_ROW_RE);
  });

  it("builds no index, so its dollar-quoted body cannot strand a CONCURRENTLY build", () => {
    // A `$$`-quoted body forces `migrate deploy` onto its whole-file
    // single-transaction fallback. That is harmless here and fatal in the index
    // migration, which is precisely why they are separate files.
    expect(CONCURRENTLY_RE.test(stripSqlComments(COLUMN_SQL))).toBe(false);
    expect(stripSqlComments(COLUMN_SQL).match(ANY_CREATE_INDEX_G)).toBeNull();
  });
});

describe(`${BACKFILL_MIGRATION} data migration`, () => {
  it("backfills only the rows the trigger could not have reached", () => {
    const code = stripSqlComments(BACKFILL_SQL);
    const match = code.match(UPDATE_STATEMENT_RE);

    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(TABLE);
    expect(normalizeWhitespace(match?.[2] ?? "")).toBe(
      `"${COLUMN}" = lower("component_key") WHERE "${COLUMN}" IS NULL`
    );
    // Exactly one UPDATE: a second one would not be covered by the assertion
    // above and could write a different folding.
    expect(code.match(ANY_UPDATE_G) ?? []).toHaveLength(1);
  });

  it("carries no DDL, so it does not re-take ACCESS EXCLUSIVE on the table", () => {
    const code = stripSqlComments(BACKFILL_SQL);

    // The whole reason this is its own file: running inside step 1's
    // `ADD COLUMN` transaction would hold ACCESS EXCLUSIVE for the entire
    // rewrite and stall every desktop invocation-sync writer.
    expect(code).not.toMatch(ALTER_TABLE_RE);
    expect(code.match(ANY_CREATE_INDEX_G)).toBeNull();
  });
});

describe(`${INDEX_MIGRATION} index DDL`, () => {
  it("creates exactly the one expected index and nothing else", () => {
    // Two assertions, deliberately: the second proves the first is exhaustive.
    // A statement the strict head regex cannot parse would otherwise be absent
    // from PARSED_INDEXES and the name-equality check would still pass.
    expect(PARSED_INDEXES.map((index) => index.name)).toEqual([INDEX_NAME]);
    expect(INDEX_CODE.match(ANY_CREATE_INDEX_G) ?? []).toHaveLength(
      PARSED_INDEXES.length
    );
  });

  it("indexes the exact two equalities the fallback arm filters on, in order", () => {
    const parsed = requireParsedIndex();

    expect(parsed.table).toBe(TABLE);
    // `component_kind` leads because it is the arm's always-present equality;
    // reordering these stops the key predicate reaching the Index Cond.
    expect(parsed.keys).toBe(`"component_kind", "${COLUMN}"`);
  });

  it("stays partial on the arm's own IS NULL predicate", () => {
    // Dropping this predicate would index the attributed rows too — rows this
    // arm can never return — for no plan benefit.
    expect(requireParsedIndex().where).toBe('"agent_component_id" IS NULL');
  });

  it("is a non-unique CONCURRENTLY build with no IF NOT EXISTS", () => {
    const parsed = requireParsedIndex();

    // CONCURRENTLY: desktop invocation sync writes this table continuously, so
    // a plain build would hold ACCESS EXCLUSIVE for its whole duration.
    expect(parsed.concurrent).toBe(true);
    // Non-unique: a plan-only perf index. UNIQUE would be a correctness
    // constraint and would also make the migration ineligible for the preview
    // skip list it is registered in below.
    expect(parsed.unique).toBe(false);
    // No IF NOT EXISTS: a retry must fail closed (SQLSTATE 42P07) against a
    // same-named INVALID remnant rather than record the migration applied over
    // a permanently unusable index.
    expect(parsed.ifNotExists).toBe(false);
  });

  it("fits PostgreSQL's identifier limit without silent truncation", () => {
    // Read the length off the PARSED name, not the constant — asserting a
    // constant against a constant would only fail if someone edited the
    // expectation, which is not the object at risk of truncation.
    expect(requireParsedIndex().name.length).toBeLessThanOrEqual(
      MAX_IDENTIFIER_LENGTH
    );
  });

  it("stays bare top-level SQL so Prisma does not wrap it in a transaction", () => {
    // Any of these pushes `migrate deploy` onto its single-transaction
    // fallback, where every CONCURRENTLY statement fails with SQLSTATE 25001.
    expect(TRANSACTION_CONTROL_RE.test(INDEX_CODE)).toBe(false);
    expect(DOLLAR_QUOTE_RE.test(INDEX_CODE)).toBe(false);
    expect(DROP_OR_ALTER_INDEX_RE.test(INDEX_CODE)).toBe(false);
  });

  it("is registered for the preview prestamp skip", () => {
    // An unregistered CONCURRENTLY build re-runs on every ephemeral preview
    // schema, where the instance-wide transaction wait is the ISS-4437 P1002
    // advisory-lock amplifier.
    expect(PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS).toContain(
      INDEX_MIGRATION
    );
  });
});

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

function requireParsedIndex(): ParsedIndex {
  const parsed = PARSED_INDEXES.find((index) => index.name === INDEX_NAME);
  if (!parsed) {
    throw new Error(
      `${INDEX_MIGRATION}: no CREATE INDEX statement named "${INDEX_NAME}" was parsed from migration.sql`
    );
  }
  return parsed;
}

function stripSqlComments(sql: string): string {
  return sql.replace(BLOCK_COMMENT_G, " ").replace(LINE_COMMENT_G, " ");
}

/**
 * Parse each `CREATE INDEX` statement into its own record. The key list is read
 * by matching parentheses rather than by regex so a function call inside it does
 * not terminate the capture early.
 */
function parseCreateIndexStatements(code: string): ParsedIndex[] {
  const statements: ParsedIndex[] = [];
  CREATE_INDEX_HEAD_G.lastIndex = 0;
  for (const match of code.matchAll(CREATE_INDEX_HEAD_G)) {
    const keysStart = (match.index ?? 0) + match[0].length;
    const keysEnd = findMatchingParen(code, keysStart);
    const whereMatch = code.slice(keysEnd + 1).match(WHERE_CLAUSE_RE);
    statements.push({
      name: match[4],
      table: match[5],
      keys: normalizeWhitespace(code.slice(keysStart, keysEnd)),
      where: whereMatch ? normalizeWhitespace(whereMatch[1]) : null,
      concurrent: Boolean(match[2]),
      unique: Boolean(match[1]),
      ifNotExists: Boolean(match[3]),
    });
  }
  return statements;
}

/** Index of the `)` closing the `(` that opened just before `start`. */
function findMatchingParen(code: string, start: number): number {
  let depth = 1;
  for (let index = start; index < code.length; index += 1) {
    if (code[index] === "(") {
      depth += 1;
    }
    if (code[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  throw new Error(
    `${INDEX_MIGRATION}: unbalanced parentheses in a CREATE INDEX key list at offset ${start}`
  );
}

function normalizeWhitespace(value: string): string {
  return value.replace(WHITESPACE_G, " ").trim();
}
