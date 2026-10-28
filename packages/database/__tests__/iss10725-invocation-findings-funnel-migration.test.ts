import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ISS-10725: per-migration DDL contract guard for the findings-funnel columns on
// agent_component_invocations, in the shape the ISS-7795 sibling guard
// established. Nullable with no default is the whole contract on each column:
// NULL must keep meaning "not measured", so a NOT NULL or a DEFAULT 0 here would
// stamp every legacy row with a funnel it never had — and a stored 0 is a real
// measurement ("this reviewer emitted nothing"), which is a different fact.
//
// EXACTLY TWO is the other half. `findings_confirmed` and any invalidation-rate
// column are derived at read; a third stored number can disagree with the two it
// came from, so the column list is pinned rather than merely checked for
// presence. This reads one migration.sql, not schema.prisma.

const MIGRATION_DIR = "20260925231500_iss10725_invocation_findings_funnel";
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
// Non-circular literals: the guard must fail if the contract's own constants are
// renamed, so it does not import them.
const EXPECTED_COLUMNS = ["findings_emitted", "findings_invalidated"];
const EXPECTED_TYPE = "BIGINT";

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

  it("adds exactly the two stored funnel columns and no derived third", () => {
    expect(parseAddColumns(MIGRATION_SQL).map((column) => column.name)).toEqual(
      EXPECTED_COLUMNS
    );
  });

  it.each(EXPECTED_COLUMNS)(
    `adds %s as ${EXPECTED_TYPE}, nullable with no default`,
    (name) => {
      const column = parseAddColumns(MIGRATION_SQL).find(
        (entry) => entry.name === name
      );

      expect(column, `expected ADD COLUMN for ${name}`).toBeDefined();
      expect(column?.type).toBe(EXPECTED_TYPE);
      expect(column?.qualifiers.toUpperCase()).not.toContain("NOT NULL");
      expect(column?.qualifiers.toUpperCase()).not.toContain("DEFAULT");
    }
  );
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
