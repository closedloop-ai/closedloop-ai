import "server-only";

import type { Prisma, withDb } from "@repo/database";
import {
  DetailUsageAggregateFailedEvent,
  reportDetailUsageAggregateFailure,
} from "./detail-usage-failure-telemetry";

// ---------------------------------------------------------------------------
// ISS-9852 (PRD-666, cap family TC-2): the component detail's Invocations and
// Sessions cards are totals over the WHOLE usage population, never a fold over
// the `MAX_ORG_ORPHAN_USAGE_ROWS`-bounded row reads that feed the harness,
// authors and per-session derivations. Those reads stay as a request-scoped
// sample; when one reports its `take` bound, the totals come from here.
// ---------------------------------------------------------------------------

/**
 * Whole-population totals for one detail identity: the invocation sum and the
 * DISTINCT session set. The set (not a count) is returned because the
 * inventory-present detail unions it with its FK-lane sessions, and a session
 * can carry rows in both.
 */
export type DetailUsageTotals = {
  invocations: number;
  sessionIds: Set<string>;
};

/**
 * Keeps a usage row by its raw `(componentKind, componentKey)`. The plugin
 * detail passes its `belongsToPlugin` re-match: the SQL prefilter admits on the
 * trigger-folded `componentKeyNormalized` (`lower(btrim())`), the re-match on
 * `normalizeComponentKey` (`toLowerCase().trim()`), and the two folds differ on
 * the ISS-6756 residual. The sample drops a row the re-match rejects, so the
 * totals must drop it too.
 */
export type UsageIdentityFilter = (
  componentKind: string,
  componentKey: string
) => boolean;

type UsageDb = Parameters<Parameters<typeof withDb>[0]>[0];

/**
 * Read the totals over one or more usage-row predicates, each issued as its own
 * statements: `_sum(invocationCount)` and a `groupBy` on `agentSessionId`
 * (Prisma has no `COUNT(DISTINCT)`; the group rows are one per session, with no
 * `take`). With `keep`, the sum is grouped by raw identity instead so rejected
 * identities can be dropped — see {@link addKeptStatementTotals}.
 *
 * The invocation sums are ADDED across statements, so callers must pass
 * predicates that PARTITION the rows: the orphan-only detail passes one
 * `{ OR: lanes }` (its two lanes split on `agentComponentId` — null or
 * tombstoned FK versus live FK — so a row satisfies at most one, and the single
 * statement makes double-counting impossible regardless), and the plugin detail
 * passes its bind-budget slices, whose identity arms are distinct equalities on
 * one column. The session sets are UNIONED, so a session spanning two
 * statements is counted once.
 *
 * Never rejects: `AgentComponentSessionUsage` carries no index the
 * `session.artifact` org join can use on its own, so on a pathological org this
 * is the read that can time out. A failure resolves to `null` after routing to
 * the monitored error path (the same lane `fetchDetailUsageSeenBounds` uses,
 * bound per org by `reportDetailUsageAggregateFailure`), and the caller keeps
 * the folded floor rather than failing the whole detail.
 */
export async function fetchDetailUsageTotals(
  db: UsageDb,
  statements: readonly Prisma.AgentComponentSessionUsageWhereInput[],
  context: { organizationId: string; kind: string },
  keep?: UsageIdentityFilter
): Promise<DetailUsageTotals | null> {
  let invocations = 0;
  const sessionIds = new Set<string>();
  try {
    for (const where of statements) {
      invocations += keep
        ? await addKeptStatementTotals(db, where, keep, sessionIds)
        : await addStatementTotals(db, where, sessionIds);
    }
    return { invocations, sessionIds };
  } catch (error) {
    reportDetailUsageAggregateFailure(
      DetailUsageAggregateFailedEvent.Totals,
      context.organizationId,
      {
        error: error instanceof Error ? error.message : String(error),
        kind: context.kind,
        statementCount: statements.length,
      }
    );
    return null;
  }
}

/** One statement's invocation sum; its distinct sessions go into `sessionIds`. */
async function addStatementTotals(
  db: UsageDb,
  where: Prisma.AgentComponentSessionUsageWhereInput,
  sessionIds: Set<string>
): Promise<number> {
  const [sum, sessions] = await Promise.all([
    db.agentComponentSessionUsage.aggregate({
      where,
      _sum: { invocationCount: true },
    }),
    db.agentComponentSessionUsage.groupBy({
      by: ["agentSessionId"],
      where,
    }),
  ]);
  for (const group of sessions) {
    sessionIds.add(group.agentSessionId);
  }
  return sum._sum.invocationCount ?? 0;
}

/**
 * {@link addStatementTotals}, counting only the rows `keep` accepts. The sum is
 * grouped by raw `(componentKind, componentKey)` — one group per spelling the
 * predicate admitted, a handful — so a rejected spelling is dropped before it
 * is added. Sessions take the plain per-session `groupBy` unless a spelling was
 * rejected; only then is the grouping widened to the identity, so a session is
 * counted only through a row the filter keeps.
 */
async function addKeptStatementTotals(
  db: UsageDb,
  where: Prisma.AgentComponentSessionUsageWhereInput,
  keep: UsageIdentityFilter,
  sessionIds: Set<string>
): Promise<number> {
  const identities = await db.agentComponentSessionUsage.groupBy({
    by: ["componentKind", "componentKey"],
    where,
    _sum: { invocationCount: true },
  });
  let invocations = 0;
  let rejectedAny = false;
  for (const identity of identities) {
    if (keep(identity.componentKind, identity.componentKey)) {
      invocations += identity._sum.invocationCount ?? 0;
    } else {
      rejectedAny = true;
    }
  }
  if (!rejectedAny) {
    const sessions = await db.agentComponentSessionUsage.groupBy({
      by: ["agentSessionId"],
      where,
    });
    for (const group of sessions) {
      sessionIds.add(group.agentSessionId);
    }
    return invocations;
  }
  const sessionIdentities = await db.agentComponentSessionUsage.groupBy({
    by: ["agentSessionId", "componentKind", "componentKey"],
    where,
  });
  for (const group of sessionIdentities) {
    if (keep(group.componentKind, group.componentKey)) {
      sessionIds.add(group.agentSessionId);
    }
  }
  return invocations;
}
