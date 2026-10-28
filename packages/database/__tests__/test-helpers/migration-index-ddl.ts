/**
 * Shared parser for index-migration DDL, so a focused per-migration test can
 * assert against ONE parsed statement instead of substring-matching a whole
 * file (`packages/database/AGENTS.md`: "a migration-wide substring match must
 * not satisfy a per-object assertion").
 *
 * Extracted from `iss7211-custom-field-value-facet-indexes-migration.test.ts`
 * (#5818 review) when the ISS-7513 event-window index needed the same parse.
 * Every new index migration owes a focused DDL test, so this will keep getting
 * reused; a second hand-rolled copy of these regexes is how two migrations end
 * up disagreeing about what "builds concurrently" means.
 *
 * Reads declarative `migration.sql` DDL only — never implementation source, and
 * never `schema.prisma` (`scripts/lint/rules/no-raw-text-source-scan.ts`).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** PostgreSQL truncates identifiers past NAMEDATALEN-1, silently. */
export const MAX_IDENTIFIER_LENGTH = 63;

const LINE_COMMENT_G = /--[^\n]*/g;
const CREATE_INDEX_RE =
  /CREATE\s+INDEX\s+(CONCURRENTLY\s+)?(IF\s+NOT\s+EXISTS\s+)?"([^"]+)"\s+ON\s+"([^"]+)"\s*(USING\s+(\w+)\s*)?\(([^)]*)\)/i;

/**
 * Deliberately looser than {@link CREATE_INDEX_RE}, so a statement the strict
 * parser cannot read cannot silently vanish from a statement count.
 */
export const ANY_CREATE_INDEX_G = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/gi;

/**
 * The constructs that defeat Prisma's naive statement splitter and make it wrap
 * the whole file in one transaction — which then fails every CONCURRENTLY
 * statement with SQLSTATE 25001.
 */
export const TRANSACTION_WRAP_TRIGGER_G =
  /\$\$|\bBEGIN\b|\bCOMMIT\b|\bDROP\s+INDEX\b/gi;

/**
 * The HEAD of a `CREATE [UNIQUE] INDEX` statement, up to and including the `(`
 * that opens its key list. Used by {@link scanCreateIndexStatements}, which has
 * to survive a migration whose other statements are not indexes at all.
 */
const CREATE_INDEX_HEAD_G =
  /CREATE\s+(UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(IF\s+NOT\s+EXISTS\s+)?"([^"]+)"\s+ON\s+"([^"]+)"\s*(?:USING\s+(\w+)\s*)?\(/gi;

const FOREIGN_KEY_G =
  /ALTER\s+TABLE\s+"([^"]+)"\s+ADD\s+CONSTRAINT\s+"([^"]+)"\s+FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+"([^"]+)"\s*\(([^)]*)\)([^;]*);/gi;

const WHITESPACE_G = /\s+/g;

const INDEX_PREDICATE_RE = /\bWHERE\b\s+(.+)$/i;

export type ParsedIndex = {
  name: string;
  table: string;
  method: string;
  keys: string[];
  concurrently: boolean;
  ifNotExists: boolean;
  /**
   * The `WHERE` clause of a PARTIAL index, whitespace-normalized, or null for a
   * full one. Separate from {@link ParsedIndex.keys} because the predicate is
   * what decides which rows the index covers at all: losing it silently turns a
   * backlog-sized index into a table-sized one, and narrowing it silently stops
   * covering the rows a read depends on. Neither changes the key list.
   */
  predicate: string | null;
};

/**
 * One migration's executable DDL, with `--` comments stripped.
 *
 * Stripping FIRST matters for a statement count as much as for the parse: these
 * migration headers explain the CONCURRENTLY constraint in prose that
 * necessarily quotes `CREATE INDEX`, and counting those would make the count
 * meaningless.
 *
 * KNOWN LIMITATION: the strip is not literal-aware. `--` inside a quoted SQL
 * string is not a comment to Postgres, but it is to this regex, so a migration
 * whose string literal contains `--` comes back TRUNCATED at that point, with an
 * unterminated quote. ISS-8517's `USING HINT` contains `--rolled-back` and hits
 * exactly this; its test reads the hint from the raw file instead. Anything
 * asserting about text inside a string literal must do the same rather than go
 * through here.
 */
export function migrationDdl(migrationName: string): string {
  const path = join(
    import.meta.dirname,
    "..",
    "..",
    "prisma",
    "migrations",
    migrationName,
    "migration.sql"
  );
  return readFileSync(path, "utf8").replaceAll(LINE_COMMENT_G, "");
}

/** Every `CREATE INDEX` in the migration, parsed. Throws on an unreadable one. */
export function parseIndexes(migrationName: string): ParsedIndex[] {
  return migrationDdl(migrationName)
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map((statement) => {
      const match = CREATE_INDEX_RE.exec(statement);
      if (!match) {
        throw new Error(`unparsed statement in migration: ${statement}`);
      }
      return {
        name: match[3],
        table: match[4],
        // Prisma omits `USING` for the default access method.
        method: (match[6] ?? "btree").toLowerCase(),
        keys: match[7].split(",").map((key) => key.trim().replaceAll('"', "")),
        concurrently: Boolean(match[1]),
        ifNotExists: Boolean(match[2]),
        predicate: parsePredicate(statement.slice(match[0].length)),
      };
    });
}

/** One named index from the migration. Throws when the name is absent. */
export function indexNamed(migrationName: string, name: string): ParsedIndex {
  const found = parseIndexes(migrationName).find(
    (index) => index.name === name
  );
  if (!found) {
    throw new Error(`no index named ${name} in ${migrationName}`);
  }
  return found;
}

/**
 * The pieces of one `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` statement.
 *
 * `actions` is the tail after the referenced column list, upper-cased and
 * whitespace-normalized, so an `ON DELETE CASCADE` assertion is scoped to THIS
 * constraint rather than to a substring that another statement in the same file
 * could satisfy.
 */
/**
 * A parsed index plus whether it is UNIQUE. Separate from {@link ParsedIndex}
 * because uniqueness is a CORRECTNESS property, not a plan hint — an upsert's
 * `ON CONFLICT` has no arbiter without it — and only the scanner below reads it.
 */
export type ParsedIndexStatement = ParsedIndex & { unique: boolean };

export type ParsedForeignKey = {
  table: string;
  name: string;
  columns: string;
  referencedTable: string;
  referencedColumns: string;
  actions: string;
};

/**
 * Every `CREATE [UNIQUE] INDEX` in a migration that also contains other DDL.
 *
 * Separate from {@link parseIndexes}, which throws on any statement it cannot
 * read — correct for a migration that is nothing but index builds, and wrong for
 * a `CREATE TABLE` migration that ships its index and foreign key alongside.
 * This one scans for index heads instead, so a `CREATE TABLE` or `ALTER TABLE`
 * in the same file is simply not an index rather than a parse failure.
 */
export function scanCreateIndexStatements(
  migrationName: string
): ParsedIndexStatement[] {
  const code = migrationDdl(migrationName);
  const statements: ParsedIndexStatement[] = [];
  for (const match of code.matchAll(CREATE_INDEX_HEAD_G)) {
    const keysStart = (match.index ?? 0) + match[0].length;
    const keyList = splitKeyList(code, keysStart, migrationName);
    const tailEnd = code.indexOf(";", keyList.end);
    statements.push({
      concurrently: Boolean(match[2]),
      ifNotExists: Boolean(match[3]),
      keys: keyList.keys,
      method: (match[6] ?? "btree").toLowerCase(),
      name: match[4],
      predicate: parsePredicate(
        code.slice(keyList.end + 1, tailEnd === -1 ? undefined : tailEnd)
      ),
      table: match[5],
      unique: Boolean(match[1]),
    });
  }
  return statements;
}

/** Every foreign key a migration adds, parsed one statement at a time. */
export function parseForeignKeys(migrationName: string): ParsedForeignKey[] {
  const statements: ParsedForeignKey[] = [];
  for (const match of migrationDdl(migrationName).matchAll(FOREIGN_KEY_G)) {
    statements.push({
      actions: normalizeWhitespace(match[6]).toUpperCase(),
      columns: normalizeWhitespace(match[3]),
      name: match[2],
      referencedColumns: normalizeWhitespace(match[5]),
      referencedTable: match[4],
      table: match[1],
    });
  }
  return statements;
}

/**
 * The key list starting just past an index head, split on top-level commas,
 * plus the offset of the `)` that closed it — which is where the statement's
 * tail (`INCLUDE`, `WHERE`) begins.
 * Parenthesis-matched rather than regex-captured so a function call inside the
 * list does not terminate the capture at its own closing paren.
 */
function splitKeyList(
  code: string,
  start: number,
  migrationName: string
): { keys: string[]; end: number } {
  let depth = 1;
  for (let index = start; index < code.length; index += 1) {
    if (code[index] === "(") {
      depth += 1;
    }
    if (code[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          keys: code
            .slice(start, index)
            .split(",")
            .map((key) => key.trim().replaceAll('"', "")),
          end: index,
        };
      }
    }
  }
  throw new Error(
    `${migrationName}: unbalanced parentheses in an index key list at offset ${start}`
  );
}

/**
 * The `WHERE` clause of an index statement's tail, whitespace-normalized, or
 * null when the index is not partial. The tail is whatever follows the key
 * list, so an `INCLUDE (...)` between the keys and the predicate is skipped
 * rather than mistaken for one.
 */
function parsePredicate(tail: string): string | null {
  const normalized = normalizeWhitespace(tail);
  const match = INDEX_PREDICATE_RE.exec(normalized);
  return match ? match[1].trim() : null;
}

function normalizeWhitespace(value: string): string {
  return value.replace(WHITESPACE_G, " ").trim();
}
