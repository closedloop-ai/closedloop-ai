import {
  BranchLinkedArtifactCollectionProvenance,
  BranchLinkedArtifactCollectionState,
  BranchLinkedArtifactEvidenceKind,
  type BranchPageDetail,
  type BranchRow,
} from "@repo/api/src/types/branch";
import type {
  BranchAssociatedPullRequestSelection,
  BranchSelectedPullRequestIdentity,
} from "@repo/api/src/types/branch-associated-pull-request";
import {
  BranchSelectedPullRequestChecksAvailability,
  BranchSelectedPullRequestChecksUnavailableSource,
} from "@repo/api/src/types/branch-selected-pull-request-checks";
import { SelectedPullRequestEvidenceUnavailableReason } from "@repo/api/src/types/selected-pull-request-evidence";
import { deriveLinkedArtifactsFromBranchName } from "@repo/lib/branches/linked-artifacts";
import type { SharedBranchesDetailRequest } from "../../shared/shared-branches-contract.js";
import type { BranchPrRow } from "../database/branch-reads.js";
import {
  type DesktopAssociatedPullRequestCandidate,
  projectDesktopBranchAssociatedPullRequests,
  resolveDesktopBranchAssociatedPullRequest,
  selectedDesktopPullRequestFields,
  statusForSelectedDesktopPullRequest,
} from "./branch-associated-pull-request-projection.js";

export type DesktopDetailPullRequestSelection = {
  associatedPullRequests: BranchAssociatedPullRequestSelection<DesktopAssociatedPullRequestCandidate>;
  selectedRowFields: Pick<
    BranchRow,
    | "status"
    | "prNumber"
    | "prState"
    | "prTitle"
    | "prUrl"
    | "reviewDecision"
    | "additions"
    | "deletions"
    | "filesChanged"
  >;
  requested: BranchSelectedPullRequestIdentity | undefined;
};

type CompleteArtifactLoc = {
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
};

/** Resolve a Desktop detail request against persisted local associated PRs. */
export function selectDesktopDetailPullRequest(
  rows: readonly BranchPrRow[],
  options: Omit<SharedBranchesDetailRequest, "id">,
  branchArtifactLoc: CompleteArtifactLoc | null
): DesktopDetailPullRequestSelection | null {
  const requested = selectedPullRequestIdentityFromOptions(options);
  const associatedPullRequests = resolveDesktopBranchAssociatedPullRequest(
    rows,
    projectDesktopBranchAssociatedPullRequests(rows),
    requested
  );
  if (!associatedPullRequests) {
    return null;
  }
  const selected = associatedPullRequests.selected;
  const selectedLoc = branchArtifactLoc ?? completeArtifactLoc(selected);
  return {
    associatedPullRequests,
    selectedRowFields: {
      status: statusForSelectedDesktopPullRequest(selected),
      ...selectedDesktopPullRequestFields(selected),
      additions: selectedLoc?.linesAdded ?? null,
      deletions: selectedLoc?.linesRemoved ?? null,
      filesChanged: selectedLoc?.filesChanged ?? null,
    },
    requested,
  };
}

function completeArtifactLoc(
  candidate: {
    linesAdded: number | null;
    linesRemoved: number | null;
    filesChanged: number | null;
  } | null
): CompleteArtifactLoc | null {
  if (
    candidate?.linesAdded == null ||
    candidate.linesRemoved == null ||
    candidate.filesChanged == null
  ) {
    return null;
  }
  return {
    linesAdded: candidate.linesAdded,
    linesRemoved: candidate.linesRemoved,
    filesChanged: candidate.filesChanged,
  };
}

/** Project the selected local PR and its explicit immutable-evidence gap. */
export function selectedPullRequestDetailFields(
  selection: BranchAssociatedPullRequestSelection<DesktopAssociatedPullRequestCandidate>
): Pick<BranchPageDetail, "selectedPullRequest" | "selectedPullRequestChecks"> {
  const selected = selection.selected;
  const item = selection.collection.items.find(
    (pullRequest) => pullRequest.id === selection.collection.selectedId
  );
  if (!item) {
    return { selectedPullRequest: null, selectedPullRequestChecks: undefined };
  }
  return {
    selectedPullRequest: {
      ...item,
      body: null,
      headRefOid: null,
      mergeCommitSha: null,
      changedFiles: selected?.filesChanged ?? null,
      additions: selected?.linesAdded ?? null,
      deletions: selected?.linesRemoved ?? null,
    },
    selectedPullRequestChecks: {
      status: BranchSelectedPullRequestChecksAvailability.Unavailable,
      source: BranchSelectedPullRequestChecksUnavailableSource.Evidence,
      reason:
        SelectedPullRequestEvidenceUnavailableReason.MissingImmutableRevision,
    },
  };
}

/** Local Desktop has branch-name evidence only; cloud PRODUCES links are absent. */
export function localDeliveredArtifactFields(
  branchName: string
): Pick<BranchPageDetail, "linkedArtifacts" | "linkedArtifactsCollection"> {
  return {
    linkedArtifacts: deriveLinkedArtifactsFromBranchName(branchName).map(
      (artifact) => ({
        ...artifact,
        evidence: { kind: BranchLinkedArtifactEvidenceKind.BranchNameSlug },
      })
    ),
    linkedArtifactsCollection: {
      state: BranchLinkedArtifactCollectionState.Incomplete,
      provenance: BranchLinkedArtifactCollectionProvenance.BranchNameOnly,
    },
  };
}

function selectedPullRequestIdentityFromOptions(
  options: Omit<SharedBranchesDetailRequest, "id">
): BranchSelectedPullRequestIdentity | undefined {
  return options.repositoryFullName === undefined ||
    options.pullRequestNumber === undefined
    ? undefined
    : {
        repositoryFullName: options.repositoryFullName,
        pullRequestNumber: options.pullRequestNumber,
      };
}
