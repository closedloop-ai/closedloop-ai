/**
 * ISS-10513 — branch coverage for the facet/window resolvers behind
 * `usage-summary-sql.ts` (`toFacets`, `preferPlural`, `resolveAutonomyTierBounds`,
 * `resolveQualityMode`, and `usage-sql-person-scope.ts`'s `resolveOwnerUserIds`
 * and `resolveCreatorUserIds`) and for the two comparison branches in `composeUsageSummary`/`readComparison`
 * (the `comparison` field's presence, and the optional cost-split fields'
 * `?? 0` fallback inside the prior-period delta).
 *
 * None of these helpers are exported, so — per `apps/api/AGENTS.md` — they are
 * driven through the public entry point, `buildUsageSummaryFromSql`, and
 * pinned by inspecting the arguments it forwards to the mocked readers (the
 * observable output of a resolver that only ever produces an internal
 * argument) or by inspecting the composed summary itself.
 *
 * Mocking follows `usage-summary-sql-compose.test.ts`: `withDb` is a
 * throwing proxy (`toFacets` itself never reaches Prisma — every facet is an
 * ordinary SQL predicate since ISS-10753, resolved without a database call),
 * and the six statements are mocked at the `usage-sql-reader` module seam.
 */

import {
  SESSION_COST_FILTER_OPTIONS,
  SessionChangePresenceId,
  SessionPrAssociationId,
} from "@repo/api/src/agent-session-filters";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import {
  AgentSessionComparisonMetric,
  AgentSessionComparisonMode,
} from "@repo/api/src/types/agent-session-usage-comparison";
import { SUBSCRIPTION_BILLING_MODES } from "@repo/api/src/types/billing-mode";
import { Priority } from "@repo/api/src/types/common";
import { PRIORITY_UNSET_VALUE } from "@repo/api/src/types/search-query";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { beforeEach, describe, expect, it, vi } from "vitest";

const readUsageTotals = vi.fn();
const readCostSplit = vi.fn();
const readFacetCounts = vi.fn();
const readMergedPrLoc = vi.fn();
const readLocCoverageCounts = vi.fn();
const readLastSyncTargets = vi.fn();
const projectFindMany = vi.fn();

// Only `project.findMany` is served — the `byProject` label lookup
// (`readProjectNames`) is the one place this file's own tests reach Prisma
// directly (every other read is one of the six mocked statements). Anything
// else throws by name rather than arriving as `undefined` somewhere less
// obvious.
vi.mock("@repo/database", async () => {
  const actual =
    await vi.importActual<typeof import("@repo/database")>("@repo/database");
  return {
    ...actual,
    withDb: <T>(fn: (db: unknown) => Promise<T> | T): Promise<T> =>
      Promise.resolve(
        fn(
          new Proxy(
            {},
            {
              get(_target, property) {
                if (property === "project") {
                  return { findMany: projectFindMany };
                }
                throw new Error(
                  `unmocked Prisma access (db.${String(property)}) — mock the reader at its module seam rather than reaching a database`
                );
              },
            }
          )
        )
      ),
  };
});

vi.mock("@/app/agent-sessions/service/usage-sql-reader", async () => {
  const actual = await vi.importActual<
    typeof import("@/app/agent-sessions/service/usage-sql-reader")
  >("@/app/agent-sessions/service/usage-sql-reader");
  return {
    ...actual,
    readUsageTotals,
    readCostSplit,
    readFacetCounts,
    readMergedPrLoc,
    readLocCoverageCounts,
    readLastSyncTargets,
  };
});

const { buildUsageSummaryFromSql } = await import(
  "@/app/agent-sessions/service/usage-summary-sql"
);

type UsageInput = Parameters<typeof buildUsageSummaryFromSql>[0];

/**
 * ISS-10753: `buildUsageSummaryFromSql` returns the summary directly — there
 * is no longer a D13 cohort refusal to unwrap.
 */
function composeSummary(usageInput: UsageInput) {
  return buildUsageSummaryFromSql(usageInput);
}

/** No `statuses`/`costBuckets`/`quality` unless a case overrides them. */
function usageInput(
  filters: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
): UsageInput {
  return {
    organizationId: "org-1",
    viewerId: "user-1",
    ...overrides,
    filters,
  } as never;
}

/** The facets the composer forwarded to the reader seam, for this call alone. */
function capturedFacets(): Record<string, unknown> {
  const call = readUsageTotals.mock.calls.at(-1) as
    | [unknown, Record<string, unknown>]
    | undefined;
  if (!call) {
    throw new Error("readUsageTotals was not called");
  }
  return call[1];
}

