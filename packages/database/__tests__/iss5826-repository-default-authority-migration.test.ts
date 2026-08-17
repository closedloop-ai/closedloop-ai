import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION_NAME = "20260810200000_iss5826_repository_default_authority";
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.join(
  TEST_DIR,
  "..",
  "prisma",
  "migrations",
  MIGRATION_NAME,
  "migration.sql"
);
const ALTER_TABLE_RE = /ALTER TABLE "(?<table>[a-z_]+)" ADD COLUMN([\s\S]*?);/g;
const ADD_COLUMN_RE =
  /ADD COLUMN\s+"(?<name>[a-z_]+)"\s+(?<type>[A-Z]+(?:\(\d+\))?)(?<qualifiers>[^,;]*)/g;
const DATA_MUTATION_RE = /^\s*(?:DELETE|INSERT|TRUNCATE|UPDATE)\b/im;
const DESTRUCTIVE_DDL_RE = /\b(?:DROP|RENAME)\b/i;
const CREATE_OR_INDEX_RE = /\b(?:CREATE|INDEX)\b/i;
const RECEIPT_CREATE_RE =
  /CREATE TABLE "repository_default_observation_receipts" \(([\s\S]*?)\);/;
const RECEIPT_UNIQUE =
  'CONSTRAINT "repo_default_observation_receipt_dedupe_key" UNIQUE ("organization_id", "target_kind", "target_id", "source", "observation_key")';
const RECEIPT_FOREIGN_KEY =
  'ALTER TABLE "repository_default_observation_receipts" ADD CONSTRAINT "repo_default_observation_receipt_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;';

const REPOSITORY_AUTHORITY_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["default_branch_availability", "VARCHAR(32)"],
  ["default_branch_completeness", "VARCHAR(32)"],
  ["default_branch_credential_owner_id", "UUID"],
  ["default_branch_credential_type", "VARCHAR(32)"],
  ["default_branch_event_at", "TIMESTAMP(3)"],
  ["default_branch_mechanism", "VARCHAR(32)"],
  ["default_branch_name", "TEXT"],
  ["default_branch_observation_key", "TEXT"],
  ["default_branch_observed_at", "TIMESTAMP(3)"],
  ["default_branch_reason", "VARCHAR(64)"],
  ["default_branch_source", "VARCHAR(64)"],
  ["default_branch_trigger", "VARCHAR(32)"],
];

const PULL_REQUEST_AUTHORITY_COLUMNS: ReadonlyArray<readonly [string, string]> =
  [
    ["head_repository_default_branch_availability", "VARCHAR(32)"],
    ["head_repository_default_branch_completeness", "VARCHAR(32)"],
    ["head_repository_default_branch_credential_owner_id", "UUID"],
    ["head_repository_default_branch_credential_type", "VARCHAR(32)"],
    ["head_repository_default_branch_event_at", "TIMESTAMP(3)"],
    ["head_repository_default_branch_mechanism", "VARCHAR(32)"],
    ["head_repository_default_branch_name", "TEXT"],
    ["head_repository_default_branch_observation_key", "TEXT"],
    ["head_repository_default_branch_observed_at", "TIMESTAMP(3)"],
    ["head_repository_default_branch_reason", "VARCHAR(64)"],
    ["head_repository_default_branch_source", "VARCHAR(64)"],
    ["head_repository_default_branch_trigger", "VARCHAR(32)"],
    ["head_repository_full_name", "TEXT"],
    ["head_repository_github_id", "TEXT"],
  ];

const RECEIPT_COLUMNS = [
  '"id" UUID NOT NULL',
  '"organization_id" UUID NOT NULL',
  '"target_kind" VARCHAR(64) NOT NULL',
  '"target_id" TEXT NOT NULL',
  '"source" VARCHAR(64) NOT NULL',
  '"observation_key" TEXT NOT NULL',
  '"observed_at" TIMESTAMP(3) NOT NULL',
  '"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP',
] as const;

type ParsedColumn = {
  name: string;
  qualifiers: string;
  type: string;
};

type ParsedStatement = {
  columns: ParsedColumn[];
  sql: string;
  table: string;
};

