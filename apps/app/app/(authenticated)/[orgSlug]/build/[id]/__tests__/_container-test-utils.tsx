import { FileChangeStatus } from "@repo/api/src/types/branch-view";
import { GitHubPRState } from "@repo/api/src/types/github";
import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import type { Mock } from "vitest";
import { vi } from "vitest";
import type { BranchViewData, BranchViewFile } from "../types";

type DefaultSyncControlValue = {
  isBranchSyncPending: boolean;
  isCommentsSyncPending: boolean;
  refreshBranch: Mock;
  refreshComments: Mock;
  syncRetryState: null;
};

/**
 * Shared pure helpers for `BranchViewContainer` integration tests.
 *
 * Mocking infrastructure (`vi.hoisted`, `vi.mock`) deliberately lives
 * in each test file — cross-file hoisted bindings hit Vitest's TDZ
 * because the mocked-module factory runs during the very first import
 * that pulls in `BranchViewContainer`, which can be before this
 * module's exports are initialized. Keeping the hoist local sidesteps
 * the trap. Only side-effect-free factories and default values live here.
 */

export const DEFAULT_ENGINEER_ROUTING_VALUE = {
  computeTargetId: null,
  mode: EngineerRoutingMode.CloudRelay,
} as const;

export const DEFAULT_ELECTRON_DETECTION_VALUE = { detected: false } as const;

export const DEFAULT_USE_QUERY_VALUE = {
  data: undefined,
  isSuccess: false,
} as const;

export function makeDefaultSyncControlValue(): DefaultSyncControlValue {
  return {
    isBranchSyncPending: false,
    isCommentsSyncPending: false,
    refreshBranch: vi.fn(),
    refreshComments: vi.fn(),
    syncRetryState: null,
  };
}

export function makeFile(
  path: string,
  previousPath: string | null = null
): BranchViewFile {
  return {
    additions: 1,
    deletions: 0,
    patch: null,
    path,
    previousPath,
    status: FileChangeStatus.Modified,
  };
}

/**
 * Default `BranchViewData` for container-mount tests. Defaults assume the
 * happy flag-on path (`canCreateConversationComment: true`,
 * `currentPullRequest: null`, `prNumber: 7`). Tests that need to exercise
 * the conversation-composer-disabled state or assert on
 * `currentPullRequest` / `prNumber` must pass explicit `overrides` —
 * don't rely on this default if those fields drive a test assertion.
 */
export function makeBranchViewData(
  files: BranchViewFile[] = [makeFile("src/app.tsx")],
  overrides: Partial<BranchViewData> = {}
): BranchViewData {
  return {
    authorLogin: null,
    baseBranch: "main",
    branch: {
      artifactId: "ext-1",
      branchName: "feat/test",
      baseBranch: "main",
      baseBranchSource: "pull_request_base",
      headSha: null,
      headShaSource: null,
      headShaObservedAt: null,
      lastPushBeforeSha: null,
      checksStatus: null,
      fileCacheStatus: "fresh",
      fileCacheHeadSha: null,
      fileCacheFileCount: files.length,
      fileCachePatchBytes: 0,
      fileCacheUpdatedAt: null,
      syncStatus: "fresh",
      lastSyncStartedAt: null,
      lastSyncCompletedAt: null,
      lastSyncErrorCode: null,
      lastSyncErrorMessage: null,
    },
    checksStatus: null,
    canCreateConversationComment: true,
    canCreateInlineComment: false,
    comments: [],
    committedFiles: files,
    currentPullRequest: null,
    externalLinkId: "ext-1",
    externalUrl: "https://github.com/acme/repo/pull/1",
    featureSlug: null,
    featureTitle: null,
    headBranch: "feat/test",
    headSha: null,
    isAuthor: false,
    isDraft: false,
    prHtmlUrl: "",
    prNumber: 7,
    prState: GitHubPRState.Open,
    prTitle: "Test PR",
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

/**
 * Wraps `<Container externalLinkId="ext-1" orgSlug="acme" />` in a fresh
 * `QueryClient` provider so each test gets an isolated cache. The
 * `useBranchView` stub must be configured by the caller before this is
 * called.
 */
export function renderContainerWithQueryClient(
  Container: ComponentType<{ externalLinkId: string; orgSlug: string }>
): ReturnType<typeof render> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<Container externalLinkId="ext-1" orgSlug="acme" />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}