const IMPOSSIBLE_ID = "00000000-0000-0000-0000-000000000000";

/**
 * A fake directory the `project.findMany` mock filters against, so a test
 * that asks for one org's project cannot be satisfied by a row that belongs
 * to a different one — the exact scoping bug an unconditional
 * `mockResolvedValue` would hide.
 */
const PROJECT_DIRECTORY: readonly {
  id: string;
  name: string;
  organizationId: string;
}[] = [
  { id: "project-1", name: "Project One", organizationId: "org-1" },
  { id: "project-2", name: "Project Two", organizationId: "org-9" },
];

type ProjectFindManyArgs = {
  where: { organizationId: string; id: { in: readonly string[] } };
};

beforeEach(() => {
  vi.clearAllMocks();
  projectFindMany.mockImplementation(({ where }: ProjectFindManyArgs) =>
    Promise.resolve(
      PROJECT_DIRECTORY.filter(
        (row) =>
          row.organizationId === where.organizationId &&
          where.id.in.includes(row.id)
      ).map(({ id, name }) => ({ id, name }))
    )
  );
  readUsageTotals.mockResolvedValue({
    sessionCount: 10,
    earliestSessionAt: null,
    latestSessionAt: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 100,
  });
  readCostSplit.mockResolvedValue({
    subscriptionCost: 0,
    meteredCost: 100,
    unclassifiedCost: 0,
  });
  readFacetCounts.mockResolvedValue([]);
  readLastSyncTargets.mockResolvedValue([]);
  readLocCoverageCounts.mockResolvedValue({
    numeratorSessionCount: 0,
    coveredNumeratorSessionCount: 0,
    migrationPendingSessionCount: 0,
    unrevisionedSessionCount: 0,
  });
  readMergedPrLoc.mockResolvedValue({
    mergedPrCount: 0,
    mergedLoc: null,
    excludedPrCount: 0,
    medianPrSize: null,
  });
});

describe("toFacets — completedAfter", () => {
  it("threads a defined completedAfter into the facets as a Date", async () => {
    await composeSummary(
      usageInput({ completedAfter: "2026-01-05T00:00:00.000Z" })
    );

    expect(capturedFacets().completedAfter).toEqual(
      new Date("2026-01-05T00:00:00.000Z")
    );
  });
});

describe("toFacets — pass-through facets", () => {
  it("threads defined scalar facets (projectId, teamId) through unchanged", async () => {
    await composeSummary(usageInput({ projectId: "proj-x", teamId: "team-1" }));

    const facets = capturedFacets();
    // `?? null`, not `&& null`: a truthy id must survive, never collapse to
    // the fallback just because the fallback sits on the right of the operator.
    expect(facets.projectId).toBe("proj-x");
    expect(facets.teamId).toBe("team-1");
  });

  it("threads defined array facets (projectIds, changePresence) through unchanged", async () => {
    await composeSummary(
      usageInput({
        projectIds: ["proj-a", "proj-b"],
        changePresence: ["has_changes"],
      })
    );

    const facets = capturedFacets();
    // `?? []`, not `&& []`: a non-empty array must survive, never collapse to
    // an empty fallback just because the fallback sits on the right.
    expect(facets.projectIds).toEqual(["proj-a", "proj-b"]);
    expect(facets.changePresence).toEqual(["has_changes"]);
  });

  it("defaults array facets (projectIds, changePresence) to no filter when absent", async () => {
    await composeSummary(usageInput({}));

    const facets = capturedFacets();
    expect(facets.projectIds).toEqual([]);
    expect(facets.changePresence).toEqual([]);
  });
});

/**
 * whitlockk on #8670. `validators.ts` accepts any non-empty string for these two
 * facets and states that unknown ids are harmless, because
 * `buildChangePresenceWhere`/`buildPrAssociationWhere` SKIP an id they do not
 * recognise and return `null` — no filter — when nothing recognisable is left.
 * The statements spell the facet as `cardinality($n) = 0 OR (<known arms>)`, so
 * an unknown id that survives into the tuple is a nonempty array with no arm
 * that can match: NO ROWS, against a live page that was not filtered at all.
 *
 * BOTH KEYS, because one cannot tell a per-facet filter from a global one.
 */
