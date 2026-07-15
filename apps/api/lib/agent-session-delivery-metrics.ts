// FEA-3156 — sessions-usage delivery metrics.
//
// Computes the three delivery-summary KPIs the Sessions page top row needs
// (PRs shipped, median PR size, merged KLOC per dollar) for the SAME
// matched-session set the usage filters already scope. The math is NOT
// reinvented here: this module is a thin ADAPTER that projects the matched
// sessions' linked merged PRs into the dialect-agnostic
// `NormalizedDeliveryRows` contract and runs the delivery-KPI SSOT engine
// (`computeDeliveryKpiResult`) — the same registry/compute the insights
// dashboard reads. So "merged PR count", "median PR size", and "KLOC" carry the
// identical definitions cross-surface, and only the ROW-PREP (which merged PRs)
// lives here.
//
// COST/OOM BOUNDEDNESS (Codex P2, FEA-3156 review): this adapter must NOT
// materialize an org's full session history to sum the KLOC-per-dollar cost
// denominator. `getUsageSummary` already derives the API-billed cost from
// bounded DB aggregates (a `groupBy` over sourceLoopId/billingMode, classified
// against each loop's apiKeySource); we take that classified scalar as `costUsd`
// (subscription-covered spend already excluded per the billing-mode contract)
// and only page the DEDUPED merged-PR rows here — and only when the matched set
// actually carries session→PR links (cheap `findFirst` probe), so an
// unfiltered/broad Sessions dashboard with no PR links never scans rows at all.

import { computeDeliveryKpiResult } from "@repo/api/src/insights/delivery-kpis/compute";
import {
  type NormalizedPr,
  NormalizedPrState,
  type NormalizedSession,
} from "@repo/api/src/insights/delivery-kpis/normalized-rows";
import { DeliveryKpiKey } from "@repo/api/src/insights/delivery-kpis/registry";
import { GitHubPRState } from "@repo/api/src/types/github";
import type { Prisma } from "@repo/database";
import {
  hasMatchingSessionPrLinks,
  SESSION_PR_LINK_WHERE,
  visitSessionDetailPages,
} from "./session-pr-links";

/**
 * The three delivery metrics wired into the Sessions summary cards. A metric is
 * `null` ONLY when it genuinely cannot be computed for the matched set — no
 * merged PRs (medianPrSize / mergedKlocPerDollar) or zero token cost
 * (mergedKlocPerDollar). `mergedPrCount` is always a real count (0, not null).
 */
export type AgentSessionDeliveryMetrics = {
  /** Count of merged PRs linked to the matched sessions ("merged in range"). */
  mergedPrCount: number;
  /**
   * Median gross lines (additions + deletions) across those merged PRs, over
   * enriched PRs only (SSOT PrSize semantics). Null when there are no merged
   * PRs to measure.
   */
  medianPrSize: number | null;
  /**
   * Merged KLOC ÷ token cost across the matched sessions. Null when there are
   * no merged lines to count or no cost to divide by.
   */
  mergedKlocPerDollar: number | null;
};

const EMPTY_METRICS: AgentSessionDeliveryMetrics = {
  mergedPrCount: 0,
  medianPrSize: null,
  mergedKlocPerDollar: null,
};

