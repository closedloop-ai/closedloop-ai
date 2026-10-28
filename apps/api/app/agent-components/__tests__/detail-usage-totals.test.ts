/**
 * ISS-9852: the component detail's Invocations/Sessions totals are read
 * rowless over the lane predicates, never folded from a capped row read.
 *
 * `fetchDetailUsageTotals` is the one aggregate both the orphan-only detail
 * and the plugin detail reach for when a lane reports its `take` bound. Its
 * contract is what these cases pin: sums ADD across statements, session sets
 * UNION, and a rejected statement resolves to `null` on the monitored path so
 * the caller keeps its folded floor instead of 500ing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ logError: vi.fn() }));

vi.mock("@repo/database", () => ({ Prisma: {}, withDb: vi.fn() }));

vi.mock("@repo/observability/log", () => ({
  log: { error: mocks.logError, info: vi.fn(), warn: vi.fn() },
}));

import { detailUsageAggregateFailureThrottle } from "../detail-usage-failure-telemetry";
import { fetchDetailUsageTotals } from "../detail-usage-totals";
import {
  detailChildUsageStatementWheres,
  loadDetailChildUsageRows,
  type UsageIdentityPredicate,
} from "../plugin-child-usage";

beforeEach(() => {
  detailUsageAggregateFailureThrottle.clear();
  mocks.logError.mockClear();
});

const ORG = "org-iss-9852";
const KIND = "skill";
const STATEMENT_A = { componentKeyNormalized: "a" };
const STATEMENT_B = { componentKeyNormalized: "b" };

type GroupByArgs = { by: string[]; where: unknown };
type AggregateArgs = { where: unknown; _sum: { invocationCount: true } };

function buildDb(
  answers: Map<unknown, { sum: number | null; sessions: string[] }>,
  rejects = false
) {
  const aggregate = vi.fn(async (args: AggregateArgs) => {
    await Promise.resolve();
    if (rejects) {
      throw new Error("statement timeout");
    }
    return { _sum: { invocationCount: answers.get(args.where)?.sum ?? null } };
  });
  const groupBy = vi.fn(async (args: GroupByArgs) => {
    await Promise.resolve();
    return (answers.get(args.where)?.sessions ?? []).map((agentSessionId) => ({
      agentSessionId,
    }));
  });
  return {
    db: {
      agentComponentSessionUsage: { aggregate, groupBy },
    } as unknown as Parameters<typeof fetchDetailUsageTotals>[0],
    aggregate,
    groupBy,
  };
}

describe("fetchDetailUsageTotals (ISS-9852)", () => {
  it("adds the invocation sums and unions the sessions across statements", async () => {
    const { db, aggregate, groupBy } = buildDb(
      new Map([
        [STATEMENT_A, { sum: 7, sessions: ["s1", "s2"] }],
        [STATEMENT_B, { sum: 5, sessions: ["s2", "s3"] }],
      ])
    );

    const totals = await fetchDetailUsageTotals(
      db,
      [STATEMENT_A, STATEMENT_B],
      { organizationId: ORG, kind: KIND }
    );

    expect(totals).toEqual({
      invocations: 12,
      sessionIds: new Set(["s1", "s2", "s3"]),
    });
    // The sum is the DB's, over the invocation column, one statement per
    // predicate — never a fold over fetched rows.
    expect(aggregate.mock.calls.map(([args]) => args)).toEqual([
      { where: STATEMENT_A, _sum: { invocationCount: true } },
      { where: STATEMENT_B, _sum: { invocationCount: true } },
    ]);
    // Distinct sessions come from a `groupBy` on the session id with no `take`
    // — the DB collapses the rows, the caller never pages them.
    for (const [args] of groupBy.mock.calls) {
      expect(args.by).toEqual(["agentSessionId"]);
      expect(args).not.toHaveProperty("take");
    }
  });

  it("reads a null sum as zero, not as an unknown", async () => {
    const { db } = buildDb(
      new Map([[STATEMENT_A, { sum: null, sessions: [] }]])
    );

    const totals = await fetchDetailUsageTotals(db, [STATEMENT_A], {
      organizationId: ORG,
      kind: KIND,
    });

    expect(totals).toEqual({ invocations: 0, sessionIds: new Set() });
  });

  it("resolves null and routes a rejected statement to the monitored path", async () => {
    const { db } = buildDb(new Map(), true);

    const totals = await fetchDetailUsageTotals(db, [STATEMENT_A], {
      organizationId: ORG,
      kind: KIND,
    });

    expect(totals).toBeNull();
    expect(mocks.logError).toHaveBeenCalledWith(
      "agent_components_detail_usage_totals_aggregate_failed",
      expect.objectContaining({
        error: "statement timeout",
        kind: KIND,
        organizationId: ORG,
        statementCount: 1,
      })
    );
  });
});

describe("fetchDetailUsageTotals with an identity filter (ISS-9852)", () => {
  /**
   * chatgpt-codex-connector on #7051: the plugin detail's SQL prefilter admits
   * a spelling its JS re-match rejects (the ISS-6756 residual). A rejected
   * spelling adds no invocations, and a session reached only through one is
   * not counted.
   */
  it("drops a rejected spelling from the sum and counts sessions only through kept rows", async () => {
    const { db, aggregate, groupBy } = buildIdentityDb([
      { key: KEPT_KEY, sum: 7, sessions: ["s1", "s2"] },
      { key: REJECTED_KEY, sum: 5, sessions: ["s2", "s3"] },
    ]);

    const totals = await fetchDetailUsageTotals(
      db,
      [STATEMENT_A],
      { organizationId: ORG, kind: KIND },
      keepKeptKey
    );

    expect(totals).toEqual({
      invocations: 7,
      sessionIds: new Set(["s1", "s2"]),
    });
    expect(aggregate).not.toHaveBeenCalled();
    expect(groupBy.mock.calls.map(([args]) => args.by)).toEqual([
      ["componentKind", "componentKey"],
      ["agentSessionId", "componentKind", "componentKey"],
    ]);
  });

  it("takes the plain per-session groupBy when every spelling is kept", async () => {
    const { db, groupBy } = buildIdentityDb([
      { key: KEPT_KEY, sum: 7, sessions: ["s1", "s2"] },
    ]);

    const totals = await fetchDetailUsageTotals(
      db,
      [STATEMENT_A],
      { organizationId: ORG, kind: KIND },
      keepKeptKey
    );

    expect(totals).toEqual({
      invocations: 7,
      sessionIds: new Set(["s1", "s2"]),
    });
    expect(groupBy.mock.calls.map(([args]) => args.by)).toEqual([
      ["componentKind", "componentKey"],
      ["agentSessionId"],
    ]);
  });
});

