import {
  type BranchPageDetail,
  type BranchRow,
  normalizeRepoFullName,
} from "@repo/api/src/types/branch";
import { BranchAssociatedPullRequestCompletenessState } from "@repo/api/src/types/branch-associated-pull-request";
import {
  BranchPhaseAttributionCompleteness,
  type BranchPhaseAttributionCompletenessReason,
  type BranchPhaseAttributionResult,
  BranchPhaseAttributionCompletenessReason as PhaseCompletenessReason,
} from "@repo/api/src/types/branch-phase-attribution";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  type ActivitySpendEvent,
  attributeBranchSessionActivity,
} from "@repo/lib/branches/activity-attribution";
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
import { branchPhaseLifecycleFromAssociatedPullRequests } from "@repo/lib/branches/branch-phase-lifecycle";
import type { SharedBranchesQuery } from "../../shared/shared-branches-contract.js";
import type { BranchActivitySegmentRow } from "../database/branch-analytics-phase-evidence.js";
import type {
  BranchLifecycleEventRow,
  BranchLinkRow,
  BranchPrRow,
  BranchUsageTokenRow,
} from "../database/branch-reads.js";
import { projectDesktopBranchAssociatedPullRequests } from "./branch-associated-pull-request-projection.js";
import { canonicalLastActiveEvidenceFromRows } from "./branch-last-active-projection.js";
import { groupBranchLifecycleEventsBySession } from "./branch-lifecycle-event-grouping.js";

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
  preHydrationItems: readonly BranchRow[] = items,
  /**
   * False when the caller's rows survived a NON-authoritative default-branch
   * eligibility snapshot, so an empty cohort means "could not qualify" rather
   * than "none qualify" — see `BranchDefaultEligibilitySnapshot.authoritative`.
   */
  cohortCoverageComplete = true,
  /** False when the current repository-scoped PR response was capped or failed. */
  hydrationPullRequestCoverageComplete = true
) {
  const cohort = filterCanonicalDesktopCohort(items, request);
  const cohortByBranch = new Map(
    cohort.map((item) => [branchKey(item.repoFullName, item.branchName), item])
  );
  const preHydrationByBranch = new Map(
    preHydrationItems.map((item) => [
      branchKey(item.repoFullName, item.branchName),
      item,
    ])
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
  }));
  const lastActiveEvidence = canonicalLastActiveEvidenceFromRows(cohort);
  const locEvidence = desktopLocEvidence(cohort, request);
  const phaseByBranch = desktopPhaseAttributionByBranch(
    cohort,
    linkRows,
    cohortPrRows,
    eventRows,
    branchCountBySession,
    phaseEvidence
  );
  const persistedPullRequests = projections.flatMap(({ rows, associated }) =>
    associated.collection.items.map((pullRequest) => {
      const source = rows.find((row) => row.prNumber === pullRequest.number);
      const key = branchKey(rows[0]?.repoFullName, rows[0]?.branchName ?? "");
      const hydratedLoc = hydratedSelectedPullRequestLoc(
        cohortByBranch.get(key),
        preHydrationByBranch.get(key),
        pullRequest.number
      );
      return {
        identity: pullRequest.id,
        mergedAt: pullRequest.mergedAt,
        closedAt: pullRequest.closedAt,
        isDraft: pullRequest.isDraft === true,
        additions: source?.linesAdded ?? hydratedLoc?.additions ?? null,
        deletions: source?.linesRemoved ?? hydratedLoc?.deletions ?? null,
      };
    })
  );
  const persistedPullRequestIds = new Set(
    persistedPullRequests.map((pullRequest) => pullRequest.identity)
  );
  const hydratedSelectedPullRequests = cohort.flatMap((item) => {
    const preHydrationItem = preHydrationByBranch.get(
      branchKey(item.repoFullName, item.branchName)
    );
    return hydratedSelectedPullRequestEvidence(
      item,
      preHydrationItem,
      persistedPullRequestIds
    );
  });
  return projectCanonicalBranchListMetrics({
    cohortCoverageComplete,
    branches: cohort.map((item) => ({
      id: item.id,
      status: item.status,
      lastActivityAt: item.canonicalLastActiveAt?.value ?? null,
    })),
    pullRequests: [...persistedPullRequests, ...hydratedSelectedPullRequests],
    pullRequestCoverageComplete:
      hydrationPullRequestCoverageComplete &&
      projections.every(
        ({ associated }) =>
          associated.collection.completeness.state ===
          BranchAssociatedPullRequestCompletenessState.Complete
      ) &&
      hydratedSelectedPullRequests.length === 0,
    lastActiveEvents: lastActiveEvidence.events,
    lastActiveCoverageComplete: lastActiveEvidence.coverageComplete,
    locContributions: locEvidence.contributions,
    locCompleteBranchIds: locEvidence.completeBranchIds,
    costContributions: [...phaseByBranch].flatMap(([branchId, attribution]) =>
      attribution.segments.flatMap((segment) =>
        (segment.costEvents ?? []).map((event) => ({
          sourceEventId: event.sourceEventId,
          branchId,
          sessionId: segment.sessionId,
          occurredAt: new Date(event.occurredAtMs).toISOString(),
          phase: segment.phase,
          costUsd: event.costUsd,
          qualifyingBranchCount: segment.qualifyingBranchCount ?? null,
        }))
      )
    ),
    costCompleteBranchIds: [...phaseByBranch].flatMap(
      ([branchId, attribution]) =>
        attribution.coverage.completeness ===
          BranchPhaseAttributionCompleteness.Complete &&
        attribution.segments.every(
          (segment) =>
            segment.estimatedCostUsd === 0 ||
            (segment.costEvents?.length ?? 0) > 0
        )
          ? [branchId]
          : []
    ),
    startDate: request.startDate,
    endDate: request.endDate,
    now: requestBoundary,
  });
}

