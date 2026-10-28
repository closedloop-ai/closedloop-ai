import {
  type BranchRow,
  encodeBranchId,
  normalizeRepoFullName,
} from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  type BranchMetricLocContribution,
  type BranchMetricLocCoverageGap,
  BranchPublicationLocSource,
} from "@repo/lib/branches/branch-publication-loc";
import type { BranchLinkRow, BranchPrRow } from "../database/branch-reads.js";
import { deriveDesktopPrState } from "./branch-associated-pull-request-projection.js";

/** Normalize complete persisted Desktop merged-PR publication LOC. */
export function desktopPublicationLocEvidence(
  items: readonly BranchRow[],
  links: readonly BranchLinkRow[],
  pullRequests: readonly BranchPrRow[],
  includeHydratedSelectionGap = true
): {
  contributions: BranchMetricLocContribution[];
  coverageGaps: BranchMetricLocCoverageGap[];
  completeBranchIds: string[];
  coverageComplete: boolean;
} {
  const itemIds = new Set(items.map((item) => item.id));
  const persistedContributions = pullRequests.flatMap((pullRequest) => {
    const branchId = encodeBranchId(pullRequest);
    if (
      !itemIds.has(branchId) ||
      deriveDesktopPrState(pullRequest) !== GitHubPRState.Merged ||
      pullRequest.mergedAt === null ||
      pullRequest.prNumber === null ||
      pullRequest.repoFullName === null ||
      !validLoc(pullRequest.linesAdded) ||
      !validLoc(pullRequest.linesRemoved)
    ) {
      return [];
    }
    const repository = normalizeRepoFullName(pullRequest.repoFullName);
    return [
      {
        sourceEventId: `merged-pr:${repository}#${pullRequest.prNumber}`,
        changeIdentity: `${repository}#${pullRequest.prNumber}`,
        branchId,
        occurredAt: pullRequest.mergedAt,
        additions: pullRequest.linesAdded,
        deletions: pullRequest.linesRemoved,
        source: BranchPublicationLocSource.MergedPullRequest,
      },
    ];
  });
  const contributions = persistedContributions;
  const coverageGaps = publicationCoverageGaps(
    items,
    links,
    pullRequests,
    contributions,
    includeHydratedSelectionGap
  );
  const completeBranchIds = items.flatMap((item) =>
    coverageGaps.some((gap) => gap.sourceEventId.startsWith(`${item.id}:`))
      ? []
      : [item.id]
  );
  return {
    contributions,
    coverageGaps,
    completeBranchIds,
    coverageComplete: completeBranchIds.length === items.length,
  };
}

function publicationCoverageGaps(
  items: readonly BranchRow[],
  links: readonly BranchLinkRow[],
  pullRequests: readonly BranchPrRow[],
  contributions: readonly BranchMetricLocContribution[],
  includeHydratedSelectionGap: boolean
): BranchMetricLocCoverageGap[] {
  const pullRequestsByBranchId = groupPullRequestsByBranchId(pullRequests);
  const publicationLinksByBranchId = groupPublicationLinksByBranchId(links);
  return items.flatMap((item) => {
    const branchPullRequests = pullRequestsByBranchId.get(item.id) ?? [];
    const gaps = branchPullRequests.flatMap((pullRequest) => {
      if (deriveDesktopPrState(pullRequest) !== GitHubPRState.Merged) {
        return [];
      }
      const identity = `${item.id}:merged-pr:${pullRequest.prNumber ?? "unknown"}`;
      const repository = pullRequest.repoFullName
        ? normalizeRepoFullName(pullRequest.repoFullName)
        : null;
      const represented = contributions.some(
        (contribution) =>
          repository !== null &&
          pullRequest.prNumber !== null &&
          contribution.sourceEventId ===
            `merged-pr:${repository}#${pullRequest.prNumber}`
      );
      return represented
        ? []
        : [{ sourceEventId: identity, occurredAt: pullRequest.mergedAt }];
    });
    if (
      includeHydratedSelectionGap &&
      item.prState === GitHubPRState.Merged &&
      item.prNumber !== null &&
      !branchPullRequests.some(
        (pullRequest) => pullRequest.prNumber === item.prNumber
      )
    ) {
      gaps.push({
        sourceEventId: `${item.id}:hydrated-merged-pr:${item.prNumber}`,
        occurredAt: item.mergedAt ?? null,
      });
    }
    const publicationLinks = publicationLinksByBranchId.get(item.id) ?? [];
    const successfulPushAt = latestSuccessfulPushAt(publicationLinks);
    const publicationLocRepresented = contributions.some((contribution) =>
      contributionRepresentsPush(contribution, item.id, successfulPushAt)
    );
    if (publicationLinks.length > 0 && !publicationLocRepresented) {
      gaps.push({
        sourceEventId: `${item.id}:successful-push`,
        occurredAt: successfulPushAt,
      });
    }
    return gaps;
  });
}

function groupPullRequestsByBranchId(
  pullRequests: readonly BranchPrRow[]
): Map<string, BranchPrRow[]> {
  const groups = new Map<string, BranchPrRow[]>();
  for (const pullRequest of pullRequests) {
    addBranchIdRow(groups, encodeBranchId(pullRequest), pullRequest);
  }
  return groups;
}

function groupPublicationLinksByBranchId(
  links: readonly BranchLinkRow[]
): Map<string, BranchLinkRow[]> {
  const groups = new Map<string, BranchLinkRow[]>();
  for (const link of links) {
    if (link.hasLocalPublication) {
      addBranchIdRow(groups, encodeBranchId(link), link);
    }
  }
  return groups;
}

function addBranchIdRow<Row>(
  groups: Map<string, Row[]>,
  branchId: string,
  row: Row
): void {
  const group = groups.get(branchId);
  if (group) {
    group.push(row);
  } else {
    groups.set(branchId, [row]);
  }
}

function validLoc(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

function latestSuccessfulPushAt(
  links: readonly BranchLinkRow[]
): string | null {
  let latest: { value: string; timestamp: number } | null = null;
  for (const link of links) {
    const value = link.successfulPushAt;
    if (value === undefined || value === null) {
      return null;
    }
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) {
      return null;
    }
    if (latest === null || timestamp > latest.timestamp) {
      latest = { value, timestamp };
    }
  }
  return latest?.value ?? null;
}

function contributionRepresentsPush(
  contribution: BranchMetricLocContribution,
  branchId: string,
  successfulPushAt: string | null
): boolean {
  if (
    contribution.branchId !== branchId ||
    successfulPushAt === null ||
    (contribution.source !== BranchPublicationLocSource.SuccessfulPush &&
      contribution.source !== BranchPublicationLocSource.MergedPullRequest) ||
    contribution.occurredAt === null
  ) {
    return false;
  }
  const contributionAt = Date.parse(contribution.occurredAt);
  return (
    Number.isFinite(contributionAt) &&
    contributionAt >= Date.parse(successfulPushAt)
  );
}
