import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// FEA-3001: per-migration DDL contract guard for the attachment reconcile
// ledger — the two `file_attachments` columns the DB-row-side orphan sweep uses
// to require two independent absence observations before deleting a row, plus
// the index that serves its two queries. This reads only the two migrations'
// own migration.sql (a declarative artifact, not implementation source).
//
// What it pins, and why each one matters:
//   - both columns are NOT NULL with a safe default, so existing rows read back
//     as "no absence recorded" and can never be deleted on a backfilled value;
//   - the DDL is additive (no DROP, no table rewrite, no data mutation);
//   - the index build is CONCURRENTLY and carries no IF NOT EXISTS, so it does
//     not block attachment uploads and a retry fails closed on an INVALID
//     remnant;
//   - the index columns are exactly the sweep's predicate/order, in order;
//   - the concurrent build stays in a file of its own, with no transaction
//     control or dollar-quoted block that would force Prisma's
//     single-transaction fallback (SQLSTATE 25001).

const COLUMNS_MIGRATION_DIR =
  "20260811120000_fea3001_file_attachment_reconcile_columns";
const INDEX_MIGRATION_DIR =
  "20260811120100_fea3001_file_attachment_reconcile_queue_index";

function readMigration(dir: string): string {
  return readFileSync(
    join(
      import.meta.dirname,
      "..",
      "prisma",
      "migrations",
      dir,
      "migration.sql"
    ),
    "utf8"
  );
}

const COLUMNS_SQL = readMigration(COLUMNS_MIGRATION_DIR);
const INDEX_SQL = readMigration(INDEX_MIGRATION_DIR);

const TABLE = "file_attachments";
const INDEX_NAME = "file_attachments_bucket_reconcile_absent_reconciled_at_idx";

const ADD_COLUMN_RE =
  /ADD COLUMN\s+"(?<name>[a-z_]+)"\s+(?<type>[A-Z]+(?:\(\d+\))?)(?<qualifiers>[^;]*)/g;
const CREATE_INDEX_RE =
  /CREATE INDEX(?<concurrently>\s+CONCURRENTLY)?(?<ifNotExists>\s+IF NOT EXISTS)?\s+"(?<name>[a-z_]+)"\s+ON\s+"(?<table>[a-z_]+)"\((?<columns>[^)]*)\)/;
const DROP_RE = /\bDROP\s+(TABLE|COLUMN|INDEX)\b/i;
const DML_RE = /\b(INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM)\b/i;
const TRANSACTION_RE = /\b(BEGIN|COMMIT|START\s+TRANSACTION)\b/i;
const DOLLAR_QUOTE_RE = /\$[A-Za-z_]*\$/;
const LINE_COMMENT_RE = /--[^\n]*/g;

/** Every assertion here is about DDL, so the header prose is stripped first. */
function stripComments(sql: string): string {
  return sql.replaceAll(LINE_COMMENT_RE, "");
}

type ParsedColumn = { name: string; type: string; qualifiers: string };

function parseAddColumns(sql: string): ParsedColumn[] {
  const columns: ParsedColumn[] = [];
  ADD_COLUMN_RE.lastIndex = 0;
  let match = ADD_COLUMN_RE.exec(sql);
  while (match !== null) {
    if (match.groups) {
      columns.push({
        name: match.groups.name,
        type: match.groups.type,
        qualifiers: match.groups.qualifiers ?? "",
      });
    }
    match = ADD_COLUMN_RE.exec(sql);
  }
  return columns;
}

function findColumn(name: string): ParsedColumn {
  const column = parseAddColumns(COLUMNS_SQL).find(
    (entry) => entry.name === name
  );
  if (!column) {
    throw new Error(`expected an ADD COLUMN statement for ${name}`);
  }
  return column;
}

describe(`${COLUMNS_MIGRATION_DIR} DDL contract`, () => {
  it("only alters file_attachments, additively", () => {
    expect(COLUMNS_SQL).toContain(`ALTER TABLE "${TABLE}"`);
    expect(stripComments(COLUMNS_SQL)).not.toMatch(DROP_RE);
    expect(stripComments(COLUMNS_SQL)).not.toMatch(DML_RE);
  });

  it("adds exactly the two reconcile-ledger columns", () => {
    const names = parseAddColumns(COLUMNS_SQL)
      .map((column) => column.name)
      .sort();
    expect(names).toEqual(["reconcile_absent", "reconciled_at"]);
  });

  it("defaults reconcile_absent to false so no existing row starts deletable", () => {
    const column = findColumn("reconcile_absent");
    expect(column.type).toBe("BOOLEAN");
    expect(column.qualifiers).toContain("NOT NULL");
    expect(column.qualifiers).toContain("DEFAULT false");
  });

  it("adds reconciled_at as a NOT NULL timestamp with a non-volatile default", () => {
    // The default is what keeps the ADD COLUMN a catalog-only change instead of
    // a full table rewrite, and it leaves every existing row at the front of the
    // sweep's queue rather than in a NULL state the ordering would have to
    // special-case.
    const column = findColumn("reconciled_at");
    expect(column.type).toBe("TIMESTAMP(3)");
    expect(column.qualifiers).toContain("NOT NULL");
    expect(column.qualifiers).toContain("DEFAULT CURRENT_TIMESTAMP");
  });

  it("leaves the concurrent index build to its own migration", () => {
    // Comments stripped first — the sibling migration is named in this file's
    // header prose, which is not DDL.
    expect(stripComments(COLUMNS_SQL)).not.toContain("CREATE INDEX");
  });
});

describe(`${INDEX_MIGRATION_DIR} DDL contract`, () => {
  it("builds the queue index CONCURRENTLY, without IF NOT EXISTS", () => {
    const match = CREATE_INDEX_RE.exec(INDEX_SQL);
    expect(match?.groups?.name).toBe(INDEX_NAME);
    expect(match?.groups?.table).toBe(TABLE);
    // CONCURRENTLY: no write-blocking ACCESS EXCLUSIVE lock on the upload path.
    expect(match?.groups?.concurrently).toBeDefined();
    // No IF NOT EXISTS: a retry must fail closed on an INVALID remnant rather
    // than mark the migration applied over a broken index.
    expect(match?.groups?.ifNotExists).toBeUndefined();
  });

  it("indexes the sweep's predicate and order, in that order", () => {
    const columns = CREATE_INDEX_RE.exec(INDEX_SQL)
      ?.groups?.columns.split(",")
      .map((column) => column.trim().replaceAll('"', ""));
    expect(columns).toEqual(["bucket", "reconcile_absent", "reconciled_at"]);
  });

  it("keeps the file to bare statements a CONCURRENTLY build can survive", () => {
    // A BEGIN/COMMIT or a dollar-quoted block pushes the whole file onto
    // Prisma's single-transaction fallback, where CONCURRENTLY fails 25001.
    const statements = stripComments(INDEX_SQL)
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    expect(statements).toHaveLength(1);
    expect(stripComments(INDEX_SQL)).not.toMatch(TRANSACTION_RE);
    expect(stripComments(INDEX_SQL)).not.toMatch(DOLLAR_QUOTE_RE);
  });
});
