import {
  type BranchPageDetail,
  type BranchRow,
  normalizeRepoFullName,
} from "@repo/api/src/types/branch";
import {
  associatedPullRequestsWithholdDecisions,
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestProvenance,
  metricAssociatedPullRequestCollection,
} from "@repo/api/src/types/branch-associated-pull-request";
import { resolveAttributedBranchCost } from "@repo/api/src/types/branch-cost";
import {
  BranchPhaseAttributionCompleteness,
  type BranchPhaseAttributionCompletenessReason,
  type BranchPhaseAttributionResult,
  BranchPhaseAttributionCompletenessReason as PhaseCompletenessReason,
} from "@repo/api/src/types/branch-phase-attribution";
import {
  type ActivitySpendEvent,
  attributeBranchSessionActivity,
} from "@repo/lib/branches/activity-attribution";
import type { BranchMetricCostFacts } from "@repo/lib/branches/branch-cost-facts";
import {
  branchMetricCycleFromPullRequest,
  calculateBranchDetailMetrics,
  selectedCycleSuccessfulPushAt,
} from "@repo/lib/branches/branch-detail-outcomes";
import { projectCanonicalBranchListMetrics } from "@repo/lib/branches/branch-list-metric-projection";
import {
  type BranchPhaseLifecycleEvent,
  projectBranchPhaseAttribution,
} from "@repo/lib/branches/branch-phase-attribution";
import {
  branchMetricCostContributions,
  hasCompleteBranchMetricEventCost,
} from "@repo/lib/branches/branch-phase-cost-contributions";
import { branchPhaseLifecycleFromAssociatedPullRequests } from "@repo/lib/branches/branch-phase-lifecycle";
import type { SharedBranchesQuery } from "../../shared/shared-branches-contract.js";
import type { BranchActivitySegmentRow } from "../database/branch-analytics-phase-evidence.js";
import type {
  BranchLifecycleEventRow,
  BranchLinkRow,
  BranchPrRow,
  BranchUsageTokenRow,
} from "../database/branch-reads.js";
import {
  desktopAssociatedPullRequestCandidates,
  projectDesktopBranchAssociatedPullRequests,
} from "./branch-associated-pull-request-projection.js";
import { canonicalLastActiveEvidenceFromRows } from "./branch-last-active-projection.js";
import { groupBranchLifecycleEventsBySession } from "./branch-lifecycle-event-grouping.js";
import { desktopPublicationLocEvidence } from "./branch-publication-loc-projection.js";

