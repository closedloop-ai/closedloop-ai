import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// FEA-3981 (PLN-1488) Slice A: per-migration DDL contract guard for the
// additive per-component telemetry columns on agent_component_invocations (the
// per-INVOCATION grain, so a multi-model subagent is representable as distinct
// rows — see the migration header). This is a per-migration migration.sql DDL
// guard (allowed): it asserts the specific migration's ADD COLUMN statements are
// additive — nullable, no default — so legacy rows stay NULL ("not computed").
// It does NOT read the whole schema.prisma.

const MIGRATION_DIR = "20260724010100_fea3981_component_telemetry_columns";
const MIGRATION_SQL = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "prisma",
    "migrations",
    MIGRATION_DIR,
    "migration.sql"
  ),
  "utf8"
);

const INVOCATION_TABLE = "agent_component_invocations";

// column name -> expected Postgres type in the ADD COLUMN statement.
const EXPECTED_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["model", "TEXT"],
  ["input_tokens", "BIGINT"],
  ["output_tokens", "BIGINT"],
  ["cache_read_tokens", "BIGINT"],
  ["cache_write_tokens", "BIGINT"],
  ["estimated_cost", "DECIMAL(14,6)"],
  ["footprint_tokens", "BIGINT"],
];

const ADD_COLUMN_RE =
  /ADD COLUMN\s+"(?<name>[a-z_]+)"\s+(?<type>[A-Z]+(?:\(\d+,\d+\))?)(?<qualifiers>[^,;]*)/g;
const DROP_TABLE_OR_COLUMN_RE = /DROP\s+(TABLE|COLUMN)/i;
const CREATE_TABLE_RE = /CREATE\s+TABLE/i;

type ParsedColumn = {
  name: string;
  type: string;
  qualifiers: string;
};

describe(`${MIGRATION_DIR} DDL contract`, () => {
  it("only alters agent_component_invocations (additive, no destructive DDL)", () => {
    expect(MIGRATION_SQL).toContain(`ALTER TABLE "${INVOCATION_TABLE}"`);
    expect(MIGRATION_SQL).not.toMatch(DROP_TABLE_OR_COLUMN_RE);
    expect(MIGRATION_SQL).not.toMatch(CREATE_TABLE_RE);
  });

  it("adds exactly the expected telemetry columns", () => {
    const parsed = parseAddColumns(MIGRATION_SQL);
    const names = parsed.map((column) => column.name).sort();
    const expectedNames = EXPECTED_COLUMNS.map(([name]) => name).sort();
    expect(names).toEqual(expectedNames);
  });

  it.each(
    EXPECTED_COLUMNS
  )("adds %s as %s, nullable with no default", (columnName, columnType) => {
    const parsed = parseAddColumns(MIGRATION_SQL);
    const column = parsed.find((entry) => entry.name === columnName);
    expect(column, `expected ADD COLUMN for ${columnName}`).toBeDefined();
    expect(column?.type).toBe(columnType);
    // Additive contract: no NOT NULL, no DEFAULT — legacy rows stay NULL.
    expect(column?.qualifiers.toUpperCase()).not.toContain("NOT NULL");
    expect(column?.qualifiers.toUpperCase()).not.toContain("DEFAULT");
  });
});

function parseAddColumns(sql: string): ParsedColumn[] {
  const columns: ParsedColumn[] = [];
  ADD_COLUMN_RE.lastIndex = 0;
  let match = ADD_COLUMN_RE.exec(sql);
  while (match !== null) {
    const groups = match.groups;
    if (groups) {
      columns.push({
        name: groups.name,
        type: groups.type,
        qualifiers: groups.qualifiers ?? "",
      });
    }
    match = ADD_COLUMN_RE.exec(sql);
  }
  return columns;
}
