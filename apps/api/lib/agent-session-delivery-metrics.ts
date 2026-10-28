// FEA-3156 — sessions-usage delivery metrics.
//
// Computes the three delivery-summary KPIs the Sessions page top row needs
// (PRs shipped, median PR size, merged LOC per dollar) for the SAME
// matched-session set the usage filters already scope. The math is NOT
// reinvented here: this module is a thin ADAPTER that projects the matched
// sessions' linked merged PRs into the dialect-agnostic
// `NormalizedDeliveryRows` contract and runs the delivery-KPI SSOT engine
// (`computeDeliveryKpiResult`) — the same registry/compute the insights
// dashboard reads. So "merged PR count", "median PR size", and "LOC" carry the
// identical definitions cross-surface, and only the ROW-PREP (which merged PRs)
// lives here.
//
// COST/OOM BOUNDEDNESS (Codex P2, FEA-3156 review): this adapter must NOT
// materialize an org's full session history to sum the LOC-per-dollar cost
// denominator. `getUsageSummary` already derives the classified cost of the
// selected window from bounded DB aggregates (a `groupBy` over
// legacyLoopCostLedger/billingMode); we take
// that classified scalar as `costUsd` (which of its ledgers were summed is the
// caller's basis decision — ISS-6526)
// and only read the merged-PR rows here — and only when the matched set
// actually carries session→PR links (cheap `findFirst` probe), so an
// unfiltered/broad Sessions dashboard with no PR links never scans rows at all.
//
// ISS-6028: those merged-PR rows are read from the PR SIDE, semi-joined back
// through the session→PR links. The delivery scope strips the session-activity
// date window by design (see `service/delivery-metrics.ts`), so the old
// session-side pager scanned every PR-linked session in the org, all-time,
// hydrating a nested link→branch→PR relation tree per row — an all-time scan
// that grows forever to feed a fixed-size card. The population the cards
// actually need is the DISTINCT merged PRs, which is what the DB now returns.

import { computeDeliveryKpiResult } from "@repo/api/src/insights/delivery-kpis/compute";
import {
  type DeliveryWindow,
  type NormalizedPr,
  NormalizedPrState,
  type NormalizedSession,
} from "@repo/api/src/insights/delivery-kpis/normalized-rows";
import { prPopulations } from "@repo/api/src/insights/delivery-kpis/populations";
import { DeliveryKpiKey } from "@repo/api/src/insights/delivery-kpis/registry";
import type { Prisma } from "@repo/database";
import type { LimitFunction } from "p-limit";
import {
  findMergedPrsLinkedToSessions,
  hasMatchingSessionPrLinks,
  type LinkedBranchArtifact,
  type MergedPrBranchAdmissionKind,
  mergedPrIdentity,
  mergedPrLinkedBranches,
  type SessionPrBranchAdmission,
} from "./session-pr-links";

/**
 * The three delivery metrics wired into the Sessions summary cards. A metric is
 * `null` when it genuinely cannot be computed for the matched set — no merged
 * PRs (all three) or zero token cost (mergedLocPerDollar).
 *
 * `mergedPrCount` is `null` (NOT `0`) when the matched set has NO merged PRs —
 * i.e. there is nothing to count (data-honesty, FEA-3574 review, whitlockk). A `0`
 * count would render a real "0" on the PRs Shipped card while its sibling
 * delivery cards (medianPrSize / mergedLocPerDollar) dash on the same absent
 * data, so an out-of-range / offline / GitHub-not-connected read would lie about
 * having merged zero PRs. `null` routes all three cards to the consumer's
 * neutral no-data state together. It is a real, finite count (>= 1) only when at
 * least one merged PR was actually found.
 */