/** Build the Desktop list bundle from persisted full-corpus rows. */
export function projectDesktopCanonicalMetrics(
  items: readonly BranchRow[],
  linkRows: readonly BranchLinkRow[],
  prRows: readonly BranchPrRow[],
  request: SharedBranchesQuery,
  requestBoundary: Date,
  eventRows: readonly BranchUsageTokenRow[] = [],
  branchCountBySession: ReadonlyMap<string, number> = new Map(),
  phaseEvidence: {
    activitySegmentRows: readonly BranchActivitySegmentRow[];
    lifecycleEventRows: readonly BranchLifecycleEventRow[];
    coverageReasons?: readonly BranchPhaseAttributionCompletenessReason[];
  } = { activitySegmentRows: [], lifecycleEventRows: [] },
  /**
   * False when the caller's rows survived a NON-authoritative default-branch
   * eligibility snapshot, so an empty cohort means "could not qualify" rather
   * than "none qualify" — see `BranchDefaultEligibilitySnapshot.authoritative`.
   */
  cohortCoverageComplete = true,
  /**
   * False when the eligibility snapshot could not decide the PR cohort — see
   * `BranchDefaultEligibilitySnapshot.pullRequestCoverageComplete`.
   */
  pullRequestCoverageComplete = true,
  denominatorItems: readonly BranchRow[] = items,
  denominatorLinkRows: readonly BranchLinkRow[] = linkRows,
  denominatorCoverageComplete = true,
  /**
   * ISS-9956 — the cohort's TOTAL ESTIMATED COST, passed in rather than folded
   * here.
   *
   * The caller already computed it as `totalSpendUsd`: `sumStoredBranchCost`
   * over the analytics token rows, narrowed to the analytics session set and
   * filtered to the request's event window when one is active
   * (`branch-analytics-builder.ts`). Folding `eventRows` again here would be a
   * second derivation of the same money that could drift from the figure the
   * analytics card publishes.
   *
   * `undefined` means the caller had no total to give, never zero —
   * `sumStoredBranchCost` returns `null` when NOTHING in the set carries a
   * captured cost, which must withhold the ratio rather than divide by zero.
   */
  canonicalEstimatedCostUsd?: number,
  /**
   * ISS-12361: the cohort's AI spend per window, folded in SQL. When present it
   * replaces the contribution-based spend fold and the session cap that fed it.
   */
  aiSpendFacts?: BranchMetricCostFacts
) {
  const cohort = filterCanonicalDesktopCohort(items, request);
  const cohortByBranch = new Map(
    cohort.map((item) => [branchKey(item.repoFullName, item.branchName), item])
  );
  const cohortKeys = new Set(
    cohort.map((item) => branchKey(item.repoFullName, item.branchName))
  );
  const cohortPrRows = prRows.filter((row) =>
    cohortKeys.has(branchKey(row.repoFullName, row.branchName))
  );
  const projections = groupPullRequests(cohortPrRows).map((rows) => ({
    rows,
    associated: projectDesktopBranchAssociatedPullRequests(rows),
    metricCollection: metricAssociatedPullRequestCollection(
      desktopAssociatedPullRequestCandidates(rows),
      BranchAssociatedPullRequestProvenance.PersistedDesktop
    ),
  }));
  const lastActiveEvidence = canonicalLastActiveEvidenceFromRows(cohort);
  const locEvidence = desktopPublicationLocEvidence(
    cohort,
    linkRows,
    cohortPrRows
  );
  const phaseByBranch = desktopPhaseAttributionByBranch(
    cohort,
    linkRows,
    cohortPrRows,
    eventRows,
    branchCountBySession,
    phaseEvidence
  );
  const denominatorKeys = new Set(
    denominatorItems.map((item) =>
      branchKey(item.repoFullName, item.branchName)
    )
  );
  const denominatorPrRows = prRows.filter((row) =>
    denominatorKeys.has(branchKey(row.repoFullName, row.branchName))
  );
  const denominatorPhaseByBranch = desktopPhaseAttributionByBranch(
    denominatorItems,
    denominatorLinkRows,
    denominatorPrRows,
    eventRows,
    branchCountBySession,
    phaseEvidence
  );
  const visibleCostContributions = branchMetricCostContributions(phaseByBranch);
  const denominatorCostContributions = branchMetricCostContributions(
    denominatorPhaseByBranch
  );
  const visibleCostCompleteBranchIds = completeCostBranchIds(phaseByBranch);
  const denominatorSessionIds = [
    ...new Set(denominatorLinkRows.map((link) => link.sessionId)),
  ];
  const persistedPullRequests = projections.flatMap(({ rows, associated }) =>
    associated.collection.items.map((pullRequest) => {
      const source = rows.find((row) => row.prNumber === pullRequest.number);
      return {
        identity: pullRequest.id,
        mergedAt: pullRequest.mergedAt,
        closedAt: pullRequest.closedAt,
        additions: source?.linesAdded ?? null,
        deletions: source?.linesRemoved ?? null,
      };
    })
  );
  return projectCanonicalBranchListMetrics({
    cohortCoverageComplete,
    branches: cohort.map((item) => ({
      id: item.id,
      status: item.status,
      lastActivityAt: item.canonicalLastActiveAt?.value ?? null,
    })),
    pullRequests: persistedPullRequests,
    pullRequestCoverageComplete:
      pullRequestCoverageComplete &&
      projections.every(
        ({ metricCollection }) =>
          metricCollection.completeness.state ===
          BranchAssociatedPullRequestCompletenessState.Complete
      ),
    // ISS-9959, the desktop half of the same fix. This twin ANDs three terms and
    // they do not place the same way, so each contributes its own gap rather than
    // collapsing into one cohort-wide false.
    //
    // Only a shortfall that actually hides a decided pull request is a gap: an
    // ambiguity among pull requests this twin DID read hides no merge and no
    // unmerged close, so it contributes nothing. One that does hide a decision
    // carries NO instant, because a branch's canonical activity cannot bound a
    // decision nobody observed; neither does the cohort-wide eligibility
    // shortfall, which belongs to no branch at all.
    pullRequestCoverageGaps: [
      ...(pullRequestCoverageComplete ? [] : [{ occurredAt: null }]),
      ...projections.flatMap(({ rows, metricCollection }) => {
        if (!associatedPullRequestsWithholdDecisions(metricCollection)) {
          return [];
        }
        const item = cohortByBranch.get(
          branchKey(rows[0]?.repoFullName, rows[0]?.branchName ?? "")
        );
        return [
          {
            ...(item ? { branchId: item.id } : {}),
            occurredAt: null,
          },
        ];
      }),
    ],
    lastActiveEvents: lastActiveEvidence.events,
    lastActiveCoverageComplete: lastActiveEvidence.coverageComplete,
    locContributions: locEvidence.contributions,
    locCoverageGaps: locEvidence.coverageGaps,
    locCompleteBranchIds: locEvidence.completeBranchIds,
    costContributions: visibleCostContributions,
    costCompleteBranchIds: visibleCostCompleteBranchIds,
    locCoverageComplete: locEvidence.coverageComplete,
    locPerDollarCostContributions: denominatorCostContributions,
    locPerDollarQualifyingSessionIds: denominatorSessionIds,
    locPerDollarCostCoverageComplete:
      denominatorCoverageComplete &&
      denominatorPhaseByBranch.size === denominatorItems.length &&
      [...denominatorPhaseByBranch.values()].every(
        (attribution) =>
          attribution.coverage.completeness ===
            BranchPhaseAttributionCompleteness.Complete &&
          hasCompleteBranchMetricEventCost(attribution)
      ),
    ...(canonicalEstimatedCostUsd === undefined
      ? {}
      : { canonicalEstimatedCostUsd }),
    ...(aiSpendFacts === undefined ? {} : { aiSpendFacts }),
    startDate: request.startDate,
    endDate: request.endDate,
    now: requestBoundary,
  });
}

