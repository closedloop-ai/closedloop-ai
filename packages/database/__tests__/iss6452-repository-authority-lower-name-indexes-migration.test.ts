import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ISS-6452 — the three `LOWER(<repo full name>)` expression indexes that
 * migration 20260815120000 builds for the session-ingest authority read
 * (apps/api/app/agent-sessions/service/artifact-links/shared.ts).
 *
 * All three are UNMANAGED by Prisma: its DSL can declare neither an expression
 * index nor a partial one, so they exist only in the migration SQL and nothing
 * else in the repo would notice if a statement were dropped, renamed, or had
 * its key list or partial predicate quietly changed. Each assertion below is
 * scoped to ONE parsed statement, so a clause satisfied elsewhere in the file
 * cannot stand in for the object under test.
 *
 * Reads declarative migration.sql DDL only — not implementation source.
 */

const MIGRATION_NAME =
  "20260815120000_iss6452_repository_authority_lower_name_indexes";
const MIGRATION_SQL_PATH = join(
  import.meta.dirname,
  "..",
  "prisma",
  "migrations",
  MIGRATION_NAME,
  "migration.sql"
);

/** PostgreSQL truncates identifiers past NAMEDATALEN-1, silently. */
const MAX_IDENTIFIER_LENGTH = 63;

const LINE_COMMENT_G = /--[^\n]*/g;
const BLOCK_COMMENT_G = /\/\*[\s\S]*?\*\//g;
const WHITESPACE_G = /\s+/g;
const CREATE_INDEX_HEAD_G =
  /CREATE\s+(UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(IF\s+NOT\s+EXISTS\s+)?"([^"]+)"\s+ON\s+"([^"]+)"\s*\(/gi;
const WHERE_CLAUSE_RE = /^\s*WHERE\s+([^;]+);/i;
const TRANSACTION_CONTROL_RE =
  /\b(?:BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\b/i;
const DOLLAR_QUOTE_RE = /\$[A-Za-z_]*\$/;
const DROP_OR_ALTER_INDEX_RE = /\b(?:DROP|ALTER)\s+INDEX\b/i;
/**
 * Deliberately looser than CREATE_INDEX_HEAD_G: it matches a CREATE INDEX in ANY
 * spelling (schema-qualified, unquoted, `USING btree`). Counting with it and
 * comparing against the parsed count is what stops a statement the strict head
 * regex cannot parse from vanishing — silently satisfying the "nothing else"
 * assertion while a fourth index ships.
 */
const ANY_CREATE_INDEX_G = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/gi;

type ParsedIndex = {
  name: string;
  table: string;
  keys: string;
  where: string | null;
  concurrent: boolean;
  unique: boolean;
  ifNotExists: boolean;
};

type ExpectedIndex = {
  name: string;
  table: string;
  /** The full key list between the outer parentheses, whitespace-normalized. */
  keys: string;
  /** The partial predicate, or null when the index is total. */
  where: string | null;
  /** Why the shape is what it is — read this before changing an expectation. */
  rationale: string;
};

/**
 * The three arms of `readLockedAuthorityRows`, each paired with the predicate
 * it has to serve. The key lists are asserted for EXACT equality, so reordering
 * the columns (which would stop the org-scoped equality prefix working) or
 * dropping the `lower()` wrapper (which would stop the index matching the
 * function-wrapped predicate at all) fails here.
 */
const EXPECTED_INDEXES: readonly ExpectedIndex[] = [
  {
    name: "pull_request_detail_org_lower_head_repo_full_name_idx",
    table: "pull_request_detail",
    keys: '"organization_id", lower("head_repository_full_name")',
    where: '"head_repository_full_name" IS NOT NULL',
    rationale:
      "The data-scale arm. Partial because head_repository_full_name arrived with ISS-5826 and is still NULL on nearly every row; `lower(col) = ANY(...)` is strict, so the planner still proves the predicate.",
  },
  {
    name: "public_repositories_org_lower_full_name_idx",
    table: "public_repositories",
    keys: '"organization_id", lower("full_name")',
    where: null,
    rationale: "full_name is NOT NULL here, so there is nothing to exclude.",
  },
  {
    name: "github_installation_repositories_inst_lower_full_name_idx",
    table: "github_installation_repositories",
    keys: '"installation_id", lower("full_name")',
    where: '"removed_at" IS NULL',
    rationale:
      "installation_id leads even though the query never filters it directly: it arrives from the joined installation, which is one row per org. Partial on the query's own PLN-634 tombstone filter.",
  },
];

const MIGRATION_SQL = readFileSync(MIGRATION_SQL_PATH, "utf8");
const MIGRATION_CODE = stripSqlComments(MIGRATION_SQL);
const PARSED_INDEXES = parseCreateIndexStatements(MIGRATION_CODE);

describe(`${MIGRATION_NAME} index DDL`, () => {
  it("creates exactly the three expected indexes and nothing else", () => {
    // Two assertions, deliberately: the second proves the first is exhaustive.
    // A statement the strict head regex cannot parse would otherwise be absent
    // from PARSED_INDEXES and the name-equality check would still pass.
    expect(PARSED_INDEXES.map((index) => index.name)).toEqual(
      EXPECTED_INDEXES.map((expected) => expected.name)
    );
    expect(MIGRATION_CODE.match(ANY_CREATE_INDEX_G) ?? []).toHaveLength(
      PARSED_INDEXES.length
    );
  });

  it.each(
    EXPECTED_INDEXES
  )("$name is built on $table over the exact key list the ingest predicate needs", (expected) => {
    const parsed = requireParsedIndex(expected.name);

    expect(parsed.table).toBe(expected.table);
    expect(parsed.keys).toBe(expected.keys);
  });

  it.each(
    EXPECTED_INDEXES
  )("$name carries its intended predicate", (expected) => {
    const parsed = requireParsedIndex(expected.name);

    expect(parsed.where).toBe(expected.where);
  });

  it.each(
    EXPECTED_INDEXES
  )("$name is a non-unique CONCURRENTLY build with no IF NOT EXISTS", (expected) => {
    const parsed = requireParsedIndex(expected.name);

    // CONCURRENTLY: all three tables are written continuously, so a plain
    // build would hold ACCESS EXCLUSIVE for its whole duration.
    expect(parsed.concurrent).toBe(true);
    // Non-unique: these are plan-only perf indexes. A UNIQUE index would be a
    // correctness constraint and would also make the migration ineligible for
    // the preview skip list it is registered in.
    expect(parsed.unique).toBe(false);
    // No IF NOT EXISTS: a retry must fail closed (SQLSTATE 42P07) against a
    // same-named INVALID remnant rather than record the migration applied
    // over a permanently unusable index.
    expect(parsed.ifNotExists).toBe(false);
  });

  it.each(
    EXPECTED_INDEXES
  )("$name fits PostgreSQL's identifier limit without silent truncation", (expected) => {
    // Read the length off the PARSED name, not the expectation — asserting a
    // constant against a constant would only ever fail if someone edited the
    // expectation, which is not the object at risk of truncation.
    expect(requireParsedIndex(expected.name).name.length).toBeLessThanOrEqual(
      MAX_IDENTIFIER_LENGTH
    );
  });

  it("stays bare top-level SQL so Prisma does not wrap it in a transaction", () => {
    // Any of these pushes `migrate deploy` onto its single-transaction fallback,
    // where every CONCURRENTLY statement fails with SQLSTATE 25001.
    expect(TRANSACTION_CONTROL_RE.test(MIGRATION_CODE)).toBe(false);
    expect(DOLLAR_QUOTE_RE.test(MIGRATION_CODE)).toBe(false);
    expect(DROP_OR_ALTER_INDEX_RE.test(MIGRATION_CODE)).toBe(false);
  });
});

function requireParsedIndex(name: string): ParsedIndex {
  const parsed = PARSED_INDEXES.find((index) => index.name === name);
  if (!parsed) {
    throw new Error(
      `${MIGRATION_NAME}: no CREATE INDEX statement named "${name}" was parsed from migration.sql`
    );
  }
  return parsed;
}

function stripSqlComments(sql: string): string {
  return sql.replace(BLOCK_COMMENT_G, " ").replace(LINE_COMMENT_G, " ");
}

/**
 * Parse each `CREATE INDEX` statement into its own record. The key list is read
 * by matching parentheses rather than by regex so `lower("col")` inside it does
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
    `${MIGRATION_NAME}: unbalanced parentheses in a CREATE INDEX key list at offset ${start}`
  );
}

function normalizeWhitespace(value: string): string {
  return value.replace(WHITESPACE_G, " ").trim();
}
