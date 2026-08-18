import { type BranchRow, encodeBranchId } from "@repo/api/src/types/branch";
import {
  BranchCollaboratorSource,
  BranchIdentityAvailability,
} from "@repo/api/src/types/branch-identity";
import { normalizeRepoFullName } from "@repo/api/src/types/branch-repository";
import type { BranchLinkRow, BranchPrRow } from "../database/branch-reads.js";
import type { BranchTokenAggregateRow } from "../database/branch-token-aggregate-reads.js";
import {
  hasMultipleValidPullRequestNumbers,
  projectDesktopBranchAssociatedPullRequests,
  selectedDesktopPullRequestFields,
  statusForSelectedDesktopPullRequest,
} from "./branch-associated-pull-request-projection.js";
import type { DesktopBranchLastActiveProjection } from "./branch-last-active-projection.js";
import { projectDesktopBranchListCosts } from "./branch-list-cost-projection.js";

/** Project and order the complete eligible Desktop Branch corpus before paging. */
export function projectBranchListItems(
  linkRows: readonly BranchLinkRow[],
  prRows: readonly BranchPrRow[],
  tokenRows: readonly BranchTokenAggregateRow[],
  lastActiveByBranch: DesktopBranchLastActiveProjection
): BranchRow[] {
  const branches = groupBranchAccumulators(linkRows);
  const prsByBranch = groupPullRequestsByBranch(prRows);
  const costsByBranch = projectDesktopBranchListCosts(tokenRows);
  const rows = [...branches].map(([id, branch]) => {
    const prs = prsByBranch.get(id) ?? [];
    const associatedPullRequests =
      projectDesktopBranchAssociatedPullRequests(prs);
    const selectedPullRequest = associatedPullRequests.selected;
    const { additions, deletions, filesChanged } = resolveBranchLoc(
      branch,
      prs
    );
    const canonicalLastActiveAt = lastActiveByBranch.get(id);
    return {
      id,
      branchName: branch.branchName,
      baseBranch: null,
      repoFullName: branch.repoFullName,
      owner: null,
      ownerIdentity: {
        availability: BranchIdentityAvailability.Unavailable,
        person: null,
      },
      collaborators: {
        availability: BranchIdentityAvailability.Unavailable,
        people: [],
        sources: {
          [BranchCollaboratorSource.PullRequestComments]:
            BranchIdentityAvailability.Unavailable,
          [BranchCollaboratorSource.BranchComments]:
            BranchIdentityAvailability.Unavailable,
          [BranchCollaboratorSource.SessionComments]:
            BranchIdentityAvailability.Unavailable,
        },
      },
      status: statusForSelectedDesktopPullRequest(selectedPullRequest),
      ...selectedDesktopPullRequestFields(selectedPullRequest),
      mergedAt: null,
      multiPrWarning: hasMultipleValidPullRequestNumbers(prs),
      checksStatus: null,
      checksPassed: null,
      checksTotal: null,
      ahead: null,
      behind: null,
      additions,
      deletions,
      filesChanged,
      ...(costsByBranch.get(id) ?? {
        estimatedCostUsd: null,
        attributedCostUsd: null,
      }),
      lastActivityAt: canonicalLastActiveAt?.value ?? "",
      canonicalLastActiveAt,
      sessionIds: [...branch.sessionIds].sort(),
    } satisfies BranchRow;
  });
  rows.sort(compareCanonicalLastActive);
  return rows;
}

/** Stable encoded identities for the complete eligible link population. */
export function branchIdsForLinks(
  linkRows: readonly BranchLinkRow[]
): string[] {
  return [...new Set(linkRows.map((link) => encodeBranchId(link)))].sort();
}

type BranchAccumulator = {
  repoFullName: string | null;
  branchName: string;
  sessionIds: Set<string>;
  linesAdded: number | null;
  linesRemoved: number | null;
  filesChanged: number | null;
};

