import { BranchViewLoadErrorCode } from "@repo/api/src/types/branch-view";
import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { ApiError } from "@repo/app/shared/api/api-error";
import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { BranchViewContainer } from "../branch-view-container";
import type { BranchViewData, BranchViewFile } from "../types";
import {
  DEFAULT_ELECTRON_DETECTION_VALUE,
  DEFAULT_ENGINEER_ROUTING_VALUE,
  DEFAULT_USE_QUERY_VALUE,
  makeBranchViewData,
  makeDefaultSyncControlValue,
  makeFile,
  renderContainerWithQueryClient,
} from "./_container-test-utils";

const mockUseBranchView = vi.hoisted(() => vi.fn());
const mockUseFeatureFlag = vi.hoisted(() => vi.fn());
const mockUseEngineerRoutingSelection = vi.hoisted(() => vi.fn());
const mockUseElectronDetection = vi.hoisted(() => vi.fn());
const mockUseQuery = vi.hoisted(() => vi.fn());
const mockUseBranchViewSyncControl = vi.hoisted(() => vi.fn());

const mockMutationFactory = vi.hoisted(() => () => ({
  isPending: false,
  mutate: vi.fn(),
  variables: undefined,
  error: null,
}));

const OPEN_IN_GITHUB_NAME = /open in github/i;
const VIEW_PLAN_NAME = /view plan/i;
const VIEW_FEATURE_NAME = /view feature/i;
const BACK_TO_PROJECT_NAME = /back to project/i;
const RETRY_NAME = /retry/i;

type BranchViewContentProps = {
  data: BranchViewData;
  localError: Error | null;
  localFiles: BranchViewFile[];
  onSelectCommentDiffTarget: (request: {
    commentId: string;
    fileId: string;
    path: string;
    line: number;
  }) => void;
  onSelectFile: (fileId: string) => void;
};

type BranchDiffViewProps = {
  localDiffContext: unknown;
  onSelectFile: (fileId: string) => void;
  selectedFileId: string;
  targetActivationId: number | null;
  targetLine: number | null;
};

type BranchChatDrawerProps = {
  worktreePath: string | null;
};

const captured = vi.hoisted(() => ({
  chatDrawerProps: null as BranchChatDrawerProps | null,
  chatDrawerRenderCount: 0,
  contentProps: null as BranchViewContentProps | null,
  diffProps: null as BranchDiffViewProps | null,
}));

vi.mock("@repo/app/documents/hooks/use-branch-view", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@repo/app/documents/hooks/use-branch-view")
    >();
  return {
    ...actual,
    useBranchView: (...args: unknown[]) => mockUseBranchView(...args),
    useBranchViewSyncControl: (...args: unknown[]) =>
      mockUseBranchViewSyncControl(...args),
    useReplyToComment: mockMutationFactory,
    useCreateBranchViewConversationComment: mockMutationFactory,
    useEditBranchViewConversationComment: mockMutationFactory,
    useDeleteBranchViewConversationComment: mockMutationFactory,
    useEditBranchViewReviewComment: mockMutationFactory,
    useDeleteBranchViewReviewComment: mockMutationFactory,
    useResolveBranchViewReviewThread: mockMutationFactory,
    useUnresolveBranchViewReviewThread: mockMutationFactory,
  };
});

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: (key: string) => mockUseFeatureFlag(key),
}));

vi.mock("@repo/auth/client", () => ({
  useOrganization: () => ({ organization: { id: "org_test", slug: "org" } }),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query"
  );
  return {
    ...actual,
    useQuery: (...args: unknown[]) => mockUseQuery(...args),
  };
});

vi.mock("@/lib/engineer/routing-store", () => ({
  useEngineerRoutingSelection: () => mockUseEngineerRoutingSelection(),
}));

vi.mock("@/lib/engineer/electron-detection", () => ({
  useElectronDetection: () => mockUseElectronDetection(),
}));

vi.mock("../components/branch-view-header", () => ({
  BranchViewHeader: () => <div data-testid="branch-header" />,
}));

vi.mock("../components/branch-view-content", () => ({
  BranchViewContent: (props: BranchViewContentProps) => {
    captured.contentProps = props;
    return <div data-testid="branch-content" />;
  },
}));