describe("toFacets — unknown facet ids, which the live builders ignore", () => {
  it("resolves an unknown-ONLY selection to no filter", async () => {
    await composeSummary(
      usageInput({
        changePresence: ["future"],
        prAssociation: ["maybe_pr"],
      })
    );

    const facets = capturedFacets();
    expect(facets.changePresence).toEqual([]);
    expect(facets.prAssociation).toEqual([]);
  });

  it("keeps only the recognised ids out of a mixed selection", async () => {
    await composeSummary(
      usageInput({
        changePresence: ["future", SessionChangePresenceId.NoChanges],
        prAssociation: [SessionPrAssociationId.HasPr, "maybe_pr"],
      })
    );

    const facets = capturedFacets();
    expect(facets.changePresence).toEqual([SessionChangePresenceId.NoChanges]);
    expect(facets.prAssociation).toEqual([SessionPrAssociationId.HasPr]);
  });
});

describe("preferPlural — the harness facet", () => {
  it("prefers the plural harnesses facet over the singular one when it has entries", async () => {
    await composeSummary(
      usageInput({ harnesses: ["docker"], harness: "legacy" })
    );

    expect(capturedFacets().harnesses).toEqual(["docker"]);
  });

  it("falls back to the singular harness when harnesses is empty", async () => {
    await composeSummary(usageInput({ harness: "legacy-harness" }));

    expect(capturedFacets().harnesses).toEqual(["legacy-harness"]);
  });

  it("falls back to the singular harness when harnesses is a DEFINED empty array", async () => {
    // Distinct from `harnesses` being absent: `plural` here is a truthy empty
    // array, so `plural.length > 0` — not merely `plural`'s own truthiness —
    // is what must gate the early return.
    await composeSummary(
      usageInput({ harnesses: [], harness: "legacy-harness" })
    );

    expect(capturedFacets().harnesses).toEqual(["legacy-harness"]);
  });

  it("resolves to no filter when neither harnesses nor harness is set", async () => {
    await composeSummary(usageInput({}));

    expect(capturedFacets().harnesses).toEqual([]);
  });
});

describe("owner and creator scope — ISS-12251 D-1/D-4", () => {
  const people = () => {
    const { ownerUserIds, creatorUserIds } = capturedFacets();
    return { ownerUserIds, creatorUserIds };
  };

  it("sends the userIds facet as the Owner and nothing as the creator", async () => {
    await composeSummary(usageInput({ userIds: ["user-a", "user-b"] }));

    expect(people()).toEqual({
      ownerUserIds: ["user-a", "user-b"],
      creatorUserIds: [],
    });
  });

  // Operator ruling (Kerensa Whitlock, 2026-10-13): "If the UI says owner, it should
  // filter by owner. The owner is the assignee." The singular `userId` deep
  // link is the Owner, never the creator.
  it("sends the singular userId deep link as the Owner, not the creator", async () => {
    await composeSummary(usageInput({ userId: "user-a" }));

    expect(people()).toEqual({ ownerUserIds: ["user-a"], creatorUserIds: [] });
  });

  it("intersects a userId with a userIds facet that contains it", async () => {
    await composeSummary(
      usageInput({ userId: "user-b", userIds: ["user-b", "user-c"] })
    );

    expect(people()).toEqual({ ownerUserIds: ["user-b"], creatorUserIds: [] });
  });

  it("fails closed when the userId is not in the userIds facet", async () => {
    await composeSummary(
      usageInput({ userId: "user-a", userIds: ["user-b", "user-c"] })
    );

    // Deliberately NOT `[]`, which every statement reads as "no filter".
    expect(people()).toEqual({
      ownerUserIds: [IMPOSSIBLE_ID],
      creatorUserIds: [],
    });
  });

  it("scopes viewerScope=self to the viewer as the creator, beside any Owner facet", async () => {
    await composeSummary(
      usageInput(
        { viewerScope: AgentSessionViewerScope.Self, userIds: ["user-b"] },
        { viewerId: "viewer-7" }
      )
    );

    expect(people()).toEqual({
      ownerUserIds: ["user-b"],
      creatorUserIds: ["viewer-7"],
    });
  });

  it("lets viewerScope=self override a client-sent userId", async () => {
    await composeSummary(
      usageInput(
        { viewerScope: AgentSessionViewerScope.Self, userId: "user-a" },
        { viewerId: "viewer-7" }
      )
    );

    expect(people()).toEqual({
      ownerUserIds: [],
      creatorUserIds: ["viewer-7"],
    });
  });

  it("falls back to the impossible sentinel for a self scope with no resolved viewer id", async () => {
    await composeSummary(
      usageInput(
        { viewerScope: AgentSessionViewerScope.Self },
        { viewerId: undefined }
      )
    );

    // Deliberately NOT `[]` — every statement reads an empty array as "no
    // filter", which would silently widen a self read to the whole org.
    expect(people().creatorUserIds).toEqual([IMPOSSIBLE_ID]);
  });

  it("resolves to no filter when neither a userId, a userIds facet, nor self scope apply", async () => {
    await composeSummary(usageInput({}));

    expect(people()).toEqual({ ownerUserIds: [], creatorUserIds: [] });
  });
});

