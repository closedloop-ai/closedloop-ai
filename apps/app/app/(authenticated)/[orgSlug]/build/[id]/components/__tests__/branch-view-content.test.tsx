import { BranchFileCacheStatus } from "@repo/api/src/types/artifact";
import {
  BranchViewFileCacheSyncErrorCode,
  BranchViewSyncOutcomeSource,
  BranchViewSyncPresentationState,
  BranchViewSyncThrottleReason,
  FileChangeStatus,
} from "@repo/api/src/types/branch-view";
import { GitHubPRState } from "@repo/api/src/types/github";
import type { BranchViewSyncControl } from "@repo/app/documents/hooks/use-branch-view";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchViewData, BranchViewFile } from "../../types";
import { BranchViewContent } from "../branch-view-content";

const mockRefreshBranch = vi.fn();
const mockRefreshComments = vi.fn();

vi.mock("../branch-pr-comments-section", () => ({
  BranchPrCommentsSection: () => <div data-testid="comments-section" />,
}));

vi.mock("../branch-properties-bar", () => ({
  BranchPropertiesBar: () => <div data-testid="properties-bar" />,
}));

vi.mock("../committed-changes-section", () => ({
  CommittedChangesSection: ({ files }: { files: BranchViewFile[] }) => (
    <div data-testid="committed-changes">{files.length}</div>
  ),
}));

vi.mock("../local-changes-section", () => ({
  LocalChangesSection: ({ files }: { files: BranchViewFile[] }) => (
    <div data-testid="local-changes">{files.length}</div>
  ),
}));

const SECRET_TEXT_REGEX = /ghp_secret/;

function file(path: string): BranchViewFile {
  return {
    additions: 1,
    deletions: 0,
    patch: null,
    path,
    previousPath: null,
    status: FileChangeStatus.Modified,
  };
}

function data(overrides: Partial<BranchViewData> = {}): BranchViewData {
  return {
    authorLogin: null,
    baseBranch: "main",
    branch: {
      artifactId: "branch-1",
      branchName: "feature/test",
      baseBranch: "main",
      baseBranchSource: "repository_default",
      headSha: null,
      headShaSource: null,
      headShaObservedAt: null,
      lastPushBeforeSha: null,
      checksStatus: null,
      fileCacheStatus: BranchFileCacheStatus.Absent,
      fileCacheHeadSha: null,
      fileCacheFileCount: 0,
      fileCachePatchBytes: 0,
      fileCacheUpdatedAt: null,
      syncStatus: "idle",
      lastSyncStartedAt: null,
      lastSyncCompletedAt: null,
      lastSyncErrorCode: null,
      lastSyncErrorMessage: null,
    },
    checksStatus: null,
    comments: [],
    committedFiles: [],
    currentPullRequest: null,
    externalLinkId: "external-1",
    externalUrl: "https://github.com/acme/repo/tree/feature%2Ftest",
    featureSlug: null,
    featureTitle: null,
    headBranch: "feature/test",
    headSha: null,
    isAuthor: false,
    canCreateConversationComment: false,
    canCreateInlineComment: false,
    isDraft: false,
    prHtmlUrl: "",
    prNumber: 0,
    prState: GitHubPRState.Open,
    prTitle: "feature/test",
    producedByPlanSlug: null,
    producedByPlanTitle: null,
    projectId: null,
    projectName: null,
    repoFullName: "acme/repo",
    reviewDecision: null,
    reviews: [],
    teamId: null,
    teamName: null,
    ...overrides,
  };
}