/**
 * ISS-7705: the branch artifact a merged PR was admitted against, plus when that
 * PR merged.
 *
 * The LOC/$ coverage gate needs the SESSIONS whose merged work is actually in the
 * numerator, and a session reaches a merged PR only through its link to that PR's
 * branch artifact. Emitting the branch here — rather than re-deriving it from a
 * second read — is what lets the gate scope its cohort to the same PRs the lines
 * came from instead of to "every session that ever carried a PR link", which is a
 * far wider set that contributes no lines and would fault a covered ratio.
 *
 * `mergedAtMs` rides along because the numerator is bounded by the selected merge
 * window (FEA-4295) and the branch set has to be filtered to the same bound.
 *
 * So does `prIdentity`: a REUSED branch (same branch, a second PR) carries the
 * session→PR links of every PR that ever ran on it, so the branch id alone
 * cannot tell the coverage probe which of those links belongs to the PR that was
 * actually admitted. Dropping it let a session working a DIFFERENT PR on the same
 * branch into the numerator cohort — and, uncovered by the divisor, blank a
 * genuinely covered LOC/$ card as `missing` or `stale`.
 */
export type MergedPrBranchRef = {
  branchArtifactId: string;
  mergedAtMs: number;
  admissionKind: MergedPrBranchAdmissionKind;
  /**
   * The `repo#number` identity that admitted this PR against the branch, or
   * `null` when a unique-Branch fallback admitted it. `admissionKind` names
   * which fallback.
   */
  prIdentity: string | null;
};

/** The merged-PR population plus the branch refs the coverage gate scopes on. */
export type MergedPrScope = {
  prs: NormalizedPr[];
  mergedBranches: MergedPrBranchRef[];
};

export type AgentSessionDeliveryMetrics = {
  /**
   * Count of merged PRs linked to the matched sessions ("merged in range"), or
   * `null` when the matched set has no merged PRs to count (no data — never a
   * fabricated `0`).
   */
  mergedPrCount: number | null;
  /**
   * Median gross lines (additions + deletions) across those merged PRs, over
   * enriched PRs only (SSOT PrSize semantics). Null when there are no merged
   * PRs to measure.
   */
  medianPrSize: number | null;
  /**
   * ISS-4667: merged gross LINES ÷ token cost across the matched sessions —
   * LOC/$, higher is better. Null when there are no merged lines to count or no
   * cost to divide by.
   */
  mergedLocPerDollar: number | null;
};

// The selected date window the merged-PR delivery metrics are bounded by
// (FEA-4295) reuses the canonical `DeliveryWindow` `{ start, end }` (epoch ms,
// inclusive) from the delivery-KPI SSOT boundary — the SAME shape the engine's
// populations window against — rather than a second, structurally-identical
// exported type that could drift (thread davetho). The merge-specific meaning
// lives in the parameter name (`mergeWindow`) and the JSDoc below.

const EMPTY_METRICS: AgentSessionDeliveryMetrics = {
  // No merged PRs → nothing to count. `null` (not `0`) so the PRs Shipped card
  // renders the neutral no-data state alongside its sibling delivery cards
  // rather than a fabricated "0 merged PRs" (data-honesty, FEA-3574 / whitlockk).
  mergedPrCount: null,
  medianPrSize: null,
  mergedLocPerDollar: null,
};

// The four scalars the delivery KPIs project (`state`, `mergedAt`, `additions`,
// `deletions`) plus the components `mergedPrIdentity` dedups on. The cost/token
// denominator comes from the caller's bounded aggregate, so no session scalars
// are read here at all.
const mergedPrSelect = {
  number: true,
  prState: true,
  mergedAt: true,
  additions: true,
  deletions: true,
  lastVerifiedAt: true,
  repositoryId: true,
  repositoryFullName: true,
  repository: { select: { fullName: true } },
} satisfies Prisma.PullRequestDetailSelect;

type MergedPrRecord = Prisma.PullRequestDetailGetPayload<{
  select: typeof mergedPrSelect;
}> &
  LinkedBranchArtifact;

