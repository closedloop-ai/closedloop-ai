import { Priority } from "@repo/api/src/types/common";
import { Prisma } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
  displaySortCandidate as candidate,
  DISPLAY_SORT_RECORD_UPDATED as RECORD_UPDATED,
  DISPLAY_SORT_START as START,
} from "@/__tests__/support/agent-sessions/display-sort-candidate.test-fixtures";
import type { AgentSessionSortRule } from "../validators";
import { AGENT_SESSION_SORT_COLUMNS } from "../validators";
import type { DisplaySortCandidate } from "./session-display-sort";
import { buildDisplaySortComparator } from "./session-sort-comparators";
import {
  buildSessionSortOrderBy,
  SESSION_UNIQUE_TIEBREAKER,
} from "./session-sort-order";
import {
  requiresInMemorySessionSort,
  resolveSessionSortRules,
  SESSION_SORT_COLUMN_KINDS,
  SessionSortColumnKind,
  sessionSortColumnKind,
} from "./session-sort-rules";

/**
 * ISS-8335 (codex review PRRT_kwDOQ4gDpM6dLntW). The v2 toolbar can stack sort
 * rules and the list applied only the first, so a reader who added "then Owner"
 * got a toolbar that said so over rows nothing had ordered that way.
 *
 * EVERY ordering assertion here ties the PRIMARY key deliberately. That is the
 * whole point: a fixture whose primary key already separates the rows is
 * satisfied by a chain that drops the secondary rule entirely, so it would pass
 * against the exact defect it claims to cover. A tie on the primary is the only
 * shape in which the secondary rule is the thing being measured.
 *
 * AND EVERY EXPECTED ORDER IS ID-ASCENDING, which is the second half of the same
 * discipline. The FEA-4329 tiebreaker is `artifactId` DESCENDING, so a fixture
 * expecting ["b", "a"] is satisfied by the tiebreaker alone — a chain with every
 * rule deleted still passes it. Naming the rows so the rule under test has to
 * order them AGAINST the tiebreaker is what makes the assertion falsifiable;
 * `orderIds` asserts that alignment on every call so a future fixture cannot
 * quietly reintroduce the coincidence.
 */

function orderIds(
  rows: readonly DisplaySortCandidate[],
  rules: readonly AgentSessionSortRule[]
): string[] {
  const compare = buildDisplaySortComparator(rules);
  return [...rows].sort(compare).map((row) => row.artifactId);
}

/**
 * Pass an expected order through, REFUSING one the FEA-4329 tiebreaker
 * (`artifactId` descending) would produce on its own.
 *
 * A fixture expecting ids in descending order is satisfied by the tiebreaker
 * alone, so a chain with every rule deleted still passes it. That is not
 * hypothetical: the first cut of this file had five such fixtures and each
 * stayed green under exactly that mutation. Throws rather than asserting so the
 * guard lives in the helper while every `expect` stays in its own test.
 */
function nonTiebreaker(expected: string[]): string[] {
  const tiebreakerOrder = [...expected].sort().reverse();
  if (expected.join() === tiebreakerOrder.join()) {
    throw new Error(
      `Vacuous fixture: ${expected.join()} is the artifactId-desc tiebreaker order, so a chain with no rules at all would satisfy it. Rename the rows so the rule under test has to order them against the tiebreaker.`
    );
  }
  return expected;
}

