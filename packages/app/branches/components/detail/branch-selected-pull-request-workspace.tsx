"use client";

import type {
  BranchPageDetail,
  BranchPrCommentsResponse,
} from "@repo/api/src/types/branch";
import type { BranchSelectedPullRequestIdentity } from "@repo/api/src/types/branch-associated-pull-request";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { useEffect } from "react";
import { useBranchSelectedPullRequestDetail } from "../../hooks/use-branch-selected-pull-request-detail";
import { useBranchSelectedPullRequestFiles } from "../../hooks/use-branch-selected-pull-request-files";
import type { BranchesQueryIdentity } from "../../hooks/use-branches";
import { useBranchComments } from "../../hooks/use-branches";
import { BranchCostToMerge } from "../branch-cost-to-merge";
import { BranchHeadlineCards } from "../branch-headline-cards";
import { BranchLeadTimeWaterfall } from "../branch-lead-time-waterfall";
import { BranchPullRequestSelector } from "../branch-pull-request-selector";
import { BranchCommentsSignalRefresh } from "./branch-comments-signal-refresh";
import { BranchDeliveredPanel } from "./branch-delivered-panel";
import { BranchFilesChangedPanel } from "./branch-files-changed-panel";
import { BranchPrStatusPanel } from "./branch-pr-status-panel";

export type BranchSelectedPullRequestWorkspaceProps = {
  branchId: string;
  detail: BranchPageDetail;
  getArtifactHref?: (slug: string) => string | null;
  onSelectionChange?: (
    selection: BranchSelectedPullRequestIdentity | null
  ) => void;
  onCommentsContextChange?: (context: {
    comments?: BranchPrCommentsResponse;
    error: boolean;
    loading: boolean;
    pullRequestKey: string | null;
  }) => void;
  queryIdentity?: BranchesQueryIdentity;
  selection?: BranchSelectedPullRequestIdentity | null;
};

/** One selected-PR SSOT for cards, evidence panels, files, and comments. */
export function BranchSelectedPullRequestWorkspace({
  branchId,
  detail,
  getArtifactHref,
  onSelectionChange = () => undefined,
  onCommentsContextChange,
  queryIdentity,
  selection = null,
}: BranchSelectedPullRequestWorkspaceProps) {
  const selectedDetailQuery = useBranchSelectedPullRequestDetail(
    branchId,
    detail,
    selection,
    queryIdentity
  );
  const selectedDetail = selection ? selectedDetailQuery.data : detail;
  const isSwitching = selection !== null && selectedDetailQuery.isPending;
  const selectionMatches = matchesSelection(selectedDetail, selection);
  const selectionError =
    selection !== null &&
    (selectedDetailQuery.isError ||
      (selectedDetailQuery.isSuccess && !selectionMatches));
  const commentsEnabled = !selection || selectionMatches;
  const commentsQuery = useBranchComments(
    branchId,
    { enabled: commentsEnabled },
    queryIdentity,
    selection ?? undefined
  );
  const selectedId = selection
    ? selectionId(selection)
    : (detail.selectedPullRequest?.id ??
      detail.associatedPullRequests?.selectedId ??
      null);
  const selectedPullRequest = selectedDetail?.selectedPullRequest;
  const filesQuery = useBranchSelectedPullRequestFiles(
    {
      branchId,
      repositoryFullName: selectedPullRequest?.repositoryFullName ?? "",
      pullRequestNumber: selectedPullRequest?.number ?? 0,
    },
    { enabled: Boolean(selectedPullRequest && selectionMatches) },
    queryIdentity
  );
  const selectedPullRequestKey = resolveSelectedPullRequestKey(
    selection,
    selectedPullRequest
  );
  useEffect(() => {
    onCommentsContextChange?.({
      comments: commentsQuery.data,
      error: selectionError || commentsQuery.isError,
      loading: isSwitching || commentsQuery.isLoading,
      pullRequestKey: selectedPullRequestKey,
    });
  }, [
    commentsQuery.data,
    commentsQuery.isError,
    commentsQuery.isLoading,
    isSwitching,
    onCommentsContextChange,
    selectionError,
    selectedPullRequestKey,
  ]);

  return (
    <>
      <BranchCommentsSignalRefresh
        branchId={branchId}
        dataLoadedAt={() => commentsQuery.dataUpdatedAt || undefined}
        onCommentsChanged={() =>
          commentsEnabled ? commentsQuery.refetch() : Promise.resolve()
        }
      />
      <BranchPullRequestSelector
        collection={detail.associatedPullRequests}
        disabled={selectedDetailQuery.isFetching}
        onChange={onSelectionChange}
        selectedId={selectedId}
      />
      {isSwitching ? (
        <div
          aria-label="Loading selected pull request"
          className="mt-6 space-y-3"
          role="status"
        >
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : null}
      {selectionError ? (
        <>
          <SelectedPullRequestUnavailable />
          <BranchCostToMerge detail={detail} />
        </>
      ) : null}
      {selectedDetail && !selectionError && !isSwitching ? (
        <section aria-label={selectedPanelLabel(selectedDetail)}>
          <BranchHeadlineCards detail={selectedDetail} />
          <BranchCostToMerge detail={selectedDetail} />
          <BranchLeadTimeWaterfall detail={selectedDetail} />
          <BranchDeliveredPanel
            detail={selectedDetail}
            getArtifactHref={getArtifactHref}
          />
          <BranchPrStatusPanel detail={selectedDetail} />
          <BranchFilesChangedPanel
            branchId={branchId}
            detail={selectedDetail}
            filesError={filesQuery.isError}
            filesLoading={filesQuery.isLoading}
            filesResponse={filesQuery.data}
            onRetry={() => filesQuery.refetch()}
            queryIdentity={queryIdentity}
          />
        </section>
      ) : null}
    </>
  );
}

function matchesSelection(
  detail: BranchPageDetail | undefined,
  selection: BranchSelectedPullRequestIdentity | null
): boolean {
  if (!selection) {
    return true;
  }
  const selected = detail?.selectedPullRequest;
  return (
    selected !== undefined &&
    selected !== null &&
    selected.repositoryFullName === selection.repositoryFullName &&
    selected.number === selection.pullRequestNumber
  );
}

function selectionId(selection: BranchSelectedPullRequestIdentity): string {
  return `${selection.repositoryFullName}#${selection.pullRequestNumber}`;
}

function resolveSelectedPullRequestKey(
  selection: BranchSelectedPullRequestIdentity | null,
  selectedPullRequest: BranchPageDetail["selectedPullRequest"]
): string | null {
  if (selection) {
    return selectionId(selection);
  }
  if (selectedPullRequest) {
    return `${selectedPullRequest.repositoryFullName}#${selectedPullRequest.number}`;
  }
  return null;
}

function selectedPanelLabel(detail: BranchPageDetail): string {
  const number = detail.selectedPullRequest?.number ?? detail.prNumber;
  return number == null
    ? "Branch evidence"
    : `Branch and pull request #${number} evidence`;
}

function SelectedPullRequestUnavailable() {
  return (
    <Alert className="mt-5" variant="error">
      <AlertTitle>Pull request details unavailable</AlertTitle>
      <AlertDescription>
        The selected pull request could not be verified. Branch-level values
        remain available.
      </AlertDescription>
    </Alert>
  );
}
