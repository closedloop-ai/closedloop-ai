import { Harness } from "@repo/api/src/types/agent-component";
import { PRIORITY_VALUES } from "@repo/api/src/types/search-query";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { Priority as DatabasePriority, type Prisma } from "@repo/database";
import { describe, expect, it } from "vitest";
import { createHostileOrderedFindMany } from "@/__tests__/utils/hostile-order-planner.test-helpers";
import { AGENT_SESSION_SORT_COLUMNS } from "../validators";
import { buildAgentSessionOrderBy } from "./query-builder";
import {
  buildDbSortOrderBy,
  isDbSortColumn,
  isDisplayValueSort,
  SESSION_DEFAULT_ORDER_BY,
  SESSION_UNIQUE_TIEBREAKER,
} from "./session-sort-order";

/** The nullable sort columns whose DESC order must place NULLs last (FEA-4330). */
// ISS-6463 removed `lastActivity` from this set: `lastActivityAt` is NOT NULL,
// so it takes a plain direction like `started` (asserted below) rather than the
// FEA-4330 nulls-last pin.
const NULLABLE_SORT_COLUMNS = [
  { sortBy: "autonomy", column: "autonomy" },
  { sortBy: "repo", column: "repositoryFullName" },
  { sortBy: "model", column: "model" },
  { sortBy: "cost", column: "estimatedCost" },
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

  it("ranks a SOLE cost rule in the DATABASE, so it does NOT fall back to the pre-scan order (ISS-7176)", () => {
    // ISS-8680: names the arm, rather than only the key shape. Flipping cost to
    // `SessionSortColumnKind.Display` reddens this AND the FEA-4330 loop above —
    // measured, not assumed — but only this case says WHY: that a cost rule is
    // ranked by the database rather than falling back to the pre-scan order.
    //
    // SOLE is the whole claim. The arm is chosen by the rule list as a WHOLE, so
    // a MIXED `[cost, user]` chain DOES take `SESSION_DEFAULT_ORDER_BY` and is
    // ranked in memory — pinned in `session-sort-comparators.test.ts` under
    // "takes a MIXED chain in memory", not here.
    const orderBy = buildDbSortOrderBy({ sortBy: "cost", sortDir: "desc" });
    expect(orderBy[0]).toEqual({
      estimatedCost: { sort: "desc", nulls: "last" },
    });
    expect(orderBy).not.toEqual(SESSION_DEFAULT_ORDER_BY);
    expect(isDisplayValueSort("cost")).toBe(false);
  });

  it("keeps a plain (non-nulls) order for the non-null started column but still tiebreaks (FEA-4329)", () => {
    const orderBy = buildDbSortOrderBy({ sortBy: "started", sortDir: "asc" });
    expect(orderBy[0]).toEqual({ sessionStartedAt: "asc" });
    expect(lastKey(orderBy)).toEqual(SESSION_UNIQUE_TIEBREAKER);
  });

  it("keeps a plain (non-nulls) order for the now-non-null lastActivity column (ISS-6463)", () => {
    for (const sortDir of ["asc", "desc"] as const) {
      const orderBy = buildDbSortOrderBy({ sortBy: "lastActivity", sortDir });
      expect(orderBy[0]).toEqual({ lastActivityAt: sortDir });
      // The start-time tiebreak survives the nulls-last removal — it is what
      // narrows rows sharing an activity instant before the unique key closes
      // them.
      expect(orderBy[1]).toEqual({ sessionStartedAt: "desc" });
      expect(lastKey(orderBy)).toEqual(SESSION_UNIQUE_TIEBREAKER);
    }
  });

  it("orders by the RELATION (artifact.status), not a column on SessionDetail itself (ISS-9939 / ISS-10262)", () => {
    for (const sortDir of ["asc", "desc"] as const) {
      const orderBy = buildDbSortOrderBy({ sortBy: "status", sortDir });
      expect(orderBy[0]).toEqual({ artifact: { status: sortDir } });
      expect(lastKey(orderBy)).toEqual(SESSION_UNIQUE_TIEBREAKER);
    }
  });

  it("orders the default (no sortBy) on a plain lastActivityAt desc (ISS-6463)", () => {
    expect(SESSION_DEFAULT_ORDER_BY[0]).toEqual({ lastActivityAt: "desc" });
  });

  it("returns the deterministic default candidate order for the in-memory display-value sorts", () => {
    // duration/user are ordered in memory; the DB order is only the candidate
    // pre-scan order, which must be the deterministic default (ends in the
    // unique tiebreaker) so the bounded candidate set is stable.
    for (const sortBy of ["duration", "user"] as const) {
      expect(buildDbSortOrderBy({ sortBy, sortDir: "desc" })).toEqual(
        SESSION_DEFAULT_ORDER_BY
      );
    }
  });
});