/** Use an exact selected-PR cloud LOC overlay only when local LOC was absent. */
function hydratedSelectedPullRequestLoc(
  hydratedItem: BranchRow | undefined,
  preHydrationItem: BranchRow | undefined,
  pullRequestNumber: number
): { additions: number; deletions: number } | null {
  if (
    !(hydratedItem && preHydrationItem) ||
    hydratedItem.prNumber !== pullRequestNumber ||
    preHydrationItem.additions !== null ||
    preHydrationItem.deletions !== null ||
    !validLoc(hydratedItem.additions) ||
    !validLoc(hydratedItem.deletions)
  ) {
    return null;
  }
  return {
    additions: hydratedItem.additions,
    deletions: hydratedItem.deletions,
  };
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

function validLoc(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

/** Project only exact selected merged-PR evidence returned by cloud hydration. */
function hydratedSelectedPullRequestEvidence(
  hydratedItem: BranchRow,
  preHydrationItem: BranchRow | undefined,
  persistedPullRequestIds: ReadonlySet<string>
) {
  const pullRequestNumber = hydratedItem.prNumber;
  const repository = hydratedItem.repoFullName;
  if (
    pullRequestNumber === null ||
    repository === null ||
    hydratedItem.prState !== GitHubPRState.Merged ||
    hydratedItem.mergedAt == null
  ) {
    return [];
  }
  const identity = `${normalizeRepoFullName(repository)}#${pullRequestNumber}`;
  const loc = hydratedSelectedPullRequestLoc(
    hydratedItem,
    preHydrationItem,
    pullRequestNumber
  );
  if (persistedPullRequestIds.has(identity) || loc === null) {
    return [];
  }
  return [
    {
      identity,
      mergedAt: hydratedItem.mergedAt,
      closedAt: null,
      isDraft: false,
      additions: loc.additions,
      deletions: loc.deletions,
    },
  ];
}

function filterCanonicalDesktopCohort(
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
        repo.toLocaleLowerCase().includes(query) ||
        item.prTitle?.toLocaleLowerCase().includes(query)) &&
      (request.locMin === undefined ||
        (loc !== null && loc >= request.locMin)) &&
      (request.locMax === undefined || (loc !== null && loc <= request.locMax))
    );
  });
}