function completeCostBranchIds(
  phaseByBranch: ReadonlyMap<string, BranchPhaseAttributionResult>
): string[] {
  return [...phaseByBranch].flatMap(([branchId, attribution]) =>
    attribution.coverage.completeness ===
      BranchPhaseAttributionCompleteness.Complete &&
    hasCompleteBranchMetricEventCost(attribution)
      ? [branchId]
      : []
  );
}

/** Narrow an exact analytics cohort without the List selector's fail-open default. */
export function selectExactBranchCohort(
  items: readonly BranchRow[],
  branchIds: readonly string[]
): BranchRow[] {
  const requestedIds = new Set(
    branchIds.filter((branchId) => branchId.length > 0)
  );
  return requestedIds.size === 0
    ? []
    : items.filter((item) => requestedIds.has(item.id));
}

/**
 * Apply the shared non-date List scope without changing metric event windows.
 *
 * The free-text arm covers branch name and repo only. The cloud's third arm
 * (`pr.title`, `apps/api/app/branches/branch-candidate-read.ts`) has no desktop
 * counterpart: ISS-12719 dropped `pull_requests.title`, so `BranchRow.prTitle`
 * is null on every desktop row.
 */
export function filterCanonicalDesktopCohort(
  items: readonly BranchRow[],
  request: SharedBranchesQuery
): BranchRow[] {
  const query = request.search?.trim().toLocaleLowerCase();
  return items.filter((item) => {
    const repo = item.repoFullName ?? "";
    const shortRepo = repo.split("/").at(-1) ?? repo;
    const loc =
      item.additions === null && item.deletions === null
        ? null
        : (item.additions ?? 0) + (item.deletions ?? 0);
    return (
      (!request.repo || request.repo === repo || request.repo === shortRepo) &&
      (!request.owner || request.owner === item.owner) &&
      (!request.status || request.status === item.status) &&
      (!query ||
        item.branchName.toLocaleLowerCase().includes(query) ||
        repo.toLocaleLowerCase().includes(query)) &&
      (request.locMin === undefined ||
        (loc !== null && loc >= request.locMin)) &&
      (request.locMax === undefined || (loc !== null && loc <= request.locMax))
    );
  });
}

