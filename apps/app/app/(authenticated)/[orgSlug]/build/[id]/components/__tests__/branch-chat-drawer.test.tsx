import { GitHubPRState } from "@repo/api/src/types/github";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { BranchViewData } from "../../types";

const mockUseQuery = vi.fn();
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query"
  );
  return {
    ...actual,
    useQuery: (...args: unknown[]) => mockUseQuery(...args),
  };
});

type CapturedUseChatSessionOptions = {
  chatKey: string;
  provider: string;
  context: string;
  cwd?: string;
  onContextConsumed?: () => void;
  contextSelection?: unknown;
};

const capturedUseChatSessionOptions: {
  value: CapturedUseChatSessionOptions | undefined;
} = { value: undefined };

vi.mock("@/hooks/chat/use-chat-session", () => ({
  useChatSession: (opts: CapturedUseChatSessionOptions) => {
    capturedUseChatSessionOptions.value = opts;
    return {
      messages: [],
      isLoading: false,
      isStreaming: false,
      streamingContent: "",
      streamingBlocks: [],
      streamStartedAt: "",
      contextPercent: null,
      error: null,
      inputValue: "",
      setInputValue: vi.fn(),
      sendMessage: vi.fn(),
      stopStreaming: vi.fn(),
      clearHistory: vi.fn(),
      currentProvider: null,
      currentModel: null,
    };
  },
}));

const capturedChatPanelProps: {
  value: {
    notice?: string | null;
    contextSlot?: React.ReactNode;
  } | null;
} = { value: null };

vi.mock("@/components/chat/ChatPanel", () => ({
  ChatPanel: (props: {
    notice?: string | null;
    contextSlot?: React.ReactNode;
  }) => {
    capturedChatPanelProps.value = props;
    return null;
  },
}));

vi.mock("@/lib/engineer/queries/health-check", () => ({
  getHealthCheckTargetKey: (routing: {
    mode: string;
    computeTargetId: string | null;
  }) => `${routing.mode}:${routing.computeTargetId ?? "none"}`,
  healthCheckOptions: () => ({ queryKey: ["health"], queryFn: vi.fn() }),
}));

import { BranchChatDrawer } from "../branch-chat-drawer";

const BASE_BRANCH_DATA: BranchViewData = {
  externalLinkId: "ext-1",
  branch: {
    artifactId: "ext-1",
    branchName: "feat/x",
    baseBranch: "main",
    baseBranchSource: "pull_request_base",
    headSha: null,
    headShaSource: null,
    headShaObservedAt: null,
    lastPushBeforeSha: null,
    checksStatus: null,
    fileCacheStatus: "fresh",
    fileCacheHeadSha: null,
    fileCacheFileCount: 0,
    fileCachePatchBytes: 0,
    fileCacheUpdatedAt: null,
    syncStatus: "fresh",
    lastSyncStartedAt: null,
    lastSyncCompletedAt: null,
    lastSyncErrorCode: null,
    lastSyncErrorMessage: null,
  },
  currentPullRequest: {
    id: "pr-detail-42",
    githubId: "4242",
    number: 42,
    title: "Add feature X",
    htmlUrl: "https://github.com/acme/repo/pull/42",
    headBranch: "feat/x",
    baseBranch: "main",
    headSha: null,
    state: GitHubPRState.Open,
    isDraft: false,
    checksStatus: null,
    reviewDecision: null,
  },
  prTitle: "Add feature X",
  externalUrl: "https://github.com/acme/repo/pull/42",
  prNumber: 42,
  prHtmlUrl: "https://github.com/acme/repo/pull/42",
  featureSlug: null,
  featureTitle: null,
  teamId: null,
  teamName: null,
  projectId: null,
  projectName: null,
  headBranch: "feat/x",
  baseBranch: "main",
  headSha: null,
  prState: GitHubPRState.Open,
  reviewDecision: null,
  checksStatus: null,
  isDraft: false,
  authorLogin: null,
  isAuthor: false,
  canCreateConversationComment: false,
  canCreateInlineComment: false,
  repoFullName: "acme/repo",
  committedFiles: [],
  reviews: [],
  comments: [],
  producedByPlanSlug: null,
  producedByPlanTitle: null,
};

beforeEach(() => {
  capturedUseChatSessionOptions.value = undefined;
  capturedChatPanelProps.value = null;
  vi.clearAllMocks();
  mockUseQuery.mockReturnValue({ data: undefined });
});

