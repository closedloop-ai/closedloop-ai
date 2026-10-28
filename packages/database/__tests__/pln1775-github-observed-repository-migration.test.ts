import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PLN-1775 M0 (ISS-7403) — the two indexes and the foreign key that migration
 * 20260820220000 ships with `github_observed_repository`.
 *
 * The unique index IS the observation identity: `recordObservedRepositories`
 * upserts through `ON CONFLICT ("organization_id", "repository_full_name")`, so
 * a dropped, renamed, or reordered key list turns every re-observation into a
 * duplicate row instead of a weight bump. The composite index is what the
 * verifier's due query reads, and its leading `organization_id` is what keeps
 * one org's backlog off another's scan. The foreign key's ON DELETE CASCADE is
 * what stops a deleted org leaving orphaned discovery candidates behind.
 *
 * Each assertion is scoped to ONE parsed statement, so a clause satisfied
 * elsewhere in the file cannot stand in for the object under test.
 *
 * Reads declarative migration.sql DDL only — not implementation source.
 */

const MIGRATION_NAME = "20260820220000_pln1775_github_observed_repository";
const MIGRATION_SQL_PATH = join(
  import.meta.dirname,
  "..",
  "prisma",
  "migrations",
  MIGRATION_NAME,
  "migration.sql"
);
const TABLE = "github_observed_repository";

/** PostgreSQL truncates identifiers past NAMEDATALEN-1, silently. */
const MAX_IDENTIFIER_LENGTH = 63;