function desktopPhaseAttributionByBranch(
  items: readonly BranchRow[],
  links: readonly BranchLinkRow[],
  pullRequests: readonly BranchPrRow[],
  eventRows: readonly BranchUsageTokenRow[],
  branchCountBySession: ReadonlyMap<string, number>,
  phaseEvidence: {
    activitySegmentRows: readonly BranchActivitySegmentRow[];
    lifecycleEventRows: readonly BranchLifecycleEventRow[];
    coverageReasons?: readonly BranchPhaseAttributionCompletenessReason[];
  }
): Map<string, BranchPhaseAttributionResult> {
  const spendEvents = groupSpendEvents(eventRows);
  const spansBySession = groupActivitySpans(phaseEvidence.activitySegmentRows);
  const linksByBranch = groupRowsByBranchKey(links);
  const pullRequestsByBranch = groupRowsByBranchKey(pullRequests);
  const lifecycleEventsByBranch = groupRowsByBranchKey(
    phaseEvidence.lifecycleEventRows
  );
  const result = new Map<string, BranchPhaseAttributionResult>();
  for (const item of items) {
    const key = branchKey(item.repoFullName, item.branchName);
    const branchLinks = linksByBranch.get(key) ?? [];
    const sessionIds = [...new Set(branchLinks.map((link) => link.sessionId))];
    const associated = projectDesktopBranchAssociatedPullRequests(
      pullRequestsByBranch.get(key) ?? []
    );
    const coverageReasons = new Set(phaseEvidence.coverageReasons ?? []);
    if (sessionIds.some((sessionId) => !branchCountBySession.has(sessionId))) {
      coverageReasons.add(PhaseCompletenessReason.CoverageCapped);
    }
    if (
      sessionIds.some((sessionId) =>
        spendEvents.malformedSessionIds.has(sessionId)
      )
    ) {
      coverageReasons.add(PhaseCompletenessReason.MalformedEvidence);
    }
    if (sessionIds.some((sessionId) => !spansBySession.has(sessionId))) {
      coverageReasons.add(PhaseCompletenessReason.MissingActivitySegments);
    }
    const lifecycleEventsBySession = groupBranchLifecycleEventsBySession(
      lifecycleEventsByBranch.get(key) ?? []
    );
    result.set(
      item.id,
      projectBranchPhaseAttribution({
        sessions: sessionIds.map((sessionId) => {
          const branchCount = branchCountBySession.get(sessionId);
          return {
            sessionId,
            ...(branchCount === undefined ? {} : { branchCount }),
            activitySegments: spansBySession.has(sessionId)
              ? attributeBranchSessionActivity(
                  spansBySession.get(sessionId) ?? [],
                  spendEvents.bySession.get(sessionId) ?? []
                )
              : undefined,
            lifecycleEvents: lifecycleEventsBySession.get(sessionId),
          };
        }),
        ...branchPhaseLifecycleFromAssociatedPullRequests(
          associated.collection
        ),
        coverageReasons: [...coverageReasons],
      })
    );
  }
  return result;
}

function desktopCostSourceEventId(row: BranchUsageTokenRow): string {
  if (row.eventFingerprint) {
    return `event:${row.eventFingerprint}`;
  }
  if (row.eventRowId) {
    return `event-row:${row.eventRowId}`;
  }
  return `aggregate:${row.sessionId}:${row.model}`;
}