vi.mock("../components/branch-diff-view", () => ({
  BranchDiffView: (props: BranchDiffViewProps) => {
    captured.diffProps = props;
    return <div data-testid="branch-diff" />;
  },
}));

vi.mock("../components/branch-chat-drawer", () => ({
  BranchChatDrawer: (props: BranchChatDrawerProps) => {
    captured.chatDrawerProps = props;
    captured.chatDrawerRenderCount += 1;
    return <div data-testid="branch-chat" />;
  },
}));

function renderContainer(data: BranchViewData = makeBranchViewData()) {
  mockUseBranchView.mockReturnValue({
    data,
    error: null,
    isLoading: false,
    refetch: vi.fn(),
  });
  return renderContainerWithQueryClient(BranchViewContainer);
}

function renderContainerWithCurrentBranchViewMock() {
  return renderContainerWithQueryClient(BranchViewContainer);
}

beforeEach(() => {
  captured.chatDrawerProps = null;
  captured.chatDrawerRenderCount = 0;
  captured.contentProps = null;
  captured.diffProps = null;
  vi.clearAllMocks();
  mockUseEngineerRoutingSelection.mockReturnValue(
    DEFAULT_ENGINEER_ROUTING_VALUE
  );
  mockUseElectronDetection.mockReturnValue(DEFAULT_ELECTRON_DETECTION_VALUE);
  mockUseQuery.mockReturnValue(DEFAULT_USE_QUERY_VALUE);
  mockUseBranchViewSyncControl.mockReturnValue(makeDefaultSyncControlValue());
  mockUseFeatureFlag.mockImplementation((key: string) => {
    if (key === "branch-pr") {
      return { enabled: true };
    }
    if (key === "interactive-chat") {
      return { enabled: false };
    }
    return { enabled: false };
  });
});