describe("buildDbSortOrderBy — priority (ISS-10332)", () => {
  it("orders by artifacts.priority through the artifact relation, NULLs last in BOTH directions", () => {
    for (const sortDir of ["asc", "desc"] as const) {
      const orderBy = buildDbSortOrderBy({ sortBy: "priority", sortDir });
      expect(orderBy[0]).toEqual({
        artifact: { priority: { sort: sortDir, nulls: "last" } },
      });
      expect(lastKey(orderBy)).toEqual(SESSION_UNIQUE_TIEBREAKER);
    }
  });

  it("keeps the schema's Priority enum in the wire ordinal's low→high order", () => {
    // The SCHEMA half only: this is the Prisma client enum, i.e. schema.prisma
    // order. What `ORDER BY artifacts.priority` actually resolves against is
    // the live `pg_enum` order, pinned in
    // `iss10332-session-branch-priority.integration.test.ts`.
    expect(Object.values(DatabasePriority)).toEqual(PRIORITY_VALUES);
  });

  it("stays DB-native inside a chain, so a priority rule is not dropped to the pre-scan order", () => {
    expect(
      buildDbSortOrderBy({
        sorts: [
          { column: "priority", dir: "desc" },
          { column: "repo", dir: "asc" },
        ],
      })
    ).toEqual([
      { artifact: { priority: { sort: "desc", nulls: "last" } } },
      { repositoryFullName: { sort: "asc", nulls: "last" } },
      SESSION_UNIQUE_TIEBREAKER,
    ]);
  });
});

describe("isDisplayValueSort", () => {
  it("is true only for the derived display-value columns (duration, user)", () => {
    expect(isDisplayValueSort("duration")).toBe(true);
    expect(isDisplayValueSort("user")).toBe(true);
  });

  it("is false for DB-native columns, including status since ISS-9939 / ISS-10262, and an unset sort", () => {
    for (const sortBy of [
      "autonomy",
      "repo",
      "harness",
      "model",
      "cost",
      "started",
      "lastActivity",
      "status",
    ] as const) {
      expect(isDisplayValueSort(sortBy)).toBe(false);
    }
    expect(isDisplayValueSort(undefined)).toBe(false);
  });
});

/**
 * ISS-9478 pagination proof: every DB-native sort is a TOTAL order, so offset
 * pages over a fixed population partition it.
 *
 * Observed rather than read back: the hostile fake serves the same rows in
 * opposite pre-sort order on alternating calls and then applies the `orderBy`
 * it is handed, the way a planner free to reorder ties would. Only an order
 * ending in a unique key returns one sequence twice. The counterfactual strips
 * that key and must see the sequence change, which shows that some rows tie on
 * every key except the tiebreaker. Neither case checks WHERE rows land; the
 * expected-sequence block below does.
 */
