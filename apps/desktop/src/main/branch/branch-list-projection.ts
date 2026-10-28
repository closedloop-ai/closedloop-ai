import {
  CollaboratorArtifactType,
  unavailableArtifactCollaborators,
} from "@repo/api/src/types/artifact-collaborators";
import { type BranchRow, encodeBranchId } from "@repo/api/src/types/branch";
import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { normalizeRepoFullName } from "@repo/api/src/types/branch-repository";
import type { Priority } from "@repo/api/src/types/common";
import {
  compareListQueryText,
  ListQueryTextOrdering,
} from "@repo/api/src/types/list-query-ordering-semantics";
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
      collaborators: unavailableArtifactCollaborators(
        CollaboratorArtifactType.Branch
      ),
      status: statusForSelectedDesktopPullRequest(selectedPullRequest),
      priority: branch.priority,
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
  /**
   * ISS-10332: the first non-null priority among the branch's artifact rows.
   * The local write sets every `kind = 'branch'` row of one identity together,
   * so they disagree only when a row appeared after the write (a new worktree
   * of the same branch), which holds none and must not mask the value.
   */
  priority: Priority | null;
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
        priority: link.priority,
      });
      continue;
    }
    existing.sessionIds.add(link.sessionId);
    existing.priority ??= link.priority;
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
  return compareBranchIdentityKeys(left, right);
}

/**
 * The repo / branch / id tie-break, ranked the way the two Branch list
 * compilers rank the same three keys (ISS-9585) — `und-x-icu` in the SQL
 * mirror, `compareListQueryText(…, Collated)` in the `@repo/lib/branches`
 * kernel. A bare `localeCompare()` here would order this desktop projection by
 * the machine's own locale, so the same corpus could page differently than the
 * kernel ordered it in the very same process.
 */
function compareBranchIdentityKeys(left: BranchRow, right: BranchRow): number {
  return (
    compareListQueryText(
      normalizeRepoFullName(left.repoFullName ?? ""),
      normalizeRepoFullName(right.repoFullName ?? ""),
      ListQueryTextOrdering.Collated
    ) ||
    compareListQueryText(
      left.branchName,
      right.branchName,
      ListQueryTextOrdering.Collated
    ) ||
    compareListQueryText(left.id, right.id, ListQueryTextOrdering.Collated)
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