/**
 * The collection half of the delivery read: the link probe plus the
 * PR-side read that dedupes every merged PR linked to `where` (ISS-5809).
 *
 * Split out because the delivery scope carries no session-activity date window at
 * all (`collectDeliveryPrScope` strips it so an older session's
 * in-window merge is still counted), which makes this set IDENTICAL for the current period
 * and its prior comparison window. Collecting it once and evaluating it against
 * two `DeliveryWindow`s is what makes the prior `mergedPrCount` cost zero extra
 * DB work. ISS-9924: `mergedWithin` bounds this read on `mergedAt` to the span of
 * those windows, so it must cover every window the caller evaluates the set
 * against; `null` reads every merged PR, all-time.
 *
 * ISS-6028: the same absent date window is why this must NOT be read session-side.
 * Paging the org's PR-linked sessions was an all-time scan that grew forever to
 * feed a fixed-size card; `findMergedPrsLinkedToSessions` semi-joins back through
 * the same links and returns one narrow row per merged PR instead. It takes
 * `organizationId` alongside the session `where` so the PR-side read is
 * org-scoped in the query itself rather than only through the join.
 *
 * Returns an empty array when the probe finds no session→PR links at all, so a
 * broad/unfiltered dashboard never reads PR rows.
 */
export async function collectMergedPrsForScope(
  organizationId: string,
  where: Prisma.SessionDetailWhereInput,
  mergedWithin: DeliveryWindow | null = null,
  limiter?: LimitFunction
): Promise<MergedPrScope> {
  // Cheap probe: with no session→PR links there can be no merged PRs, so skip
  // the row read entirely (keeps `/agent-sessions/usage` bounded by the DB
  // aggregates for broad/unfiltered dashboards).
  if (!(await hasMatchingSessionPrLinks(where))) {
    return { prs: [], mergedBranches: [] };
  }

  const prsByIdentity = new Map<string, NormalizedPr>();
  const mergedBranches: MergedPrBranchRef[] = [];
  const { admissionByBranchId, details } = await findMergedPrsLinkedToSessions(
    organizationId,
    where,
    mergedPrSelect,
    mergedWithin,
    limiter
  );
  for (const detail of details) {
    collectMergedPr(detail, prsByIdentity, admissionByBranchId, mergedBranches);
  }

  return { prs: [...prsByIdentity.values()], mergedBranches };
}

/**
 * The PER-WINDOW half: runs the delivery-KPI SSOT engine over an already-collected
 * merged-PR set for one `mergeWindow` (ISS-5809).
 *
 * Pure and synchronous, so a caller comparing two adjacent periods evaluates the
 * same `prs` twice without touching the database again.
 */
