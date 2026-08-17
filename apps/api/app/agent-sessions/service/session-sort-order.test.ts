import type { Prisma } from "@repo/database";
import { describe, expect, it } from "vitest";
import { AGENT_SESSION_SORT_COLUMNS } from "../validators";
import {
  buildDbSortOrderBy,
  isDisplayValueSort,
  SESSION_DEFAULT_ORDER_BY,
  SESSION_UNIQUE_TIEBREAKER,
} from "./session-sort-order";

/** The nullable sort columns whose DESC order must place NULLs last (FEA-4330). */
const NULLABLE_SORT_COLUMNS = [
  { sortBy: "repo", column: "repositoryFullName" },
  { sortBy: "model", column: "model" },
  { sortBy: "cost", column: "estimatedCost" },
  { sortBy: "lastActivity", column: "lastActivityAt" },
] as const;

function lastKey(
  orderBy: Prisma.SessionDetailOrderByWithRelationInput[]
): Prisma.SessionDetailOrderByWithRelationInput | undefined {
  return orderBy.at(-1);
}

describe("buildDbSortOrderBy", () => {
  it("appends the unique artifactId tiebreaker as the LAST key for every sort column (FEA-4329)", () => {
    for (const sortBy of AGENT_SESSION_SORT_COLUMNS) {
      for (const sortDir of ["asc", "desc"] as const) {
        const orderBy = buildDbSortOrderBy({ sortBy, sortDir });
        expect(lastKey(orderBy)).toEqual(SESSION_UNIQUE_TIEBREAKER);
      }
    }
  });

  it("ends the default order (no sortBy) in the unique tiebreaker (FEA-4329)", () => {
    expect(lastKey(buildDbSortOrderBy({}))).toEqual(SESSION_UNIQUE_TIEBREAKER);
    expect(lastKey(SESSION_DEFAULT_ORDER_BY)).toEqual(
      SESSION_UNIQUE_TIEBREAKER
    );
  });

  it("orders nullable columns NULLs-last in BOTH directions (FEA-4330)", () => {
    for (const { sortBy, column } of NULLABLE_SORT_COLUMNS) {
      for (const sortDir of ["asc", "desc"] as const) {
        const orderBy = buildDbSortOrderBy({ sortBy, sortDir });
        // The primary key of the order-by is the sorted column with nulls:last.
        expect(orderBy[0]).toMatchObject({
          [column]: { sort: sortDir, nulls: "last" },
        });
      }
    }
  });

  it("keeps a plain (non-nulls) order for the non-null started column but still tiebreaks (FEA-4329)", () => {
    const orderBy = buildDbSortOrderBy({ sortBy: "started", sortDir: "asc" });
    expect(orderBy[0]).toEqual({ sessionStartedAt: "asc" });
    expect(lastKey(orderBy)).toEqual(SESSION_UNIQUE_TIEBREAKER);
  });

  it("returns the deterministic default candidate order for the in-memory display-value sorts", () => {
    // duration/user/status are ordered in memory; the DB order is only the
    // candidate pre-scan order, which must be the deterministic default (ends in
    // the unique tiebreaker) so the bounded candidate set is stable.
    for (const sortBy of ["duration", "user", "status"] as const) {
      expect(buildDbSortOrderBy({ sortBy, sortDir: "desc" })).toEqual(
        SESSION_DEFAULT_ORDER_BY
      );
    }
  });
});

describe("isDisplayValueSort", () => {
  it("is true only for the derived display-value columns (duration, user, status)", () => {
    // FEA-4301: `status` joined the display-value sorts because the DISPLAYED
    // status projects Waiting from `awaitingInputSince`, which no ORDER BY on the
    // raw `artifact.status` column can express.
    expect(isDisplayValueSort("duration")).toBe(true);
    expect(isDisplayValueSort("user")).toBe(true);
    expect(isDisplayValueSort("status")).toBe(true);
  });

  it("is false for DB-native columns and an unset sort", () => {
    for (const sortBy of [
      "repo",
      "harness",
      "model",
      "cost",
      "started",
      "lastActivity",
    ] as const) {
      expect(isDisplayValueSort(sortBy)).toBe(false);
    }
    expect(isDisplayValueSort(undefined)).toBe(false);
  });
});