function desktopLocEvidence(
  items: readonly BranchRow[],
  request: SharedBranchesQuery
) {
  if (request.startDate || request.endDate) {
    return { contributions: [], completeBranchIds: [] };
  }
  const contributions = items.flatMap((item) =>
    item.additions === null || item.deletions === null
      ? []
      : [
          {
            sourceEventId: `branch-loc:${item.id}`,
            branchId: item.id,
            occurredAt: null,
            additions: item.additions,
            deletions: item.deletions,
          },
        ]
  );
  return {
    contributions,
    completeBranchIds: contributions.map(
      (contribution) => contribution.branchId
    ),
  };
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
  const result = new Map<string, BranchPhaseAttributionResult>();
  for (const item of items) {
    const key = branchKey(item.repoFullName, item.branchName);
    const sessionIds = [
      ...new Set(
        links
          .filter(
            (link) => branchKey(link.repoFullName, link.branchName) === key
          )
          .map((link) => link.sessionId)
      ),
    ];
    const associated = projectDesktopBranchAssociatedPullRequests(
      pullRequests.filter(
        (pullRequest) =>
          branchKey(pullRequest.repoFullName, pullRequest.branchName) === key
      )
    );
    const coverageReasons = new Set(phaseEvidence.coverageReasons ?? []);
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
      phaseEvidence.lifecycleEventRows.filter(
        (row) => branchKey(row.repoFullName, row.branchName) === key
      )
    );
    result.set(
      item.id,
      projectBranchPhaseAttribution({
        sessions: sessionIds.map((sessionId) => ({
          sessionId,
          branchCount: branchCountBySession.get(sessionId) ?? 0,
          activitySegments: spansBySession.has(sessionId)
            ? attributeBranchSessionActivity(
                spansBySession.get(sessionId) ?? [],
                spendEvents.bySession.get(sessionId) ?? []
              )
            : undefined,
          lifecycleEvents: lifecycleEventsBySession.get(sessionId),
        })),
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
  const groups = new Map<string, BranchPrRow[]>();
  for (const row of rows) {
    const key = branchKey(row.repoFullName, row.branchName);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function branchKey(repoFullName: string | null, branchName: string): string {
  return `${repoFullName ?? ""}\u0000${branchName}`;
}

/** Attach detail formulas while preserving unavailable push-anchor semantics. */
export function attachDesktopCanonicalDetailMetrics(
  detail: Pick<
    BranchPageDetail,
    "associatedPullRequests" | "phaseAttribution" | "canonicalMetrics"
  >,
  pullRequestRows: readonly BranchPrRow[],
  lifecycleEvents: readonly BranchPhaseLifecycleEvent[] = []
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
  detail.canonicalMetrics = calculateBranchDetailMetrics({
    selectedPrAdditions: selectedLoc?.linesAdded ?? null,
    selectedPrDeletions: selectedLoc?.linesRemoved ?? null,
    selectedPrLocComplete:
      selectedLoc?.linesAdded !== null &&
      selectedLoc?.linesAdded !== undefined &&
      selectedLoc.linesRemoved !== null,
    phaseAttribution,
    selectedCycle: branchMetricCycleFromPullRequest(
      selected ?? null,
      selectedCycleSuccessfulPushAt(pullRequests, lifecycleEvents)
    ),
  });
}

/**
 * Assemble the `phaseEvidence` argument for {@link projectDesktopCanonicalMetrics}.
 *
 * Lives here rather than at the call site because the coverage-reason rule is
 * part of the projection contract, not of the read that gathers the rows: an
 * incomplete cohort is `CoverageCapped` whether the shortfall came from a
 * capped segment read, a capped lifecycle read, or sessions the canonical
 * admission dropped. Keeping the three in one place stops a caller from
 * reporting two of them and silently omitting the third.
 */
export function buildPhaseEvidence(
  activitySegmentEvidence: {
    rows: readonly BranchActivitySegmentRow[];
    capped: boolean;
  },
  lifecycleEvidence: {
    rows: readonly BranchLifecycleEventRow[];
    capped: boolean;
  },
  sessionAdmission: { admitted: number; canonical: number }
): {
  activitySegmentRows: readonly BranchActivitySegmentRow[];
  lifecycleEventRows: readonly BranchLifecycleEventRow[];
  coverageReasons: readonly BranchPhaseAttributionCompletenessReason[];
} {
  const capped =
    activitySegmentEvidence.capped ||
    lifecycleEvidence.capped ||
    sessionAdmission.admitted < sessionAdmission.canonical;
  return {
    activitySegmentRows: activitySegmentEvidence.rows,
    lifecycleEventRows: lifecycleEvidence.rows,
    coverageReasons: capped ? [PhaseCompletenessReason.CoverageCapped] : [],
  };
}