describe("buildDisplaySortComparator — the secondary rule breaks the primary's ties", () => {
  it("orders a mixed chain by numeric Autonomy with nulls last in both directions", () => {
    const rows = [
      candidate("a", { autonomy: 9 }),
      candidate("b", { autonomy: null }),
      candidate("c", { autonomy: 100 }),
    ];

    expect(
      orderIds(rows, [
        { column: "status", dir: "asc" },
        { column: "autonomy", dir: "asc" },
      ])
    ).toEqual(nonTiebreaker(["a", "c", "b"]));
    expect(
      orderIds(rows, [
        { column: "status", dir: "asc" },
        { column: "autonomy", dir: "desc" },
      ])
    ).toEqual(nonTiebreaker(["c", "a", "b"]));
  });

  it("orders Status by the RAW persisted value, not the displayed one (ISS-9939 / ISS-10262)", () => {
    // A displayed-Waiting row (stored `active`) sorts with the other `active`
    // rows now, not contiguous with a genuinely displayed-Waiting one — FEA-4301
    // is knowingly superseded. Plain string order on `artifact.status`: "active"
    // < "error" < "inactive".
    const rows = [
      candidate("a", {
        artifact: {
          status: "error",
          priority: null,
          updatedAt: RECORD_UPDATED,
          assignee: null,
        },
      }),
      candidate("b", {
        artifact: {
          status: "active",
          priority: null,
          updatedAt: RECORD_UPDATED,
          assignee: null,
        },
      }),
      candidate("c", {
        artifact: {
          status: "inactive",
          priority: null,
          updatedAt: RECORD_UPDATED,
          assignee: null,
        },
      }),
    ];
    expect(orderIds(rows, [{ column: "status", dir: "asc" }])).toEqual(
      nonTiebreaker(["b", "a", "c"])
    );
    expect(orderIds(rows, [{ column: "status", dir: "desc" }])).toEqual(
      nonTiebreaker(["c", "a", "b"])
    );
  });

  it("orders by the SECONDARY rule when every row ties on the primary", () => {
    // Identical harness on every row, so the primary decides nothing and only
    // the `repo` rule can produce this order. The tiebreaker alone would yield
    // ["c", "b", "a"], so a chain that dropped the secondary rule cannot match.
    const rows = [
      candidate("a", { harness: "claude", repositoryFullName: "acme/alpha" }),
      candidate("b", { harness: "claude", repositoryFullName: "acme/marisol" }),
      candidate("c", { harness: "claude", repositoryFullName: "acme/zulu" }),
    ];
    expect(
      orderIds(rows, [
        { column: "harness", dir: "asc" },
        { column: "repo", dir: "asc" },
      ])
    ).toEqual(nonTiebreaker(["a", "b", "c"]));
  });

  it("leaves the primary in charge where it does NOT tie", () => {
    // The guard against the opposite failure: a chain that consulted the
    // secondary first, or unconditionally, would order these by repo.
    const rows = [
      candidate("a", { harness: "alpha", repositoryFullName: "acme/zulu" }),
      candidate("b", { harness: "zeta", repositoryFullName: "acme/alpha" }),
    ];
    expect(
      orderIds(rows, [
        { column: "harness", dir: "asc" },
        { column: "repo", dir: "asc" },
      ])
    ).toEqual(nonTiebreaker(["a", "b"]));
  });

  it("honors each rule's OWN direction", () => {
    const rows = [
      candidate("a", { harness: "claude", repositoryFullName: "acme/zulu" }),
      candidate("b", { harness: "claude", repositoryFullName: "acme/alpha" }),
    ];
    expect(
      orderIds(rows, [
        { column: "harness", dir: "asc" },
        { column: "repo", dir: "desc" },
      ])
    ).toEqual(nonTiebreaker(["a", "b"]));
  });

  it("breaks a DB-native tie with a DISPLAY-VALUE secondary rule", () => {
    // The combination no Prisma `orderBy` can express: the Owner key is
    // `displayUserName` — "First Last" falling back to email — so the database
    // could order this page by `harness` and nothing else.
    const rows = [
      candidate("a", {
        artifact: {
          ...candidate("a").artifact,
          assignee: {
            firstName: "Ada",
            lastName: "Ames",
            email: "a@acme.test",
          },
        },
      }),
      candidate("b", {
        artifact: {
          ...candidate("b").artifact,
          assignee: {
            firstName: "Zoe",
            lastName: "Zane",
            email: "z@acme.test",
          },
        },
      }),
    ];
    expect(
      orderIds(rows, [
        { column: "harness", dir: "asc" },
        { column: "user", dir: "asc" },
      ])
    ).toEqual(nonTiebreaker(["a", "b"]));
  });

  it("breaks a DISPLAY-VALUE tie with a DB-native secondary rule", () => {
    // The mirror case, and the one the widened `displaySortCandidateSelect`
    // exists for: with the DB columns absent from the candidate this rule would
    // have nothing to read. `status` moved to DB-native (ISS-9939 / ISS-10262),
    // so `duration` is the display-value column forcing this chain in memory now.
    const rows = [
      candidate("a", { model: "haiku" }),
      candidate("b", { model: "sonnet" }),
    ];
    expect(
      orderIds(rows, [
        { column: "duration", dir: "asc" },
        { column: "model", dir: "asc" },
      ])
    ).toEqual(nonTiebreaker(["a", "b"]));
  });

  it("falls to a THIRD rule when the first two both tie", () => {
    // The toolbar stacks more than two, so the chain is asserted past its second
    // link — a chain hard-coded to "primary then secondary" stops here.
    const rows = [
      candidate("a", { sessionStartedAt: START }),
      candidate("b", { sessionStartedAt: new Date(START.getTime() + 5000) }),
    ];
    expect(
      orderIds(rows, [
        { column: "harness", dir: "asc" },
        { column: "repo", dir: "asc" },
        { column: "started", dir: "asc" },
      ])
    ).toEqual(nonTiebreaker(["a", "b"]));
  });

  it("ends in the unique artifactId tiebreaker when EVERY rule ties (FEA-4329)", () => {
    const rows = [candidate("a"), candidate("b")];
    expect(
      orderIds(rows, [
        { column: "harness", dir: "asc" },
        { column: "repo", dir: "asc" },
      ])
    ).toEqual(["b", "a"]);
  });

  it("sorts a blank secondary key LAST in BOTH directions (FEA-4330)", () => {
    const rows = [
      candidate("a", { model: "opus" }),
      candidate("b", { model: null }),
    ];
    for (const dir of ["asc", "desc"] as const) {
      expect(
        orderIds(rows, [
          { column: "harness", dir: "asc" },
          { column: "model", dir },
        ])
      ).toEqual(nonTiebreaker(["a", "b"]));
    }
  });
});