describe("resolveAutonomyTierBounds", () => {
  it("folds the null tier, resolves recognized tiers to score ranges, and drops an unrecognized id", async () => {
    // "high" has no upper bound, exercising the `range.lt ?? POSITIVE_INFINITY`
    // fallback; "guided"'s bounds are both defined. `autonomyTierRange` never
    // returns a recognized, non-null range with an undefined `gte`, so the
    // `range.gte ?? NEGATIVE_INFINITY` fallback branch cannot be reached without
    // editing that switch — not exercised here, and not claimed as covered.
    await composeSummary(
      usageInput({ autonomyTiers: ["bogus-tier", "unknown", "guided", "high"] })
    );

    const facets = capturedFacets();
    expect(facets.autonomyLowerBounds).toEqual([0, 70]);
    expect(facets.autonomyUpperBounds).toEqual([35, Number.POSITIVE_INFINITY]);
    expect(facets.autonomyIncludesNull).toBe(true);
  });

  it("leaves includesNull false when no tier is selected", async () => {
    // Pins the accumulator's OWN initial value, not just the "unknown" tier's
    // effect on it — the case above never selects an empty tier list, so it
    // cannot tell `let includesNull = false` apart from a mutated `true`.
    await composeSummary(usageInput({}));

    expect(capturedFacets().autonomyIncludesNull).toBe(false);
  });
});

describe("resolveCostBucketBounds", () => {
  it("resolves a selection to parallel bounds and folds the Unknown pseudo-bucket out of them", async () => {
    await composeSummary(
      usageInput({
        costBuckets: ["bogus-bucket", "unknown", "under_1", "from_50"],
      })
    );

    const facets = capturedFacets();
    expect(facets.costBucketLowerBounds).toEqual([-0.005, 50.005]);
    // `from_50` has no ceiling — the `lt ?? POSITIVE_INFINITY` fallback, which
    // `facet-common.sql` reads through its `bucket.hi IS NULL` arm.
    expect(facets.costBucketUpperBounds).toEqual([
      1.005,
      Number.POSITIVE_INFINITY,
    ]);
    expect(facets.costBucketIncludesUnknown).toBe(true);
  });

  it("resolves an EXHAUSTIVE selection to no narrowing, as buildCostBucketWhere does", async () => {
    // Every option selected excludes nothing, so the live builder returns a
    // null clause. Emitting the predicate anyway diverges on rows it does not
    // cover — a null `estimated_cost` on a subscription session that did
    // measurable work is KNOWN (the Unknown arm rejects it) and has no cost to
    // land in a bucket, so the SQL drops a row live keeps.
    await composeSummary(
      usageInput({
        costBuckets: SESSION_COST_FILTER_OPTIONS.map((option) => option.id),
      })
    );

    const facets = capturedFacets();
    expect(facets.costBucketLowerBounds).toEqual([]);
    expect(facets.costBucketUpperBounds).toEqual([]);
    expect(facets.costBucketIncludesUnknown).toBe(false);
  });
});

describe("toFacets — the status filter", () => {
  it("resolves no status selection to null, the statements' 'no narrowing'", async () => {
    await composeSummary(usageInput({}));

    expect(capturedFacets().statuses).toBeNull();
  });

  it("strips a display-only status from a mixed selection rather than passing it through", async () => {
    // `artifacts.status` is freeform and rows literally storing `waiting`
    // exist, so forwarding it would make this path return a SUPERSET of the
    // served endpoint's answer (three reviewers on #7684).
    await composeSummary(
      usageInput({ statuses: [SESSION_STATUS.ACTIVE, "waiting"] })
    );

    expect(capturedFacets().statuses).toEqual([SESSION_STATUS.ACTIVE]);
  });

  it("resolves an ALL-display-only selection to an empty array, which matches nothing", async () => {
    // Distinct from the null above, and that distinction is the whole point:
    // null would widen this request to the entire organisation.
    await composeSummary(usageInput({ statuses: ["waiting", "stale"] }));

    expect(capturedFacets().statuses).toEqual([]);
  });

  it("collapses the singular back-compat status spelling into the same resolution", async () => {
    await composeSummary(usageInput({ status: "waiting" }));

    expect(capturedFacets().statuses).toEqual([]);
  });
});