describe("buildAgentSessionOrderBy — a total order for every DB-native sort (ISS-9478)", () => {
  const DB_SORT_COLUMNS = AGENT_SESSION_SORT_COLUMNS.filter(isDbSortColumn);

  it.each(DB_SORT_COLUMNS)(
    "%s: a tie-adversarial read returns one sequence in both directions",
    async (column) => {
      for (const dir of ["asc", "desc"] as const) {
        const orderBy = buildAgentSessionOrderBy({ sorts: [{ column, dir }] });
        expect(await readTwice(orderBy), `${column} ${dir}`).toEqual({
          same: true,
        });
      }
    }
  );

  it.each(DB_SORT_COLUMNS)(
    "%s: without the unique tiebreaker the same read reorders its ties (counterfactual)",
    async (column) => {
      for (const dir of ["asc", "desc"] as const) {
        const orderBy = buildAgentSessionOrderBy({ sorts: [{ column, dir }] });
        expect(orderBy.at(-1)).toEqual(SESSION_UNIQUE_TIEBREAKER);
        expect(
          await readTwice(orderBy.slice(0, -1)),
          `${column} ${dir}`
        ).toEqual({ same: false });
      }
    }
  );
});

/**
 * The sequence each read lands on, as `<pair><member>` labels. The unique
 * tiebreaker is `artifactId desc`, so an order that ignored the sort key would
 * put the blank pair 3 FIRST; each expectation below differs from that
 * tiebreaker-only sequence, so a fake or builder that drops the nulls placement
 * or the relation read fails here.
 */
describe("buildAgentSessionOrderBy — the sequence a nullable or relation sort lands on (ISS-9478)", () => {
  it.each([
    {
      column: "cost",
      dir: "desc",
      expected: ["2b", "2a", "1b", "1a", "0b", "0a", "3b", "3a"],
    },
    {
      column: "cost",
      dir: "asc",
      expected: ["0b", "0a", "1b", "1a", "2b", "2a", "3b", "3a"],
    },
    {
      column: "repo",
      dir: "desc",
      expected: ["2b", "2a", "1b", "1a", "0b", "0a", "3b", "3a"],
    },
    {
      column: "priority",
      dir: "desc",
      expected: ["2b", "2a", "1b", "1a", "0b", "0a", "3b", "3a"],
    },
    {
      column: "status",
      dir: "asc",
      expected: ["2b", "2a", "0b", "0a", "3b", "3a", "1b", "1a"],
    },
  ] as const)(
    "$column $dir lands on the expected sequence",
    async ({ column, dir, expected }) => {
      const orderBy = buildAgentSessionOrderBy({ sorts: [{ column, dir }] });
      const read = createHostileOrderedFindMany(TIED_SESSION_ROWS);
      const labels = (await read({ orderBy })).map((row) =>
        row.artifactId.slice(-2)
      );
      expect(labels).toEqual(expected);
    }
  );
});

/**
 * Four PAIRS of sessions: the two rows of a pair agree on every sort key and
 * differ only in `artifactId`, and the last pair is blank on every nullable key.
 */
const TIED_SESSION_ROWS = [0, 1, 2, 3].flatMap((pair) =>
  ["a", "b"].map((member) => tiedSessionRow(pair, member))
);

function tiedSessionRow(pair: number, member: string) {
  const blank = pair === 3;
  const instant = new Date(Date.UTC(2026, 7, 1 + (pair % 2)));
  return {
    artifactId: `00000000-0000-4000-8000-00000000000${pair}${member}`,
    artifact: {
      priority: blank ? null : DatabasePriority.HIGH,
      status: pair % 2 === 0 ? SESSION_STATUS.ACTIVE : SESSION_STATUS.INACTIVE,
    },
    autonomy: blank ? null : pair,
    estimatedCost: blank ? null : pair * 0.5,
    harness: pair % 2 === 0 ? Harness.Claude : Harness.Codex,
    lastActivityAt: instant,
    model: blank ? null : "opus",
    repositoryFullName: blank ? null : "acme/web",
    sessionStartedAt: instant,
  };
}

async function readTwice(
  orderBy: readonly Prisma.SessionDetailOrderByWithRelationInput[]
): Promise<{ same: boolean }> {
  const read = createHostileOrderedFindMany(TIED_SESSION_ROWS);
  const first = (await read({ orderBy })).map((row) => row.artifactId);
  const second = (await read({ orderBy })).map((row) => row.artifactId);
  return { same: first.join() === second.join() };
}
