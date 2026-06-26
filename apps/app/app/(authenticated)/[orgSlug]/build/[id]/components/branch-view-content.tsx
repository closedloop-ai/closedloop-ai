"use client";

import { BranchFileCacheStatus } from "@repo/api/src/types/artifact";
import type { BranchViewSyncControl } from "@repo/app/documents/hooks/use-branch-view";
import { Button } from "@repo/design-system/components/ui/button";
import { RefreshCw } from "lucide-react";
import type { CommentDiffNavigationRequest } from "../file-targets";
import {
  type BranchViewData,
  type BranchViewFile,
  buildFileId,
  FileSection,
} from "../types";
import { BranchPrCommentsSection } from "./branch-pr-comments-section";
import { BranchPropertiesBar } from "./branch-properties-bar";
import {
  getFileCacheDisplayMessage,
  getSyncRetryLabel,
} from "./branch-view-sync-display";
import { CommittedChangesSection } from "./committed-changes-section";
import { LocalChangesSection } from "./local-changes-section";

type BranchViewContentProps = {
  commitError?: unknown;
  commitUnavailableReason?: string | null;
  data: BranchViewData;
  /**
   * When true, suppress the inline `BranchPrCommentsSection`. Flag-on
   * builds (comments-v2-feed-sidebar) render PR comments inside the
   * right-rail FeedSidebar instead.
   */
  hidePrComments?: boolean;
  isCommitPending?: boolean;
  localError?: unknown;
  localFiles: BranchViewFile[];
  onCommitAndPush?: () => void;
  onSelectComment: (id: string | null) => void;
  onSelectCommentDiffTarget: (request: CommentDiffNavigationRequest) => void;
  onSelectFile: (fileId: string) => void;
  selectedCommentId: string | null;
  selectedFileId: string | null;
  syncControl: BranchViewSyncControl;
};

export function BranchViewContent({
  commitError,
  commitUnavailableReason,
  data,
  hidePrComments = false,
  isCommitPending = false,
  localError,
  localFiles,
  onCommitAndPush,
  onSelectComment,
  onSelectCommentDiffTarget,
  onSelectFile,
  selectedCommentId,
  selectedFileId,
  syncControl,
}: Readonly<BranchViewContentProps>) {
  const hasRenderedFiles =
    data.committedFiles.length > 0 || (data.isAuthor && localFiles.length > 0);
  const showAbsentCachePrompt =
    data.branch?.fileCacheStatus === BranchFileCacheStatus.Absent &&
    !hasRenderedFiles;
  const fileCacheMessage = getFileCacheDisplayMessage({
    branch: data.branch,
    committedFileCount: data.committedFiles.length,
    syncState: data.syncState,
  });
  const syncRetryLabel = syncControl.syncRetryState
    ? getSyncRetryLabel(syncControl.syncRetryState)
    : null;
  const isBranchRefreshDisabled =
    syncControl.isBranchSyncPending || Boolean(syncControl.syncRetryState);

  return (
    <div className="flex flex-col gap-5 px-3 py-6 sm:px-6 sm:py-8">
      <div className="flex flex-col gap-3">
        <h1 className="font-semibold text-2xl text-foreground tracking-tight [-webkit-font-smoothing:antialiased]">
          {data.prTitle}
        </h1>
        <BranchPropertiesBar data={data} syncControl={syncControl} />
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        {data.isAuthor && localFiles.length > 0 ? (
          <LocalChangesSection
            commitError={commitError}
            commitUnavailableReason={commitUnavailableReason ?? null}
            files={localFiles}
            isCommitPending={isCommitPending}
            localError={localError}
            onCommitAndPush={onCommitAndPush}
            onSelectFile={(path) =>
              onSelectFile(buildFileId(FileSection.Local, path))
            }
            section={FileSection.Local}
            selectedFileId={selectedFileId}
          />
        ) : null}

        {showAbsentCachePrompt ? (
          <AbsentFileCachePrompt
            isBranchRefreshDisabled={isBranchRefreshDisabled}
            isBranchSyncPending={syncControl.isBranchSyncPending}
            onRefreshBranch={syncControl.refreshBranch}
            syncRetryLabel={syncRetryLabel}
          />
        ) : (
          <>
            <FileCacheStatusBanner
              fileCacheMessage={fileCacheMessage}
              isBranchRefreshDisabled={isBranchRefreshDisabled}
              isBranchSyncPending={syncControl.isBranchSyncPending}
              onRefreshBranch={syncControl.refreshBranch}
              syncRetryLabel={syncRetryLabel}
            />
            <CommittedChangesSection
              files={data.committedFiles}
              onSelectFile={(path) =>
                onSelectFile(buildFileId(FileSection.Committed, path))
              }
              section={FileSection.Committed}
              selectedFileId={selectedFileId}
            />
          </>
        )}

        {hidePrComments ? null : (
          <BranchPrCommentsSection
            canCreateConversationComment={data.canCreateConversationComment}
            commentPromptEligibility={data.commentPromptEligibility}
            comments={data.comments}
            committedFiles={data.committedFiles}
            externalLinkId={data.externalLinkId}
            fileCacheHeadSha={data.branch?.fileCacheHeadSha ?? null}
            headSha={data.branch?.headSha ?? data.headSha}
            onSelectComment={onSelectComment}
            onSelectCommentDiffTarget={onSelectCommentDiffTarget}
            selectedCommentId={selectedCommentId}
          />
        )}
      </div>
    </div>
  );
}