const KEPT_KEY = "reviewer";
const REJECTED_KEY = "REVİEWER";

function keepKeptKey(_componentKind: string, componentKey: string): boolean {
  return componentKey === KEPT_KEY;
}

/**
 * A usage delegate that answers every `groupBy` shape from one set of
 * per-spelling groups, so the per-session read and the per-identity read
 * describe the same rows.
 */
function buildIdentityDb(
  groups: { key: string; sum: number; sessions: string[] }[]
) {
  const aggregate = vi.fn();
  const groupBy = vi.fn(async (args: GroupByArgs) => {
    await Promise.resolve();
    const by = args.by.join(",");
    if (by === "componentKind,componentKey") {
      return groups.map((group) => ({
        componentKind: KIND,
        componentKey: group.key,
        _sum: { invocationCount: group.sum },
      }));
    }
    if (by === "agentSessionId") {
      return [...new Set(groups.flatMap((group) => group.sessions))].map(
        (agentSessionId) => ({ agentSessionId })
      );
    }
    return groups.flatMap((group) =>
      group.sessions.map((agentSessionId) => ({
        agentSessionId,
        componentKind: KIND,
        componentKey: group.key,
      }))
    );
  });
  return {
    db: {
      agentComponentSessionUsage: { aggregate, groupBy },
    } as unknown as Parameters<typeof fetchDetailUsageTotals>[0],
    aggregate,
    groupBy,
  };
}

describe("detailChildUsageStatementWheres (ISS-9852)", () => {
  /**
   * The totals aggregate and the row read must iterate the SAME slices: the
   * predicates the row read issued are exactly the predicates the totals read
   * receives, so a bound cannot be added to one and forgotten on the other.
   */
  it("yields the exact predicates the plugin detail row read issues", async () => {
    const prefilter: UsageIdentityPredicate[] = Array.from(
      { length: 20_000 },
      (_unused, index) => ({
        componentKind: "command",
        componentKeyNormalized: `child-${index}`,
      })
    );
    const findMany = vi.fn(async (_args: { where: unknown }) => {
      await Promise.resolve();
      return [];
    });
    const db = {
      agentComponentSessionUsage: { findMany },
    } as unknown as Parameters<typeof loadDetailChildUsageRows>[0];

    await loadDetailChildUsageRows(db, prefilter, ORG);
    const wheres = detailChildUsageStatementWheres(prefilter, ORG);

    expect(wheres.length).toBeGreaterThan(1);
    expect(findMany.mock.calls.map(([args]) => args.where)).toEqual(wheres);
    // Every identity lands in exactly one slice, which is what makes a
    // per-slice `_sum` additive.
    expect(wheres.flatMap((where) => where.OR)).toEqual(prefilter);
  });
});