function groupSpendEvents(rows: readonly BranchUsageTokenRow[]): {
  bySession: Map<string, ActivitySpendEvent[]>;
  malformedSessionIds: Set<string>;
} {
  const bySession = new Map<string, ActivitySpendEvent[]>();
  const malformedSessionIds = new Set<string>();
  for (const row of rows) {
    const occurredAtMs = row.createdAt ? Date.parse(row.createdAt) : Number.NaN;
    if (!Number.isFinite(occurredAtMs)) {
      malformedSessionIds.add(row.sessionId);
      continue;
    }
    const events = bySession.get(row.sessionId) ?? [];
    events.push({
      sourceId: desktopCostSourceEventId(row),
      tMs: occurredAtMs,
      costUsd: row.costUsdEstimated,
      positiveCostSignal: row.positiveCostSignal,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
    });
    bySession.set(row.sessionId, events);
  }
  return { bySession, malformedSessionIds };
}

function groupActivitySpans(
  rows: readonly BranchActivitySegmentRow[]
): Map<string, BranchActivitySegmentRow[]> {
  const bySession = new Map<string, BranchActivitySegmentRow[]>();
  for (const row of rows) {
    const spans = bySession.get(row.sessionId) ?? [];
    spans.push(row);
    bySession.set(row.sessionId, spans);
  }
  return bySession;
}

function groupPullRequests(rows: readonly BranchPrRow[]): BranchPrRow[][] {
  return [...groupRowsByBranchKey(rows).values()];
}

function groupRowsByBranchKey<
  Row extends { repoFullName: string | null; branchName: string },
>(rows: readonly Row[]): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = branchKey(row.repoFullName, row.branchName);
    const group = groups.get(key);
    if (group) {
      group.push(row);
    } else {
      groups.set(key, [row]);
    }
  }
  return groups;
}

function branchKey(repoFullName: string | null, branchName: string): string {
  return `${repoFullName ?? ""}\u0000${branchName}`;
}

/** Attach detail formulas while preserving unavailable push-anchor semantics. */
export function attachDesktopCanonicalDetailMetrics(
  detail: Pick<
    BranchPageDetail,
    | "associatedPullRequests"
    | "phaseAttribution"
    | "canonicalMetrics"
    | "estimatedCostUsd"
    | "attributedCostUsd"
  >,
  pullRequestRows: readonly BranchPrRow[],
  lifecycleEvents: readonly BranchPhaseLifecycleEvent[] = [],
  branchRow?: BranchRow,
  linkRows: readonly BranchLinkRow[] = []
): void {
  const pullRequests = detail.associatedPullRequests;
  const phaseAttribution = detail.phaseAttribution;
  if (!(pullRequests && phaseAttribution)) {
    return;
  }
  const selected = pullRequests.items.find(
    (pullRequest) => pullRequest.id === pullRequests.selectedId
  );
  const selectedLoc = pullRequestRows.find((row) => {
    if (!(row.repoFullName && row.prNumber)) {
      return false;
    }
    return (
      `${normalizeRepoFullName(row.repoFullName)}#${row.prNumber}` ===
      selected?.id
    );
  });
  const lifetimeLocEvidence = branchRow
    ? desktopPublicationLocEvidence(
        [branchRow],
        linkRows,
        pullRequestRows,
        false
      )
    : undefined;
  detail.canonicalMetrics = calculateBranchDetailMetrics({
    // ISS-6949: read off the same object the metrics are written onto, so a
    // caller cannot pair one branch's metrics with another's cost.
    attributedCostUsd: resolveAttributedBranchCost(detail),
    selectedPrAdditions: selectedLoc?.linesAdded ?? null,
    selectedPrDeletions: selectedLoc?.linesRemoved ?? null,
    selectedPrLocComplete:
      selectedLoc?.linesAdded !== null &&
      selectedLoc?.linesAdded !== undefined &&
      selectedLoc.linesRemoved !== null,
    ...(lifetimeLocEvidence
      ? {
          lifetimeLocContributions: lifetimeLocEvidence.contributions,
          lifetimeLocCoverageComplete: lifetimeLocEvidence.coverageComplete,
          qualifyingSessionCount: new Set(
            linkRows.map((link) => link.sessionId)
          ).size,
        }
      : {}),
    phaseAttribution,
    selectedCycle: branchMetricCycleFromPullRequest(
      selected ?? null,
      selectedCycleSuccessfulPushAt(pullRequests, lifecycleEvents)
    ),
  });
}