describe("cost composes with the other rules (ISS-7176)", () => {
  function costCandidate(
    artifactId: string,
    cost: number | null,
    overrides: Partial<DisplaySortCandidate> = {}
  ): DisplaySortCandidate {
    return {
      ...candidate(artifactId, overrides),
      estimatedCost: cost === null ? null : new Prisma.Decimal(cost),
    };
  }

  it("breaks a cost tie with the SECONDARY rule", () => {
    const rows = [
      costCandidate("a", 5, { repositoryFullName: "acme/alpha" }),
      costCandidate("b", 5, { repositoryFullName: "acme/zulu" }),
    ];
    const compare = buildDisplaySortComparator([
      { column: "cost", dir: "asc" },
      { column: "repo", dir: "asc" },
    ]);
    expect([...rows].sort(compare).map((row) => row.artifactId)).toEqual(
      nonTiebreaker(["a", "b"])
    );
  });

  it("lets a cost rule break a DB-native primary's tie", () => {
    // THE CASE THAT NEARLY SHIPPED BROKEN. Before ISS-7176 a cost rule anywhere
    // in the list diverted the whole query to a separate reconciled path, so
    // `buildDisplaySortComparator` was free to FILTER cost rules out and
    // `bindSortRule`'s cost arm was a literal `() => 0`. Removing that path made
    // this chain reachable here: an inert cost comparator would have left the
    // reader's second rule deciding nothing while the toolbar showed it applied.
    const rows = [costCandidate("a", 1), costCandidate("b", 9)];
    const compare = buildDisplaySortComparator([
      { column: "harness", dir: "asc" },
      { column: "cost", dir: "asc" },
    ]);
    expect([...rows].sort(compare).map((row) => row.artifactId)).toEqual(
      nonTiebreaker(["a", "b"])
    );
  });

  it("is the SOLE rule and still orders — not merely inert", () => {
    // Deliberately separate from the chained cases above: a comparator that
    // returned 0 for every pair would leave a two-row fixture in input order,
    // which several orderings coincide with. Naming the rows so the expected
    // order runs AGAINST the `artifactId`-descending tiebreaker is what makes
    // this fail on an inert comparator rather than pass by coincidence.
    const rows = [costCandidate("b", 9), costCandidate("a", 1)];
    const compare = buildDisplaySortComparator([
      { column: "cost", dir: "asc" },
    ]);
    expect([...rows].sort(compare).map((row) => row.artifactId)).toEqual(
      nonTiebreaker(["a", "b"])
    );
  });

  it("floats an UNPRICED session last in BOTH directions", () => {
    // `estimated_cost` is nullable (ISS-7813) and null means "never priced",
    // which is not a cheap session. `compareNullableNumber` pins nulls last, the
    // same FEA-4330 semantics `nullableColumnOrder` gives the DB path — so the
    // two paths cannot place an unpriced row differently.
    for (const dir of ["asc", "desc"] as const) {
      const rows = [costCandidate("a", null), costCandidate("b", 5)];
      const compare = buildDisplaySortComparator([{ column: "cost", dir }]);
      expect([...rows].sort(compare).map((row) => row.artifactId)).toEqual([
        "b",
        "a",
      ]);
    }
  });
});