type FileCacheRefreshProps = {
  isBranchRefreshDisabled: boolean;
  isBranchSyncPending: boolean;
  onRefreshBranch: () => void;
  syncRetryLabel: string | null;
};

function AbsentFileCachePrompt({
  isBranchRefreshDisabled,
  isBranchSyncPending,
  onRefreshBranch,
  syncRetryLabel,
}: FileCacheRefreshProps) {
  return (
    <div
      className="flex min-h-36 flex-col items-center justify-center gap-3 border border-border border-dashed px-4 py-8 text-center"
      role="status"
    >
      <RefreshCw className="h-5 w-5 text-muted-foreground" />
      <p className="max-w-md text-muted-foreground text-sm">
        File changes have not been synced for this branch.
      </p>
      {syncRetryLabel ? (
        <p className="max-w-md text-muted-foreground text-sm">
          {syncRetryLabel}
        </p>
      ) : null}
      <Button
        disabled={isBranchRefreshDisabled}
        onClick={onRefreshBranch}
        size="sm"
        type="button"
        variant="secondary"
      >
        <RefreshCw className={getRefreshIconClass(isBranchSyncPending)} />
        Sync files
      </Button>
    </div>
  );
}

function FileCacheStatusBanner({
  fileCacheMessage,
  isBranchRefreshDisabled,
  isBranchSyncPending,
  onRefreshBranch,
  syncRetryLabel,
}: FileCacheRefreshProps & { fileCacheMessage: string | null }) {
  if (!fileCacheMessage) {
    return null;
  }

  return (
    <div
      className="flex items-center justify-between gap-3 border border-border bg-muted/30 px-3 py-2 text-muted-foreground text-sm"
      role="status"
    >
      <span>
        {fileCacheMessage}
        {syncRetryLabel ? ` ${syncRetryLabel}` : ""}
      </span>
      <Button
        disabled={isBranchRefreshDisabled}
        onClick={onRefreshBranch}
        size="sm"
        type="button"
        variant="ghost"
      >
        <RefreshCw className={getRefreshIconClass(isBranchSyncPending)} />
        Refresh files
      </Button>
    </div>
  );
}

function getRefreshIconClass(isBranchSyncPending: boolean) {
  return isBranchSyncPending ? "mr-1.5 h-4 w-4 animate-spin" : "mr-1.5 h-4 w-4";
}