describe("BranchChatDrawer", () => {
  test("passes chatKey derived from externalLinkId to useChatSession", () => {
    render(
      <BranchChatDrawer
        contextSelection={null}
        data={BASE_BRANCH_DATA}
        showFilesystemNotice={false}
        worktreePath={null}
      />
    );
    expect(capturedUseChatSessionOptions.value?.chatKey).toBe("branch:ext-1");
  });

  test("passes cwd matching worktreePath when provided", () => {
    render(
      <BranchChatDrawer
        contextSelection={null}
        data={BASE_BRANCH_DATA}
        showFilesystemNotice={false}
        worktreePath="/Users/dev/wt-1"
      />
    );
    expect(capturedUseChatSessionOptions.value?.cwd).toBe("/Users/dev/wt-1");
  });

  test("passes cwd undefined when worktreePath is null", () => {
    render(
      <BranchChatDrawer
        contextSelection={null}
        data={BASE_BRANCH_DATA}
        showFilesystemNotice={false}
        worktreePath={null}
      />
    );
    expect(capturedUseChatSessionOptions.value?.cwd).toBeUndefined();
  });

  test("renders notice when filesystem access is unavailable", () => {
    render(
      <BranchChatDrawer
        contextSelection={null}
        data={BASE_BRANCH_DATA}
        showFilesystemNotice={true}
        worktreePath={null}
      />
    );
    expect(capturedChatPanelProps.value?.notice).toContain(
      "No local checkout was found for this branch"
    );
  });

  test("does not render notice when filesystem access is available", () => {
    render(
      <BranchChatDrawer
        contextSelection={null}
        data={BASE_BRANCH_DATA}
        showFilesystemNotice={false}
        worktreePath={null}
      />
    );
    expect(capturedChatPanelProps.value?.notice).toBeNull();
  });

  test("does not render notice when worktreePath is present", () => {
    render(
      <BranchChatDrawer
        contextSelection={null}
        data={BASE_BRANCH_DATA}
        showFilesystemNotice={false}
        worktreePath="/Users/dev/wt-1"
      />
    );
    expect(capturedChatPanelProps.value?.notice).toBeNull();
  });

  test("renders contextSlot when contextSelection is non-null", () => {
    render(
      <BranchChatDrawer
        contextSelection={{
          id: "comment-1",
          filePath: "src/foo.ts",
          line: 10,
          body: "Looks suspicious",
        }}
        data={BASE_BRANCH_DATA}
        showFilesystemNotice={false}
        worktreePath={null}
      />
    );
    expect(capturedChatPanelProps.value?.contextSlot).not.toBeNull();
    expect(capturedChatPanelProps.value?.contextSlot).toBeDefined();
  });

  test("does not render contextSlot when contextSelection is null", () => {
    render(
      <BranchChatDrawer
        contextSelection={null}
        data={BASE_BRANCH_DATA}
        showFilesystemNotice={false}
        worktreePath={null}
      />
    );
    expect(capturedChatPanelProps.value?.contextSlot).toBeNull();
  });

  test("forwards contextSelection through to useChatSession", () => {
    const selection = {
      id: "c1",
      filePath: "src/foo.ts",
      line: 7,
      body: "nit",
    };
    render(
      <BranchChatDrawer
        contextSelection={selection}
        data={BASE_BRANCH_DATA}
        showFilesystemNotice={false}
        worktreePath={null}
      />
    );
    expect(capturedUseChatSessionOptions.value?.contextSelection).toEqual(
      selection
    );
  });

  test("does NOT call onClearComment on mount (before a successful send)", () => {
    const onClearComment = vi.fn();
    render(
      <BranchChatDrawer
        contextSelection={{ id: "c1", body: "b" }}
        data={BASE_BRANCH_DATA}
        onClearComment={onClearComment}
        showFilesystemNotice={false}
        worktreePath={null}
      />
    );
    expect(onClearComment).not.toHaveBeenCalled();
  });

  test("invokes onClearComment only when onContextConsumed fires from useChatSession", () => {
    const onClearComment = vi.fn();
    render(
      <BranchChatDrawer
        contextSelection={{ id: "c1", body: "b" }}
        data={BASE_BRANCH_DATA}
        onClearComment={onClearComment}
        showFilesystemNotice={false}
        worktreePath={null}
      />
    );

    // Still not called before onContextConsumed fires.
    expect(onClearComment).not.toHaveBeenCalled();

    // Simulate useChatSession triggering onContextConsumed (which it only
    // does after a successful send — see use-chat-session PR I tests).
    const onContextConsumed =
      capturedUseChatSessionOptions.value?.onContextConsumed;
    expect(onContextConsumed).toBeDefined();
    onContextConsumed?.();
    expect(onClearComment).toHaveBeenCalledTimes(1);
  });
});