export function computeDeliveryMetricsFromPrs(
  prs: NormalizedPr[],
  costUsd: number | null,
  mergeWindow: DeliveryWindow | null
): AgentSessionDeliveryMetrics {
  if (prs.length === 0) {
    return EMPTY_METRICS;
  }

  // FEA-4295: bound the merged-PR populations (count, median, LOC) by the
  // selected date window so the "PRs Shipped" card and its "merged in range"
  // caption agree. Previously the SSOT window was forced all-inclusive
  // (`{ start: 0, end: MAX }`), so a card scoped to e.g. 7d — which filters the
  // SESSIONS by their activity window — still counted EVERY merged PR ever
  // linked to those sessions, regardless of when it merged. The count then
  // contradicted its own "merged in range" caption. The SSOT `mergedPrs`
  // population filters on `mergedAt` in the closed window (null `mergedAt`
  // excluded), so passing the real bounds makes the count, median, and LOC/$
  // numerator all honor the same range; with no date filter selected we keep
  // the all-time window.
  const window = resolveDeliveryWindow(mergeWindow);

  // Cost is injected as a single synthetic session so the SSOT `Cost` KPI (a
  // naive SUM over `sessions[].costUsd`) reproduces the aggregate total without
  // materializing one row per real session. SessionsCount is unused here. Its
  // `startedAt` is pinned to the window start (not 0) so the `sessions`
  // population — which filters `startedAt` in the same window — keeps it; a
  // fixed 0 would drop the synthetic session out of a bounded window and zero
  // the LOC/$ denominator. ISS-6398: `costUsd` is the spend of the caller's
  // SELECTED window, so anchoring the synthetic carrier at the window start does
  // not change the total, and the ratio's two sides describe the same range.
  // ISS-6526 replaced ISS-6398's API-billed basis with the window's TOTAL spend
  // (subscription + metered + unknown), and the choice is the caller's, so do
  // not name a cost field here — see `resolveLocPerDollarCostBasis`.
  const sessions: NormalizedSession[] =
    costUsd === null ? [] : [{ startedAt: window.start, costUsd, tokens: 0 }];

  const rows = { prs, sessions, branches: [], window };
  const { values } = computeDeliveryKpiResult(rows);

  return {
    // We only reach here with >= 1 merged PR (every `prs` entry is state
    // `Merged`), so the engine's count is a real >= 1 value. Collapse a `0`/
    // absent engine result to `null` anyway so the count can never contradict
    // its sibling delivery cards (data-honesty — no fabricated "0 merged PRs").
    mergedPrCount: values.get(DeliveryKpiKey.MergedCount) || null,
    medianPrSize: values.get(DeliveryKpiKey.PrSize) ?? null,
    // LOC-per-dollar is a REGISTERED derived KPI (lines ÷ Cost, ISS-4667), so
    // the engine divides the RAW un-rounded base value — not the display-rounded
    // one (which rounds a sub-100-line window to 0.0 and would fabricate a
    // 0.00).
    mergedLocPerDollar: resolveDeliveryLocPerDollar(
      values.get(DeliveryKpiKey.MergedLocPerDollar),
      prPopulations.mergedPrs(rows)
    ),
  };
}

/**
 * ISS-9980 (RULED 2026-09-11), davetho on #7072: the live producer's half of
 * the measured-zero rule, and the reason it needs a guard the TypedSQL candidate
 * does not.
 *
 * A `0` ratio here has TWO preimages, and only one of them is a fact. The
 * numerator is the registered `Loc` base KPI, which deliberately carries NO
 * `onlyEnriched` filter (FEA-2952): an un-enriched merged PR arrives with null
 * `additions`/`deletions` and folds into the SUM as `0`. So a cohort whose merged
 * PRs are all still un-enriched sums to exactly the same `0` as a cohort that
 * genuinely landed no lines — the first is NOT KNOWABLE and the second is a
 * measurement. `enriched` is the tri-state the fold discards, so it is read back
 * here, off the same in-window population the KPI measured.
 *
 * Publishing `0` for the un-enriched case would report a measurement nobody
 * took; collapsing the measured case to `null` — what `|| null` did — hides a
 * true "this cohort merged nothing, and you spent $X" behind the same
 * placeholder that means "we could not measure". Both are the defect ISS-9980
 * names, one from each side.
 *
 * The POSITIVE sum is untouched: FEA-2952 accepted that a partially-enriched
 * cohort understates its landed lines, and that remains a known, bounded
 * understatement rather than a null.
 */
function resolveDeliveryLocPerDollar(
  value: number | null | undefined,
  mergedInWindow: readonly NormalizedPr[]
): number | null {
  if (!(typeof value === "number" && Number.isFinite(value) && value >= 0)) {
    return null;
  }
  if (value !== 0) {
    return value;
  }
  const numeratorMeasured =
    mergedInWindow.length > 0 && mergedInWindow.every((pr) => pr.enriched);
  return numeratorMeasured ? 0 : null;
}