describe("buildSessionSortOrderBy — the DB arm keeps artifactId LAST", () => {
  it("emits every rule in priority order, tiebreaker last (FEA-4329)", () => {
    const orderBy = buildSessionSortOrderBy([
      { column: "harness", dir: "asc" },
      { column: "repo", dir: "desc" },
    ]);
    expect(orderBy[0]).toEqual({ harness: "asc" });
    expect(orderBy[1]).toEqual({
      repositoryFullName: { nulls: "last", sort: "desc" },
    });
    expect(orderBy.at(-1)).toEqual(SESSION_UNIQUE_TIEBREAKER);
  });

  it("never emits a narrowing key BETWEEN two rules", () => {
    // `lastActivity` narrows its own ties on `sessionStartedAt desc`. Emitted
    // before the reader's second rule that key settles nearly every tie itself,
    // so the second rule would fire on almost nothing — a sort that looks broken
    // rather than absent.
    const orderBy = buildSessionSortOrderBy([
      { column: "lastActivity", dir: "desc" },
      { column: "repo", dir: "asc" },
    ]);
    expect(orderBy[0]).toEqual({ lastActivityAt: "desc" });
    expect(orderBy[1]).toEqual({
      repositoryFullName: { nulls: "last", sort: "asc" },
    });
    expect(orderBy.at(-1)).toEqual(SESSION_UNIQUE_TIEBREAKER);
    expect(orderBy).toHaveLength(3);
  });

  it("keeps the narrowing key when its column IS the last rule", () => {
    const orderBy = buildSessionSortOrderBy([
      { column: "repo", dir: "asc" },
      { column: "lastActivity", dir: "desc" },
    ]);
    expect(orderBy[2]).toEqual({ sessionStartedAt: "desc" });
    expect(orderBy.at(-1)).toEqual(SESSION_UNIQUE_TIEBREAKER);
  });

  it("drops a narrowing key a rule already named", () => {
    const orderBy = buildSessionSortOrderBy([
      { column: "started", dir: "asc" },
      { column: "lastActivity", dir: "desc" },
    ]);
    // `started` is already rule 1, so `lastActivity`'s `sessionStartedAt desc`
    // narrowing must not re-emit the same column in the opposite direction.
    expect(orderBy).toEqual([
      { sessionStartedAt: "asc" },
      { lastActivityAt: "desc" },
      SESSION_UNIQUE_TIEBREAKER,
    ]);
  });

  it("hands a chain containing a non-DB rule to the in-memory path", () => {
    // The DB cannot express the `user` key at all, so emitting `ORDER BY harness`
    // alone would paginate by rule 1 and settle every tie on `artifactId` —
    // rule 2 silently gone. The pre-scan default is returned instead, and
    // `requiresInMemorySessionSort` is what routes the query.
    const rules: AgentSessionSortRule[] = [
      { column: "harness", dir: "asc" },
      { column: "user", dir: "asc" },
    ];
    expect(requiresInMemorySessionSort(rules)).toBe(true);
    expect(buildSessionSortOrderBy(rules)).not.toContainEqual({
      harness: "asc",
    });
    expect(buildSessionSortOrderBy(rules).at(-1)).toEqual(
      SESSION_UNIQUE_TIEBREAKER
    );
  });
});

describe("resolveSessionSortRules", () => {
  it("prefers the `sorts` list over the scalar back-compat pair", () => {
    expect(
      resolveSessionSortRules({
        sortBy: "cost",
        sortDir: "asc",
        sorts: [
          { column: "status", dir: "desc" },
          { column: "user", dir: "asc" },
        ],
      })
    ).toEqual([
      { column: "status", dir: "desc" },
      { column: "user", dir: "asc" },
    ]);
  });

  it("reads the scalar pair when `sorts` is absent (version-skewed clients)", () => {
    expect(resolveSessionSortRules({ sortBy: "repo", sortDir: "asc" })).toEqual(
      [{ column: "repo", dir: "asc" }]
    );
    expect(resolveSessionSortRules({ sortBy: "repo" })).toEqual([
      { column: "repo", dir: "desc" },
    ]);
    expect(resolveSessionSortRules({})).toEqual([]);
  });

  it("de-duplicates by column, first occurrence winning", () => {
    expect(
      resolveSessionSortRules({
        sorts: [
          { column: "repo", dir: "asc" },
          { column: "harness", dir: "asc" },
          { column: "repo", dir: "desc" },
        ],
      })
    ).toEqual([
      { column: "repo", dir: "asc" },
      { column: "harness", dir: "asc" },
    ]);
  });
});