// Only the merged-PR row-prep needs a per-session projection; the cost/token
// denominator comes from the caller's bounded aggregate. We therefore select
// just the linked session_pr branch details — no session cost/token scalars.
const mergedPrLinkSelect = {
  artifactId: true,
  artifact: {
    select: {
      sourceLinks: {
        where: SESSION_PR_LINK_WHERE,
        orderBy: { createdAt: "asc" as const },
        select: {
          targetId: true,
          target: {
            select: {
              branch: {
                select: {
                  currentPullRequestDetail: {
                    select: {
                      number: true,
                      prState: true,
                      mergedAt: true,
                      additions: true,
                      deletions: true,
                      isCurrent: true,
                      repositoryFullName: true,
                      repository: { select: { fullName: true } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.SessionDetailSelect;

type MergedPrLinkRecord = Prisma.SessionDetailGetPayload<{
  select: typeof mergedPrLinkSelect;
}>;

/**
 * Computes the sessions-usage delivery metrics for the matched session set.
 *
 * `where` scopes the matched sessions (the SAME predicate the usage aggregate
 * builds from the filters). `costUsd` is the caller's already-classified
 * API-billed cost for that set — the KLOC-per-dollar denominator — so this
 * adapter never re-materializes the sessions to sum cost, and subscription-
 * covered spend (excluded upstream per the billing-mode contract) never inflates
 * the denominator. Pass `null` only when cost is genuinely unknown.
 *
 * MERGED-PR ROW-PREP: a merged PR is the current PR detail of a branch linked
 * to a matched session, with `prState === MERGED` and a `mergedAt` — matching
 * the branch-analytics "Merged PRs" count definition (prState === MERGED) and
 * the SSOT `mergedPrs` population (state merged + mergedAt present). Each linked
 * PR is counted once (deduped by repo#number, or by branch artifact id when the
 * repo is unidentifiable) even if several matched sessions link the same PR, so
 * a multi-session PR is not over-counted and an unidentifiable PR can't swallow
 * a real one.
 */
export async function computeAgentSessionDeliveryMetrics(
  where: Prisma.SessionDetailWhereInput,
  costUsd: number | null
): Promise<AgentSessionDeliveryMetrics> {
  // Cheap probe: with no session→PR links there can be no merged PRs, so skip
  // the row scan entirely (keeps `/agent-sessions/usage` bounded by the DB
  // aggregates for broad/unfiltered dashboards).
  if (!(await hasMatchingSessionPrLinks(where))) {
    return EMPTY_METRICS;
  }

  const prsByIdentity = new Map<string, NormalizedPr>();
  await visitSessionDetailPages(
    where,
    mergedPrLinkSelect,
    (records: MergedPrLinkRecord[]) => {
      for (const record of records) {
        collectMergedPrs(record, prsByIdentity);
      }
    }
  );

  const prs = [...prsByIdentity.values()];
  if (prs.length === 0) {
    return EMPTY_METRICS;
  }

  // Cost is injected as a single synthetic session so the SSOT `Cost` KPI (a
  // naive SUM over `sessions[].costUsd`) reproduces the aggregate total without
  // materializing one row per real session. SessionsCount is unused here.
  const sessions: NormalizedSession[] =
    costUsd === null ? [] : [{ startedAt: 0, costUsd, tokens: 0 }];

  // An all-inclusive window: the `where` predicate already applied the filters'
  // date range to the matched sessions, and the merged PRs are the ones linked
  // to those sessions — so the SSOT window must NOT re-filter by mergedAt/
  // startedAt (which would drop PRs merged outside the session's own start
  // window). Populations still honor state (merged) via this window.
  const { values } = computeDeliveryKpiResult({
    prs,
    sessions,
    branches: [],
    window: { start: 0, end: Number.MAX_SAFE_INTEGER },
  });

  return {
    mergedPrCount: values.get(DeliveryKpiKey.MergedCount) ?? 0,
    medianPrSize: values.get(DeliveryKpiKey.PrSize) ?? null,
    // KLOC-per-dollar is a REGISTERED derived KPI (Kloc ÷ Cost), so the engine
    // divides by the RAW un-rounded KLOC from its base value table — not the
    // display-rounded KLOC (which rounds a sub-100-line window to 0.0 and would
    // fabricate 0.00 KLOC/$). A `0` result means merged PRs exist but landed 0
    // gross lines; per the field contract that is "no merged lines to measure",
    // so it collapses to null alongside the engine's own null (no merged PRs /
    // no cost).
    mergedKlocPerDollar: values.get(DeliveryKpiKey.MergedKlocPerDollar) || null,
  };
}

function collectMergedPrs(
  record: MergedPrLinkRecord,
  prsByIdentity: Map<string, NormalizedPr>
): void {
  for (const link of record.artifact.sourceLinks ?? []) {
    const detail = link.target?.branch?.currentPullRequestDetail;
    if (
      !detail?.isCurrent ||
      detail.prState !== GitHubPRState.Merged ||
      detail.mergedAt === null
    ) {
      continue;
    }
    const repositoryFullName =
      detail.repository?.fullName ?? detail.repositoryFullName ?? null;
    // Dedup a PR that several matched sessions link to. Key on repo#number when
    // the repo is known. But NEVER fold rows into a shared `#number` bucket when
    // the repo is unidentifiable (both identifiers null/empty): two different
    // repos' PRs both numbered 42 would collapse to one `#42` and one would be
    // dropped from BOTH the count and the median (dedup-by-nullable trap). When
    // the repo can't identify the row, key by the branch artifact id
    // (`link.targetId`) — a stable per-row identity that can't swallow a real PR.
    const identity = repositoryFullName
      ? `${repositoryFullName.toLowerCase()}#${detail.number}`
      : `branch:${link.targetId}`;
    if (prsByIdentity.has(identity)) {
      continue;
    }
    const additions = detail.additions ?? null;
    const deletions = detail.deletions ?? null;
    const mergedAtMs = detail.mergedAt.getTime();
    prsByIdentity.set(identity, {
      state: NormalizedPrState.Merged,
      createdAt: mergedAtMs,
      mergedAt: mergedAtMs,
      closedAt: null,
      additions,
      deletions,
      // Enriched iff the PR carries a real line diff — mirrors the insights
      // surface, which medians PR size over enriched PRs only so an un-sized PR
      // can't drag the median toward 0.
      enriched: additions !== null && deletions !== null,
      observedAt: mergedAtMs,
    });
  }
}