function collectMergedPr(
  detail: MergedPrRecord,
  prsByIdentity: Map<string, NormalizedPr>,
  admissionByBranchId: ReadonlyMap<string, SessionPrBranchAdmission>,
  mergedBranches: MergedPrBranchRef[]
): void {
  // The merged-PR predicate is applied in the QUERY (`MERGED_PR_DETAIL_WHERE`,
  // the mirror of the shared `isMergedPrDetail`), so every row here is a
  // verified merged PR with a merge instant — restating it as a post-query
  // guard would only duplicate the `where`. `mergedAt` still needs narrowing:
  // Prisma's `{ not: null }` filter does not narrow the selected column's type.
  if (!detail.mergedAt) {
    return;
  }
  // Dedup identity stays the SHARED session→PR-link SSOT (`mergedPrIdentity` in
  // ./session-pr-links), so this adapter and the cohort-performance reader dedup
  // identically. It keys on `repo#number` only when BOTH are known and falls
  // back to `branch:${targetId}` otherwise — so two different repos' PRs both
  // numbered 42, or a number-less PR, can't collapse into one bucket and drop a
  // real PR from the count/median (dedup-by-nullable trap). The fallback's
  // `targetId` is the LINKED branch artifact, which is why the row carries the
  // branches it is current for rather than its own `branchArtifactId`.
  const additions = detail.additions ?? null;
  const deletions = detail.deletions ?? null;
  const mergedAtMs = detail.mergedAt.getTime();
  for (const admission of mergedPrLinkedBranches(detail, admissionByBranchId)) {
    const branchArtifactId = admission.branchArtifactId;
    const identity = mergedPrIdentity(detail, branchArtifactId);
    if (prsByIdentity.has(identity)) {
      continue;
    }
    // ISS-7705: recorded for EVERY admitted merged PR, deduped by identity on the
    // same terms as the population above, so the coverage cohort and the LOC
    // numerator are drawn from one admission decision rather than two. The
    // ADMITTING identity rides along so the cohort read can tell this PR's links
    // apart from another PR's on the same reused branch.
    mergedBranches.push({
      branchArtifactId,
      mergedAtMs,
      admissionKind: admission.admissionKind,
      prIdentity: admission.prIdentity,
    });
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

/**
 * Resolves the merged-PR compute window (FEA-4295). A `null` window (no date
 * filter selected) yields the all-time range so an unfiltered card counts every
 * merged PR. A window with only one bound selected leaves the other side open at
 * the corresponding all-time sentinel, so e.g. "since <date>" counts every PR
 * merged at or after that date. The SSOT `mergedPrs` population applies the
 * inclusive `[start, end]` test to each PR's `mergedAt` (null `mergedAt`
 * excluded), so returning these bounds is all the count/median/LOC need to be
 * range-truthful.
 */
function resolveDeliveryWindow(
  mergeWindow: DeliveryWindow | null
): DeliveryWindow {
  if (mergeWindow === null) {
    return { start: 0, end: Number.MAX_SAFE_INTEGER };
  }
  return mergeWindow;
}

/**
 * Builds the merged-PR window (FEA-4295) from the filters' ISO `startDate`/
 * `endDate`. Returns `null` when NEITHER bound is set (no date filter selected →
 * all-time count, so an unfiltered card is unchanged). When only one bound is
 * set the other side stays open at the corresponding all-time sentinel. An
 * unparseable bound is treated as absent for that side rather than throwing, so
 * a malformed value degrades to a wider window instead of dropping the metric —
 * the query validator already rejects malformed dates upstream, this is defense
 * in depth.
 */
export function resolveDeliveryMergeWindow(
  startDate: string | undefined,
  endDate: string | undefined
): DeliveryWindow | null {
  const start = parseWindowBound(startDate);
  const end = parseWindowBound(endDate);
  if (start === null && end === null) {
    return null;
  }
  return {
    start: start ?? 0,
    end: end ?? Number.MAX_SAFE_INTEGER,
  };
}

/** Parses an ISO date bound to epoch ms, or `null` when absent/unparseable. */
function parseWindowBound(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