describe("BranchViewContainer comment diff navigation", () => {
  test("renders a stale-link unavailable state before branch-pr redirect", () => {
    mockUseFeatureFlag.mockImplementation((key: string) =>
      key === "branch-pr" ? { enabled: false } : { enabled: false }
    );
    mockUseBranchView.mockReturnValue({
      data: undefined,
      error: new ApiError("Branch view not found", 404, {
        code: BranchViewLoadErrorCode.LinkNotFound,
      }),
      isLoading: false,
      refetch: vi.fn(),
    });

    renderContainerWithCurrentBranchViewMock();

    expect(screen.getByText("Branch view link expired")).toBeInTheDocument();
    expect(screen.queryByText("Redirecting to GitHub...")).toBeNull();
    expect(screen.queryByTestId("branch-content")).toBeNull();
  });

  test("does not redirect from stale cached PR data when branch-pr is disabled and the latest load is unavailable", () => {
    const replaceSpy = vi.fn();
    vi.stubGlobal("location", {
      ...globalThis.location,
      replace: replaceSpy,
    });
    try {
      mockUseFeatureFlag.mockImplementation((key: string) =>
        key === "branch-pr" ? { enabled: false } : { enabled: false }
      );
      mockUseBranchView.mockReturnValue({
        data: makeBranchViewData([], {
          prHtmlUrl: "https://github.com/acme/repo/pull/1",
        }),
        error: new ApiError("Pull request unavailable", 404, {
          code: BranchViewLoadErrorCode.PullRequestUnavailable,
        }),
        isLoading: false,
        refetch: vi.fn(),
      });

      renderContainerWithCurrentBranchViewMock();

      expect(screen.getByText("Pull request unavailable")).toBeInTheDocument();
      expect(screen.queryByText("Redirecting to GitHub...")).toBeNull();
      expect(screen.queryByTestId("branch-content")).toBeNull();
      expect(replaceSpy).not.toHaveBeenCalled();
      expect(mockUseBranchViewSyncControl).toHaveBeenCalledWith({
        backgroundEnabled: false,
        data: undefined,
        externalLinkId: "ext-1",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("quarantines stale cached data before side-effect hooks when an unavailable error is present", () => {
    mockUseEngineerRoutingSelection.mockReturnValue({
      computeTargetId: "compute-target-1",
      mode: EngineerRoutingMode.CloudRelay,
    });
    mockUseBranchView.mockReturnValue({
      data: makeBranchViewData([], {
        isAuthor: true,
        prHtmlUrl: "https://github.com/acme/repo/pull/1",
      }),
      error: new ApiError("Pull request unavailable", 404, {
        code: BranchViewLoadErrorCode.PullRequestUnavailable,
      }),
      isLoading: false,
      refetch: vi.fn(),
    });

    renderContainerWithCurrentBranchViewMock();

    expect(screen.getByText("Pull request unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("branch-content")).toBeNull();
    expect(mockUseBranchViewSyncControl).toHaveBeenCalledWith({
      backgroundEnabled: true,
      data: undefined,
      externalLinkId: "ext-1",
    });
    expect(mockUseQuery.mock.calls[0]?.[0]).toMatchObject({
      enabled: false,
      queryKey: expect.arrayContaining(["", "", 0]),
    });
  });

  test("renders unavailable PR actions only from validated complete details", () => {
    mockUseBranchView.mockReturnValue({
      data: undefined,
      error: new ApiError("Pull request unavailable", 404, {
        code: BranchViewLoadErrorCode.PullRequestUnavailable,
        details: {
          githubPullRequestUrl: "https://github.com/acme/repo/pull/42",
          producedByPlanSlug: "PLN-741",
          featureSlug: "feature-1",
          projectId: "project-1",
          teamId: "team-1",
        },
      }),
      isLoading: false,
      refetch: vi.fn(),
    });

    renderContainerWithCurrentBranchViewMock();

    expect(screen.getByText("Pull request unavailable")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: OPEN_IN_GITHUB_NAME })
    ).toHaveAttribute("href", "https://github.com/acme/repo/pull/42");
    expect(screen.getByRole("link", { name: VIEW_PLAN_NAME })).toHaveAttribute(
      "href",
      "/acme/implementation-plans/PLN-741"
    );
    expect(
      screen.getByRole("link", { name: VIEW_FEATURE_NAME })
    ).toHaveAttribute("href", "/acme/features/feature-1");
    expect(
      screen.getByRole("link", { name: BACK_TO_PROJECT_NAME })
    ).toHaveAttribute("href", "/acme/teams/team-1/projects/project-1");
  });

  test.each([
    {
      error: new ApiError("Forbidden", 403),
      hasRetry: false,
      title: "Access required",
    },
    {
      error: new ApiError("Future branch-view load failure", 409, {
        code: "branch_view_future",
        details: {
          featureSlug: "feature/unsafe",
          githubPullRequestUrl: "https://example.com/acme/repo/pull/42",
          producedByPlanSlug: "PLN/unsafe",
          projectId: "project-1",
        },
      }),
      hasRetry: true,
      title: "Branch view unavailable",
    },
    {
      error: null,
      hasRetry: true,
      title: "Branch view unavailable",
    },
  ])("renders $title mode and suppresses unsafe or incomplete actions", ({
    error,
    hasRetry,
    title,
  }) => {
    mockUseBranchView.mockReturnValue({
      data: undefined,
      error,
      isLoading: false,
      refetch: vi.fn(),
    });

    renderContainerWithCurrentBranchViewMock();

    expect(screen.getByText(title)).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: OPEN_IN_GITHUB_NAME })
    ).toBeNull();
    expect(screen.queryByRole("link", { name: VIEW_PLAN_NAME })).toBeNull();
    expect(screen.queryByRole("link", { name: VIEW_FEATURE_NAME })).toBeNull();
    expect(
      screen.queryByRole("link", { name: BACK_TO_PROJECT_NAME })
    ).toBeNull();
    const retryButton = screen.queryByRole("button", { name: RETRY_NAME });
    if (hasRetry) {
      expect(retryButton).toBeInTheDocument();
    } else {
      expect(retryButton).toBeNull();
    }
  });

  test("calls refetch from the transient unavailable retry action", () => {
    const refetch = vi.fn();
    mockUseBranchView.mockReturnValue({
      data: undefined,
      error: new ApiError("Temporary failure", 500, {
        code: BranchViewLoadErrorCode.TransientLoadError,
      }),
      isLoading: false,
      refetch,
    });

    renderContainerWithCurrentBranchViewMock();
    screen.getByRole("button", { name: RETRY_NAME }).click();

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  test("shows loading feedback while a retry refetch is in flight after an error", () => {
    mockUseBranchView.mockReturnValue({
      data: undefined,
      error: new ApiError("Temporary failure", 500, {
        code: BranchViewLoadErrorCode.TransientLoadError,
      }),
      isFetching: true,
      isLoading: false,
      refetch: vi.fn(),
    });

    const { container } = renderContainerWithCurrentBranchViewMock();

    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: RETRY_NAME })).toBeNull();
    expect(
      screen.queryByText("Branch view temporarily unavailable")
    ).toBeNull();
  });

  test("wires navigation when branch-pr is enabled and interactive-chat is disabled", () => {
    renderContainer();

    expect(screen.getByTestId("branch-content")).toBeInTheDocument();
    expect(captured.contentProps?.data.committedFiles).toEqual([
      makeFile("src/app.tsx"),
    ]);
    expect(captured.chatDrawerRenderCount).toBe(0);

    act(() => {
      captured.contentProps?.onSelectCommentDiffTarget({
        commentId: "c1",
        fileId: "committed:src/app.tsx",
        path: "src/app.tsx",
        line: 42,
      });
    });

    expect(screen.getByTestId("branch-diff")).toBeInTheDocument();
    expect(captured.diffProps?.selectedFileId).toBe("committed:src/app.tsx");
    expect(captured.diffProps?.targetLine).toBe(42);
    expect(captured.diffProps?.targetActivationId).toEqual(expect.any(Number));
  });

  test("does not expose navigation children when branch-pr is disabled", () => {
    mockUseFeatureFlag.mockImplementation((key: string) =>
      key === "branch-pr" ? { enabled: false } : { enabled: false }
    );
    renderContainer();

    expect(screen.getByText("Redirecting to GitHub...")).toBeInTheDocument();
    expect(screen.queryByTestId("branch-content")).toBeNull();
    expect(screen.queryByTestId("branch-diff")).toBeNull();
    expect(captured.contentProps).toBeNull();
  });

  test("does not expose navigation children while branch-pr is unresolved", () => {
    mockUseFeatureFlag.mockImplementation((key: string) =>
      key === "branch-pr" ? undefined : { enabled: false }
    );
    renderContainer();

    expect(screen.queryByTestId("branch-content")).toBeNull();
    expect(screen.queryByTestId("branch-diff")).toBeNull();
    expect(captured.contentProps).toBeNull();
  });

  test("uses the chip-emitted target when refreshed data no longer resolves the same file", () => {
    renderContainer(makeBranchViewData([makeFile("src/new.ts", "src/old.ts")]));

    act(() => {
      captured.contentProps?.onSelectCommentDiffTarget({
        commentId: "stale",
        fileId: "committed:src/deleted.ts",
        path: "src/deleted.ts",
        line: 99,
      });
    });
    expect(captured.diffProps?.selectedFileId).toBe("committed:src/deleted.ts");
    expect(captured.diffProps?.targetLine).toBe(99);

    act(() => {
      captured.contentProps?.onSelectCommentDiffTarget({
        commentId: "old",
        fileId: "committed:src/wrong.ts",
        path: "src/old.ts",
        line: 10,
      });
    });
    expect(captured.diffProps?.selectedFileId).toBe("committed:src/wrong.ts");
    expect(captured.diffProps?.targetLine).toBe(10);

    act(() => {
      captured.contentProps?.onSelectCommentDiffTarget({
        commentId: "old",
        fileId: "committed:src/new.ts",
        path: "src/old.ts",
        line: 10,
      });
    });
    expect(captured.diffProps?.selectedFileId).toBe("committed:src/new.ts");
    expect(captured.diffProps?.targetLine).toBe(10);

    act(() => {
      captured.diffProps?.onSelectFile("committed:src/next.ts");
    });
    expect(captured.diffProps?.selectedFileId).toBe("committed:src/next.ts");
    expect(captured.diffProps?.targetLine).toBeNull();
  });

  test("ignores non-committed comment diff targets", () => {
    renderContainer();

    act(() => {
      captured.contentProps?.onSelectCommentDiffTarget({
        commentId: "local",
        fileId: "local:src/app.tsx",
        path: "src/app.tsx",
        line: 12,
      });
    });

    expect(captured.diffProps).toBeNull();
  });

  test("does not render stale cached local state when local gateway becomes unavailable", () => {
    mockUseQuery.mockReturnValue({
      data: [makeFile("local-only.ts")],
      error: new Error("stale local error"),
      isSuccess: true,
    });
    renderContainer(makeBranchViewData());

    expect(captured.contentProps?.localFiles).toEqual([]);
    expect(captured.contentProps?.localError).toBeNull();
  });

  test("does not pass stale cached worktree paths to chat after author access is lost", () => {
    mockUseFeatureFlag.mockImplementation((key: string) => {
      if (key === "branch-pr" || key === "interactive-chat") {
        return { enabled: true };
      }
      return { enabled: false };
    });
    mockUseEngineerRoutingSelection.mockReturnValue({
      computeTargetId: "target-1",
      mode: EngineerRoutingMode.CloudRelay,
    });
    mockUseQuery.mockReturnValue({
      data: {
        path: "/stale-author-worktree",
        repoPath: "/stale-author-worktree",
      },
      isSuccess: true,
    });

    renderContainer(makeBranchViewData([], { isAuthor: false }));

    expect(screen.getByTestId("branch-chat")).toBeInTheDocument();
    expect(captured.chatDrawerProps?.worktreePath).toBeNull();
  });

  test("does not pass stale cached worktree paths to chat after routeability is lost", () => {
    mockUseFeatureFlag.mockImplementation((key: string) => {
      if (key === "branch-pr" || key === "interactive-chat") {
        return { enabled: true };
      }
      return { enabled: false };
    });
    mockUseEngineerRoutingSelection.mockReturnValue({
      computeTargetId: null,
      mode: EngineerRoutingMode.CloudRelay,
    });
    mockUseQuery.mockReturnValue({
      data: {
        path: "/stale-route-worktree",
        repoPath: "/stale-route-worktree",
      },
      isSuccess: true,
    });

    renderContainer(makeBranchViewData([], { isAuthor: true }));

    expect(screen.getByTestId("branch-chat")).toBeInTheDocument();
    expect(captured.chatDrawerProps?.worktreePath).toBeNull();
  });

  test("clears a selected local file target when local gateway routeability is revoked", async () => {
    mockUseEngineerRoutingSelection.mockReturnValue({
      computeTargetId: "target-1",
      mode: EngineerRoutingMode.CloudRelay,
    });
    const localFile = makeFile("local-only.ts");
    mockUseQuery.mockImplementation((options: { queryKey?: unknown[] }) => {
      if (options.queryKey?.[0] === "branch-worktree") {
        return {
          data: { path: "/repo", repoPath: "/repo" },
          isSuccess: true,
        };
      }
      return {
        data: [localFile],
        isSuccess: true,
      };
    });
    const result = renderContainer(makeBranchViewData([], { isAuthor: true }));

    act(() => {
      captured.contentProps?.onSelectFile("local:local-only.ts");
    });
    expect(captured.diffProps?.selectedFileId).toBe("local:local-only.ts");
    expect(captured.diffProps?.localDiffContext).not.toBeNull();

    mockUseBranchView.mockReturnValue({
      data: makeBranchViewData([], { isAuthor: false }),
      error: null,
      isLoading: false,
      refetch: vi.fn(),
    });
    mockUseQuery.mockImplementation((options: { queryKey?: unknown[] }) => {
      if (options.queryKey?.[0] === "branch-worktree") {
        return {
          data: { path: "/repo", repoPath: "/repo" },
          isSuccess: true,
        };
      }
      return {
        data: [localFile],
        isSuccess: true,
      };
    });
    await act(() => {
      result.rerender(
        <BranchViewContainer externalLinkId="ext-1" orgSlug="acme" />
      );
    });

    expect(screen.getByTestId("branch-content")).toBeInTheDocument();
    expect(captured.contentProps?.localFiles).toEqual([]);
  });
});
