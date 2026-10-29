import {
  BranchLinkedArtifactCollectionProvenance,
  BranchLinkedArtifactCollectionState,
  BranchLinkedArtifactEvidenceKind,
  type BranchPageDetail,
  type BranchRow,
} from "@repo/api/src/types/branch";
import {
  BranchAssociatedPullRequestProvenance,
  type BranchAssociatedPullRequestSelection,
  BranchAssociatedPullRequestSelectionReason,
  type BranchSelectedPullRequestIdentity,
  selectBranchAssociatedPullRequests,
} from "@repo/api/src/types/branch-associated-pull-request";
import { normalizeRepoFullName } from "@repo/api/src/types/branch-repository";
import {
  BranchSelectedPullRequestChecksAvailability,
  BranchSelectedPullRequestChecksUnavailableSource,
} from "@repo/api/src/types/branch-selected-pull-request-checks";
import { SelectedPullRequestEvidenceUnavailableReason } from "@repo/api/src/types/selected-pull-request-evidence";
import { PR_INT_MAX } from "@repo/api/src/types/session-artifact-link";
import { deriveLinkedArtifactsFromBranchName } from "@repo/lib/branches/linked-artifacts";
import type { SharedBranchesDetailRequest } from "../../shared/shared-branches-contract.js";
import type { BranchPrRow } from "../database/branch-reads.js";
import {
  type DesktopAssociatedPullRequestCandidate,
  desktopAssociatedPullRequestCandidates,
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
};

type CompleteArtifactLoc = {
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
};

/** Select the requested or default pull request from the Branch's local rows. */
export function selectDesktopDetailPullRequest(
  rows: readonly BranchPrRow[],
  options: Omit<SharedBranchesDetailRequest, "id">
): DesktopDetailPullRequestSelection | null {
  const requested = selectedPullRequestIdentityFromOptions(options);
  const localCandidates = desktopAssociatedPullRequestCandidates(rows);
  const localSelection = selectCandidateSet(
    localCandidates,
    BranchAssociatedPullRequestProvenance.PersistedDesktop,
    requested
  );
  if (localSelection?.selected) {
    return detailPullRequestSelection(localSelection);
  }
  if (requested) {
    return null;
  }
  return detailPullRequestSelection(
    localCandidates.length > 0
      ? selectCandidateSet(
          localCandidates,
          BranchAssociatedPullRequestProvenance.PersistedDesktop,
          undefined
        )!
      : selectBranchAssociatedPullRequests(
          [],
          BranchAssociatedPullRequestProvenance.PersistedDesktop
        )
  );
}

function detailPullRequestSelection(
  associatedPullRequests: BranchAssociatedPullRequestSelection<DesktopAssociatedPullRequestCandidate>
): DesktopDetailPullRequestSelection {
  const selected = associatedPullRequests.selected;
  const selectedLoc = completeArtifactLoc(selected);
  return {
    associatedPullRequests,
    selectedRowFields: {
      status: statusForSelectedDesktopPullRequest(selected),
      ...selectedDesktopPullRequestFields(selected),
      additions: selectedLoc?.linesAdded ?? null,
      deletions: selectedLoc?.linesRemoved ?? null,
      filesChanged: selectedLoc?.filesChanged ?? null,
    },
  };
}

function selectCandidateSet(
  candidates: readonly DesktopAssociatedPullRequestCandidate[],
  provenance: BranchAssociatedPullRequestProvenance,
  requested: BranchSelectedPullRequestIdentity | undefined
): BranchAssociatedPullRequestSelection<DesktopAssociatedPullRequestCandidate> | null {
  const selection = selectBranchAssociatedPullRequests(candidates, provenance);
  if (!requested) {
    return selection;
  }
  const selectedId = `${normalizeRepoFullName(requested.repositoryFullName)}#${requested.pullRequestNumber}`;
  if (!selection.collection.items.some((item) => item.id === selectedId)) {
    return null;
  }
  const explicit = selectBranchAssociatedPullRequests(
    candidates.filter(
      (candidate) =>
        normalizeRepoFullName(candidate.repositoryFullName ?? "") ===
          normalizeRepoFullName(requested.repositoryFullName) &&
        candidate.number === requested.pullRequestNumber
    ),
    provenance
  ).selected;
  if (!explicit) {
    return null;
  }
  return {
    collection: {
      ...selection.collection,
      selectedId,
      selectionReason: BranchAssociatedPullRequestSelectionReason.Explicit,
    },
    selected: explicit,
  };
}

/** Return one all-or-nothing selected-PR LOC triple; partial or bad data is absent. */
function completeArtifactLoc(
  candidate: {
    linesAdded: number | null;
    linesRemoved: number | null;
    filesChanged: number | null;
  } | null
): CompleteArtifactLoc | null {
  if (
    candidate &&
    isBoundedCount(candidate.linesAdded) &&
    isBoundedCount(candidate.linesRemoved) &&
    isBoundedCount(candidate.filesChanged)
  ) {
    return {
      linesAdded: candidate.linesAdded,
      linesRemoved: candidate.linesRemoved,
      filesChanged: candidate.filesChanged,
    };
  }
  return null;
}

function isBoundedCount(value: number | null): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= PR_INT_MAX
  );
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
      // ISS-8241: `BranchPrRow` carries neither, so the local lane has nothing
      // measured to report.
      baseRefName: null,
      authorLogin: null,
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