const LINE_COMMENT_G = /--[^\n]*/g;
const BLOCK_COMMENT_G = /\/\*[\s\S]*?\*\//g;
const WHITESPACE_G = /\s+/g;
const CREATE_INDEX_HEAD_G =
  /CREATE\s+(UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(IF\s+NOT\s+EXISTS\s+)?"([^"]+)"\s+ON\s+"([^"]+)"\s*\(/gi;
const ANY_CREATE_INDEX_G = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/gi;
const FOREIGN_KEY_G =
  /ALTER\s+TABLE\s+"([^"]+)"\s+ADD\s+CONSTRAINT\s+"([^"]+)"\s+FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+"([^"]+)"\s*\(([^)]*)\)([^;]*);/gi;

type ParsedIndex = {
  name: string;
  table: string;
  keys: string;
  unique: boolean;
  ifNotExists: boolean;
};

type ParsedForeignKey = {
  table: string;
  name: string;
  columns: string;
  referencedTable: string;
  referencedColumns: string;
  actions: string;
};

type ExpectedIndex = {
  name: string;
  keys: string;
  unique: boolean;
  /** Why the shape is what it is — read this before changing an expectation. */
  rationale: string;
};

const EXPECTED_INDEXES: readonly ExpectedIndex[] = [
  {
    name: "github_observed_repository_organization_id_repository_full__key",
    keys: '"organization_id", "repository_full_name"',
    unique: true,
    rationale:
      "The observation identity, and the conflict target the chunked upsert names verbatim. Org-leading so one org's candidates never collide with another's identically named repo.",
  },
  {
    name: "github_observed_repository_organization_id_verification_sta_idx",
    keys: '"organization_id", "verification_state", "next_verification_at"',
    unique: false,
    rationale:
      "The verifier's due query, in its exact predicate order: org equality, then the state arm, then the horizon range. Reordering it costs the range scan.",
  },
];

const MIGRATION_SQL = readFileSync(MIGRATION_SQL_PATH, "utf8");
const MIGRATION_CODE = stripSqlComments(MIGRATION_SQL);
const PARSED_INDEXES = parseCreateIndexStatements(MIGRATION_CODE);
const PARSED_FOREIGN_KEYS = parseForeignKeyStatements(MIGRATION_CODE);

describe(`${MIGRATION_NAME} index DDL`, () => {
  it("creates exactly the two expected indexes and nothing else", () => {
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

  it.each(EXPECTED_INDEXES)(
    "$name is built on the observation table over its exact key list",
    (expected) => {
      const parsed = requireParsedIndex(expected.name);

      expect(parsed.table).toBe(TABLE);
      expect(parsed.keys).toBe(expected.keys);
    }
  );

  it.each(EXPECTED_INDEXES)(
    "$name carries the uniqueness its role requires",
    (expected) => {
      // UNIQUE on the identity index is a correctness constraint, not a plan hint:
      // without it `ON CONFLICT` has no arbiter and the upsert fails outright.
      expect(requireParsedIndex(expected.name).unique).toBe(expected.unique);
    }
  );

  it.each(EXPECTED_INDEXES)(
    "$name is an IF NOT EXISTS build, as the index-lock exception requires",
    (expected) => {
      // Both builds take ACCESS EXCLUSIVE, which is only safe because the table is
      // created empty in this same migration; CONCURRENTLY cannot be mixed with
      // that DDL. The reviewed exception in the destructive-migration allowlist is
      // granted on the IF NOT EXISTS spelling, so a retry is idempotent.
      expect(requireParsedIndex(expected.name).ifNotExists).toBe(true);
    }
  );

  it.each(EXPECTED_INDEXES)(
    "$name fits PostgreSQL's identifier limit without silent truncation",
    (expected) => {
      // Read the length off the PARSED name, not the expectation — asserting a
      // constant against a constant would only ever fail if someone edited the
      // expectation, which is not the object at risk of truncation.
      expect(requireParsedIndex(expected.name).name.length).toBeLessThanOrEqual(
        MAX_IDENTIFIER_LENGTH
      );
    }
  );
});

describe(`${MIGRATION_NAME} foreign key DDL`, () => {
  it("adds exactly one foreign key, from the observation table to organizations", () => {
    expect(PARSED_FOREIGN_KEYS).toHaveLength(1);
    const [parsed] = PARSED_FOREIGN_KEYS;
    expect(parsed.table).toBe(TABLE);
    expect(parsed.name).toBe("github_observed_repository_organization_id_fkey");
    expect(parsed.columns).toBe('"organization_id"');
    expect(parsed.referencedTable).toBe("organizations");
    expect(parsed.referencedColumns).toBe('"id"');
  });

  it("cascades the delete so a removed org leaves no orphaned candidates", () => {
    // A discovery candidate is meaningless without its org, and the verifier
    // sweeps by organization_id: an orphan would be a row nothing can ever
    // settle, drawing a credential for an org that no longer exists.
    expect(PARSED_FOREIGN_KEYS[0]?.actions).toContain("ON DELETE CASCADE");
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
 * by matching parentheses rather than by regex so a function call inside it does
 * not terminate the capture early.
 */
function parseCreateIndexStatements(code: string): ParsedIndex[] {
  const statements: ParsedIndex[] = [];
  CREATE_INDEX_HEAD_G.lastIndex = 0;
  for (const match of code.matchAll(CREATE_INDEX_HEAD_G)) {
    const keysStart = (match.index ?? 0) + match[0].length;
    const keysEnd = findMatchingParen(code, keysStart);
    statements.push({
      name: match[4],
      table: match[5],
      keys: normalizeWhitespace(code.slice(keysStart, keysEnd)),
      unique: Boolean(match[1]),
      ifNotExists: Boolean(match[3]),
    });
  }
  return statements;
}

function parseForeignKeyStatements(code: string): ParsedForeignKey[] {
  const statements: ParsedForeignKey[] = [];
  FOREIGN_KEY_G.lastIndex = 0;
  for (const match of code.matchAll(FOREIGN_KEY_G)) {
    statements.push({
      table: match[1],
      name: match[2],
      columns: normalizeWhitespace(match[3]),
      referencedTable: match[4],
      referencedColumns: normalizeWhitespace(match[5]),
      actions: normalizeWhitespace(match[6]).toUpperCase(),
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