describe("SESSION_SORT_COLUMN_KINDS", () => {
  it("classifies Autonomy as DB-native", () => {
    expect(sessionSortColumnKind("autonomy")).toBe(SessionSortColumnKind.Db);
  });

  it("classifies Status as DB-native (ISS-9939 / ISS-10262)", () => {
    expect(sessionSortColumnKind("status")).toBe(SessionSortColumnKind.Db);
    expect(SESSION_SORT_COLUMN_KINDS.status).toBe(SessionSortColumnKind.Db);
  });

  it("classifies every sortable column the route accepts", () => {
    // The map is `satisfies Record<AgentSessionSortColumn, …>`, so this asserts
    // the RUNTIME set matches too — a column added to the enum and forgotten
    // here would otherwise reach `sessionSortColumnKind` as `undefined` and
    // route by neither arm.
    for (const column of AGENT_SESSION_SORT_COLUMNS) {
      expect(Object.values(SessionSortColumnKind) as string[]).toContain(
        sessionSortColumnKind(column)
      );
    }
    expect(Object.keys(SESSION_SORT_COLUMN_KINDS).sort()).toEqual(
      [...AGENT_SESSION_SORT_COLUMNS].sort()
    );
  });
});

describe("the assignee sort key and its user alias (ISS-12251)", () => {
  it("reads `assignee` as the `user` rule every ordering path names", () => {
    expect(
      resolveSessionSortRules({ sortBy: "assignee", sortDir: "asc" })
    ).toEqual([{ column: "user", dir: "asc" }]);
  });

  it("keeps one Owner rule when a request names both spellings", () => {
    expect(
      resolveSessionSortRules({
        sorts: [
          { column: "user", dir: "desc" },
          { column: "assignee", dir: "asc" },
          { column: "repo", dir: "asc" },
        ],
      })
    ).toEqual([
      { column: "user", dir: "desc" },
      { column: "repo", dir: "asc" },
    ]);
  });
});

describe("cost sort routing (ISS-7176)", () => {
  it("keeps a SOLE cost sort on the database, with no in-memory pass", () => {
    // `estimated_cost` is a real indexable column, so a plain cost sort is an
    // ORDER BY. Routing it in memory would reintroduce a bounded candidate scan
    // for a query the database can paginate.
    expect(
      requiresInMemorySessionSort(resolveSessionSortRules({ sortBy: "cost" }))
    ).toBe(false);
  });

  it("classifies cost as a DB column, not a display-value one", () => {
    expect(sessionSortColumnKind("cost")).toBe(SessionSortColumnKind.Db);
    expect(SESSION_SORT_COLUMN_KINDS.cost).toBe(SessionSortColumnKind.Db);
  });

  it("takes a MIXED chain in memory, where the cost rule must still bind", () => {
    // A display-value rule anywhere takes the whole chain in memory, cost rule
    // included — which is precisely why `bindSortRule` can no longer treat cost
    // as unreachable. Pinned here as ROUTING; the ordering itself is pinned by
    // "lets a cost rule break a DB-native primary's tie" above. `duration` is
    // the forcing rule — `status` no longer is (ISS-9939 / ISS-10262).
    const rules = resolveSessionSortRules({
      sorts: [
        { column: "duration", dir: "asc" },
        { column: "cost", dir: "asc" },
      ],
    });
    expect(requiresInMemorySessionSort(rules)).toBe(true);
    expect(rules.map((rule) => rule.column)).toContain("cost");
  });

  it("orders Priority by the wire ORDINAL with unset last in both directions (ISS-10332)", () => {
    // String order would be HIGH < LOW < MEDIUM < URGENT; the ordinal is
    // LOW < MEDIUM < HIGH < URGENT. `duration` forces the in-memory path.
    const withPriority = (artifactId: string, priority: Priority | null) =>
      candidate(artifactId, {
        artifact: {
          status: "completed",
          priority,
          updatedAt: RECORD_UPDATED,
          assignee: null,
        },
      });
    const rows = [
      withPriority("a", Priority.Low),
      withPriority("b", null),
      withPriority("c", Priority.Urgent),
      withPriority("d", Priority.High),
      withPriority("e", Priority.Medium),
    ];

    expect(
      orderIds(rows, [
        { column: "duration", dir: "asc" },
        { column: "priority", dir: "asc" },
      ])
    ).toEqual(nonTiebreaker(["a", "e", "d", "c", "b"]));
    expect(
      orderIds(rows, [
        { column: "duration", dir: "asc" },
        { column: "priority", dir: "desc" },
      ])
    ).toEqual(nonTiebreaker(["c", "d", "e", "a", "b"]));
  });
});