function renderContent(
  branchViewData: BranchViewData,
  syncControlOverrides: Partial<BranchViewSyncControl> = {}
) {
  const syncControl: BranchViewSyncControl = {
    syncRetryState: null,
    isBranchSyncPending: false,
    isCommentsSyncPending: false,
    refreshBranch: mockRefreshBranch,
    refreshComments: mockRefreshComments,
    ...syncControlOverrides,
  };

  render(
    <BranchViewContent
      data={branchViewData}
      localFiles={[]}
      onSelectComment={vi.fn()}
      onSelectCommentDiffTarget={vi.fn()}
      onSelectFile={vi.fn()}
      selectedCommentId={null}
      selectedFileId={null}
      syncControl={syncControl}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BranchViewContent file-cache empty state", () => {
  it("shows a sync prompt when the cache is absent and no files render", () => {
    renderContent(data());

    expect(
      screen.getByText("File changes have not been synced for this branch.")
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sync files" }));

    expect(mockRefreshBranch).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("committed-changes")).not.toBeInTheDocument();
  });

  it("renders committed files instead of the absent-cache prompt when files exist", () => {
    renderContent(data({ committedFiles: [file("src/app.tsx")] }));

    expect(screen.getByTestId("committed-changes")).toHaveTextContent("1");
    expect(
      screen.queryByText("File changes have not been synced for this branch.")
    ).not.toBeInTheDocument();
  });

  it("renders stale committed-cache files instead of the absent-cache prompt", () => {
    renderContent(
      data({
        branch: {
          ...data().branch!,
          fileCacheStatus: BranchFileCacheStatus.Stale,
        },
        committedFiles: [file("src/stale.tsx")],
      })
    );

    expect(screen.getByTestId("committed-changes")).toHaveTextContent("1");
    expect(
      screen.queryByText("File changes have not been synced for this branch.")
    ).not.toBeInTheDocument();
  });

  it("surfaces failed file-cache state without hiding committed files", () => {
    renderContent(
      data({
        branch: {
          ...data().branch!,
          fileCacheStatus: BranchFileCacheStatus.Failed,
        },
        committedFiles: [file("src/failed.tsx")],
      })
    );

    expect(screen.getByTestId("committed-changes")).toHaveTextContent("1");
    expect(
      screen.getByText(
        "Showing last synced file changes. The latest file refresh failed."
      )
    ).toBeInTheDocument();
  });

  it("maps raw compare failure codes to safe file-cache labels", () => {
    renderContent(
      data({
        branch: {
          ...data().branch!,
          fileCacheStatus: BranchFileCacheStatus.Failed,
          lastSyncErrorCode: BranchViewFileCacheSyncErrorCode.CompareFailed,
          lastSyncErrorMessage: "token ghp_secret leaked by provider",
        },
        committedFiles: [file("src/failed.tsx")],
        syncState: {
          backgroundRefreshAfterAt: null,
          branchLastAttemptedAt: "2026-05-27T17:00:00.000Z",
          branchLastSyncedAt: "2026-05-27T16:55:00.000Z",
          inProgress: false,
          lastOutcome: {
            code: BranchViewFileCacheSyncErrorCode.CompareFailed,
            httpStatus: 500,
            message: "Could not refresh file changes from GitHub.",
            retryAfterSeconds: null,
            source: BranchViewSyncOutcomeSource.FileCache,
            synced: false,
          },
          lifecycleLastAttemptedAt: null,
          lifecycleLastSyncedAt: null,
          presentation: BranchViewSyncPresentationState.Failed,
        },
      })
    );

    expect(
      screen.getByText(
        "Showing last synced file changes. Could not refresh file changes from GitHub."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(SECRET_TEXT_REGEX)).not.toBeInTheDocument();
  });

  it("maps missing compare refs to a safe unavailable label", () => {
    renderContent(
      data({
        branch: {
          ...data().branch!,
          fileCacheStatus: BranchFileCacheStatus.Failed,
          lastSyncErrorCode:
            BranchViewFileCacheSyncErrorCode.MissingCompareRefs,
        },
        syncState: {
          backgroundRefreshAfterAt: null,
          branchLastAttemptedAt: "2026-05-27T17:00:00.000Z",
          branchLastSyncedAt: null,
          inProgress: false,
          lastOutcome: {
            code: BranchViewFileCacheSyncErrorCode.MissingCompareRefs,
            httpStatus: 400,
            message: "File comparison is unavailable for this branch.",
            retryAfterSeconds: null,
            source: BranchViewSyncOutcomeSource.FileCache,
            synced: false,
          },
          lifecycleLastAttemptedAt: null,
          lifecycleLastSyncedAt: null,
          presentation: BranchViewSyncPresentationState.Failed,
        },
      })
    );

    expect(
      screen.getByText("File comparison is unavailable for this branch.")
    ).toBeInTheDocument();
  });

  it("disables absent-cache sync and shows local retry state", () => {
    renderContent(data(), {
      syncRetryState: {
        retryAfterSeconds: 9,
        throttleReason: BranchViewSyncThrottleReason.LocalDedupe,
      },
    });

    expect(screen.getByText("Refresh available in 9s")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync files" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Sync files" }));
    expect(mockRefreshBranch).not.toHaveBeenCalled();
  });

  it("disables failed-cache refresh and shows in-flight retry state", () => {
    renderContent(
      data({
        branch: {
          ...data().branch!,
          fileCacheStatus: BranchFileCacheStatus.Failed,
        },
        committedFiles: [file("src/failed.tsx")],
      }),
      {
        syncRetryState: {
          retryAfterSeconds: 14,
          throttleReason: BranchViewSyncThrottleReason.InFlight,
        },
      }
    );

    expect(
      screen.getByText(
        "Showing last synced file changes. The latest file refresh failed. Refresh already running. Try again in 14s"
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Refresh files" })
    ).toBeDisabled();
  });

  it("disables stale-cache refresh and shows generic retry fallback", () => {
    renderContent(
      data({
        branch: {
          ...data().branch!,
          fileCacheStatus: BranchFileCacheStatus.Stale,
        },
        committedFiles: [file("src/stale.tsx")],
      }),
      {
        syncRetryState: {
          retryAfterSeconds: 21,
          throttleReason: "future_reason" as BranchViewSyncThrottleReason,
        },
      }
    );

    expect(
      screen.getByText(
        "Showing last synced file changes for this branch. Try again in 21s"
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Refresh files" })
    ).toBeDisabled();
  });
});