describe(`${MIGRATION_NAME} DDL contract`, () => {
  it.each([
    ["github_installation_repositories", REPOSITORY_AUTHORITY_COLUMNS],
    ["public_repositories", REPOSITORY_AUTHORITY_COLUMNS],
    ["pull_request_detail", PULL_REQUEST_AUTHORITY_COLUMNS],
  ] as const)("adds the exact nullable/no-default authority fields to %s", async (table, expectedColumns) => {
    const statements = await readStatements();
    const statement = statements.find((entry) => entry.table === table);

    expect(statement, `missing ALTER TABLE for ${table}`).toBeDefined();
    expect(statement?.columns.map(({ name, type }) => [name, type])).toEqual(
      expectedColumns
    );
    for (const column of statement?.columns ?? []) {
      expect(column.qualifiers.toUpperCase()).not.toContain("NOT NULL");
      expect(column.qualifiers.toUpperCase()).not.toContain("DEFAULT");
    }
  });

  it("contains only the three additive authority ALTER statements", async () => {
    const sql = await readFile(MIGRATION_PATH, "utf8");
    const statements = await readStatements();

    expect(statements.map(({ table }) => table)).toEqual([
      "github_installation_repositories",
      "public_repositories",
      "pull_request_detail",
    ]);
    expect(sql).not.toMatch(DATA_MUTATION_RE);
    expect(sql).not.toMatch(DESTRUCTIVE_DDL_RE);
  });

  it("keeps every table statement free of data mutation and destructive DDL", async () => {
    const statements = await readStatements();

    for (const statement of statements) {
      expect(statement.sql).not.toMatch(DATA_MUTATION_RE);
      expect(statement.sql).not.toMatch(DESTRUCTIVE_DDL_RE);
      expect(statement.sql).not.toMatch(CREATE_OR_INDEX_RE);
    }
  });

  it("creates a durable tenant-scoped webhook replay receipt", async () => {
    const sql = await readFile(MIGRATION_PATH, "utf8");
    const createStatement = RECEIPT_CREATE_RE.exec(sql)?.[0];

    expect(createStatement).toBeDefined();
    for (const column of RECEIPT_COLUMNS) {
      expect(createStatement).toContain(column);
    }
    expect(createStatement).toContain(
      'CONSTRAINT "repository_default_observation_receipts_pkey" PRIMARY KEY ("id")'
    );
    expect(sql).toContain(RECEIPT_UNIQUE);
    expect(sql).toContain(RECEIPT_FOREIGN_KEY);
  });

  it("does not add a speculative receipt index or mutate existing rows", async () => {
    const sql = await readFile(MIGRATION_PATH, "utf8");
    const receiptIndexes = sql.match(
      /CREATE (?:UNIQUE )?INDEX "[^"]+" ON "repository_default_observation_receipts"/g
    );

    expect(receiptIndexes).toBeNull();
    expect(sql).not.toMatch(DATA_MUTATION_RE);
    expect(sql).not.toMatch(DESTRUCTIVE_DDL_RE);
  });
});

async function readStatements(): Promise<ParsedStatement[]> {
  const sql = await readFile(MIGRATION_PATH, "utf8");
  const statements: ParsedStatement[] = [];
  ALTER_TABLE_RE.lastIndex = 0;
  let statementMatch = ALTER_TABLE_RE.exec(sql);
  while (statementMatch !== null) {
    const table = statementMatch.groups?.table;
    if (!table) {
      throw new Error("ISS-5826 migration has an unparseable ALTER TABLE");
    }
    const statementSql = statementMatch[0];
    statements.push({
      columns: parseColumns(statementSql),
      sql: statementSql,
      table,
    });
    statementMatch = ALTER_TABLE_RE.exec(sql);
  }
  return statements;
}

function parseColumns(sql: string): ParsedColumn[] {
  const columns: ParsedColumn[] = [];
  ADD_COLUMN_RE.lastIndex = 0;
  let columnMatch = ADD_COLUMN_RE.exec(sql);
  while (columnMatch !== null) {
    const groups = columnMatch.groups;
    if (!(groups?.name && groups.type)) {
      throw new Error("ISS-5826 migration has an unparseable ADD COLUMN");
    }
    columns.push({
      name: groups.name,
      qualifiers: groups.qualifiers ?? "",
      type: groups.type,
    });
    columnMatch = ADD_COLUMN_RE.exec(sql);
  }
  return columns;
}