function groupBranchAccumulators(
  linkRows: readonly BranchLinkRow[]
): Map<string, BranchAccumulator> {
  const branches = new Map<string, BranchAccumulator>();
  for (const link of linkRows) {
    const id = encodeBranchId(link);
    const linkLoc = completeArtifactLoc(link);
    const existing = branches.get(id);
    if (!existing) {
      branches.set(id, {
        repoFullName: link.repoFullName,
        branchName: link.branchName,
        sessionIds: new Set([link.sessionId]),
        linesAdded: linkLoc?.linesAdded ?? null,
        linesRemoved: linkLoc?.linesRemoved ?? null,
        filesChanged: linkLoc?.filesChanged ?? null,
      });
      continue;
    }
    existing.sessionIds.add(link.sessionId);
    if (!completeArtifactLoc(existing) && linkLoc) {
      existing.linesAdded = linkLoc.linesAdded;
      existing.linesRemoved = linkLoc.linesRemoved;
      existing.filesChanged = linkLoc.filesChanged;
    }
  }
  return branches;
}

function groupPullRequestsByBranch(
  prRows: readonly BranchPrRow[]
): Map<string, BranchPrRow[]> {
  const prsByBranch = new Map<string, BranchPrRow[]>();
  for (const pullRequest of prRows) {
    const id = encodeBranchId(pullRequest);
    const branchPullRequests = prsByBranch.get(id) ?? [];
    branchPullRequests.push(pullRequest);
    prsByBranch.set(id, branchPullRequests);
  }
  return prsByBranch;
}

function resolveBranchLoc(
  branch: BranchAccumulator,
  pullRequests: readonly BranchPrRow[]
): {
  additions: number | null;
  deletions: number | null;
  filesChanged: number | null;
} {
  const branchLoc = completeArtifactLoc(branch);
  const prLoc =
    pullRequests
      .map((pullRequest) => completeArtifactLoc(pullRequest))
      .find((loc) => loc !== null) ?? null;
  const loc = branchLoc ?? prLoc;
  return {
    additions: loc?.linesAdded ?? null,
    deletions: loc?.linesRemoved ?? null,
    filesChanged: loc?.filesChanged ?? null,
  };
}

export function completeArtifactLoc(candidate: {
  linesAdded: number | null;
  linesRemoved: number | null;
  filesChanged: number | null;
}): { linesAdded: number; linesRemoved: number; filesChanged: number } | null {
  if (
    candidate.linesAdded === null ||
    candidate.linesRemoved === null ||
    candidate.filesChanged === null
  ) {
    return null;
  }
  return {
    linesAdded: candidate.linesAdded,
    linesRemoved: candidate.linesRemoved,
    filesChanged: candidate.filesChanged,
  };
}

function compareCanonicalLastActive(left: BranchRow, right: BranchRow): number {
  const leftOccurredAt = parseCanonicalLastActive(left);
  const rightOccurredAt = parseCanonicalLastActive(right);
  if (leftOccurredAt === null && rightOccurredAt !== null) {
    return 1;
  }
  if (leftOccurredAt !== null && rightOccurredAt === null) {
    return -1;
  }
  if (
    leftOccurredAt !== null &&
    rightOccurredAt !== null &&
    leftOccurredAt !== rightOccurredAt
  ) {
    return rightOccurredAt - leftOccurredAt;
  }
  return (
    normalizeRepoFullName(left.repoFullName ?? "").localeCompare(
      normalizeRepoFullName(right.repoFullName ?? "")
    ) ||
    left.branchName.localeCompare(right.branchName) ||
    left.id.localeCompare(right.id)
  );
}

function parseCanonicalLastActive(row: BranchRow): number | null {
  const value = row.canonicalLastActiveAt?.value;
  if (!value) {
    return null;
  }
  const occurredAt = Date.parse(value);
  return Number.isFinite(occurredAt) ? occurredAt : null;
}
