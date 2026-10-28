import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ISS-7795: per-migration DDL contract guard for the measurement-provenance
// label on agent_component_invocations, mirroring the FEA-3981 sibling guard
// for the telemetry columns it describes. Nullable with no default is the whole
// contract: NULL must keep meaning "no telemetry", so a NOT NULL or a DEFAULT
// here would stamp every legacy row with a method it never had.
// This reads one migration.sql, not schema.prisma.

const MIGRATION_DIR = "20260823120000_iss7795_invocation_usage_measurement";
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
const EXPECTED_COLUMN = "usage_measurement";
const EXPECTED_TYPE = "TEXT";

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

  it("adds exactly one column, the measurement label", () => {
    expect(parseAddColumns(MIGRATION_SQL).map((column) => column.name)).toEqual(
      [EXPECTED_COLUMN]
    );
  });

  it(`adds ${EXPECTED_COLUMN} as ${EXPECTED_TYPE}, nullable with no default`, () => {
    const column = parseAddColumns(MIGRATION_SQL).find(
      (entry) => entry.name === EXPECTED_COLUMN
    );

    expect(column, `expected ADD COLUMN for ${EXPECTED_COLUMN}`).toBeDefined();
    expect(column?.type).toBe(EXPECTED_TYPE);
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