describe("toFacets — the priority facet", () => {
  it("splits a selection into members and the unset arm, never one list", async () => {
    // `= ANY(...)` cannot match a NULL priority, so the unset token travels as
    // its own boolean; folding it into the members would select nothing for it.
    await composeSummary(
      usageInput({ priorities: [PRIORITY_UNSET_VALUE, Priority.High] })
    );

    const facets = capturedFacets();
    expect(facets.priorityMembers).toEqual([Priority.High]);
    expect(facets.priorityIncludesUnset).toBe(true);
  });

  it("resolves no priority selection to no narrowing", async () => {
    // ISS-10332 landed this facet on the cohort ISS-10753 deletes, so the
    // accumulator's own default matters: a `true` here would narrow every
    // unfiltered read to the unset rows.
    await composeSummary(usageInput({}));

    const facets = capturedFacets();
    expect(facets.priorityMembers).toEqual([]);
    expect(facets.priorityIncludesUnset).toBe(false);
  });
});

describe("toFacets — the subscription billing vocabulary", () => {
  it("resolves the shared vocabulary itself rather than leaving the reader to", async () => {
    // ISS-10753 moved this from the reader to the composer. An empty value here
    // is not "no narrowing": `sd.billing_mode = ANY('{}')` is false everywhere,
    // so every subscription dollar would land in `unclassified_cost` and the
    // cost-bucket Unknown arm would reclassify worked $0 subscription sessions
    // (tamsinb on #7684).
    await composeSummary(usageInput({}));

    expect(capturedFacets().subscriptionBillingModes).toEqual(
      [...SUBSCRIPTION_BILLING_MODES].sort()
    );
    expect(capturedFacets().subscriptionBillingModes).not.toEqual([]);
  });
});

describe("resolveQualityMode", () => {
  it("resolves a non-'all' quality value to its own predicate mode, not the all/no-op null", async () => {
    await composeSummary(usageInput({ quality: "substantive" }));

    expect(capturedFacets().qualityMode).toBe("substantive");
  });

  it("resolves the absent/all quality default to the no-op null, not the literal 'all'", async () => {
    await composeSummary(usageInput({}));

    expect(capturedFacets().qualityMode).toBeNull();
  });
});

describe("readProjectNames — the byProject label lookup", () => {
  it("scopes the project-name lookup to the exact organization and requested ids", async () => {
    readFacetCounts.mockResolvedValue([
      {
        dimension: "project",
        value: "project-1",
        sessionCount: 4,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 0,
        errorCount: 0,
      },
    ]);

    const summary = await composeSummary(usageInput({}));

    expect(projectFindMany).toHaveBeenCalledWith({
      where: { organizationId: "org-1", id: { in: ["project-1"] } },
      select: { id: true, name: true },
    });
    expect(summary.byProject).toEqual([
      { projectId: "project-1", projectName: "Project One", sessionCount: 4 },
    ]);
  });

  it("omits a project facet row whose id belongs to a different organization", async () => {
    // `project-2` sits under "org-9" in the fake directory, never "org-1".
    // The fake filters on BOTH organizationId and id, so a mis-scoped lookup
    // resolves to no name and `projectByProject` drops the row rather than
    // mislabeling it with a cross-org name.
    readFacetCounts.mockResolvedValue([
      {
        dimension: "project",
        value: "project-2",
        sessionCount: 4,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 0,
        errorCount: 0,
      },
    ]);

    const summary = await composeSummary(usageInput({}));

    expect(summary.byProject).toEqual([]);
  });
});

describe("composeUsageSummary / readComparison — the prior-period comparison", () => {
  const PRIOR_COMPARABLE_WINDOW = {
    comparison: AgentSessionComparisonMode.Prior,
    startDate: "2020-01-08T00:00:00.000Z",
    endDate: "2020-01-14T23:59:59.999Z",
  };

  it("omits the comparison when the window opts in but has no dates to derive a prior period from", async () => {
    const summary = await composeSummary(
      usageInput({ comparison: AgentSessionComparisonMode.Prior })
    );

    expect(summary).not.toHaveProperty("comparison");
  });

  it("includes the comparison, folding the metered-cost delta from a defined current figure", async () => {
    const summary = await composeSummary(usageInput(PRIOR_COMPARABLE_WINDOW));

    expect(summary).toHaveProperty("comparison");
    // Both periods' mocked cost split resolve metered cost to the same 100,
    // so the movement is 0%.
    expect(
      summary.comparison?.deltas[AgentSessionComparisonMetric.MeteredCost]
    ).toBe(0);
  });
});
