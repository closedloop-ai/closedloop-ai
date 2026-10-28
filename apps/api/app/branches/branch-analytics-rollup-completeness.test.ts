import type { Prisma } from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import { selectIncompleteMaterializedSessions } from "./branch-analytics-rollup-completeness";

/**
 * ISS-12346 removed the 1,000-session cap above this gate, so the id set it
 * binds is now bounded only by the org's linked sessions. PostgreSQL's wire
 * protocol takes at most 65,535 bind parameters per statement, so a parameter
 * per session turns a large org into a statement that cannot bind at all.
 */

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const AS_OF = new Date("2026-08-03T00:00:00.000Z");

describe("the rollup read's completeness gate", () => {
  it("spends one bind parameter on the id set, however many sessions", () => {
    const one = gateStatement(1);
    const many = gateStatement(5000);

    expect(many.values.length).toBe(one.values.length);
    // The whole set arrives as ONE array value, not 5000 scalars.
    expect(many.values.filter((value) => Array.isArray(value))).toHaveLength(1);
  });
});

function gateStatement(sessionCount: number): Prisma.Sql {
  const queryRaw = vi.fn().mockResolvedValue([]);
  selectIncompleteMaterializedSessions({ $queryRaw: queryRaw } as never, {
    organizationId: ORGANIZATION_ID,
    sessionIds: Array.from(
      { length: sessionCount },
      (_, index) => `22222222-2222-4222-8222-${`${index}`.padStart(12, "0")}`
    ),
    asOf: AS_OF,
  });
  const statement: unknown = queryRaw.mock.calls[0]?.[0];
  if (!isPrismaSql(statement)) {
    throw new Error("Expected the gate to issue one tagged statement");
  }
  return statement;
}

function isPrismaSql(value: unknown): value is Prisma.Sql {
  return (
    typeof value === "object" &&
    value !== null &&
    "sql" in value &&
    "values" in value
  );
}
