import {
  CommentKind,
  FileChangeStatus,
  GitHubDiffSide,
  PRReviewCommentState,
  PrCommentAuthorKind,
} from "@repo/api/src/types/branch-view";
import { GitHubPRState } from "@repo/api/src/types/github";
import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BranchViewContainer } from "../branch-view-container";
import type { BranchViewData, BranchViewFile } from "../types";

const mockUseBranchView = vi.hoisted(() => vi.fn());
const mockUseBranchViewFileDiff = vi.hoisted(() => vi.fn());
const mockUseBranchViewSyncControl = vi.hoisted(() => vi.fn());
const mockUseFeatureFlag = vi.hoisted(() => vi.fn());
const mockUseEngineerRoutingSelection = vi.hoisted(() => vi.fn());
const mockUseQuery = vi.hoisted(() => vi.fn());

const asyncDiffViewerState = vi.hoisted(() => ({
  alwaysShowLines: [] as string[][],
  highlightLines: [] as string[][],
}));

const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollIntoView"
);
const originalScrollTo = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollTo"
);
const originalClientHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "clientHeight"
);
const originalScrollHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollHeight"
);

vi.mock("next/navigation", () => ({
  useParams: vi.fn(() => ({ orgSlug: "test-org", id: "ext-1" })),
  usePathname: vi.fn(() => "/test-org/build/ext-1"),
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock("@repo/app/documents/hooks/use-branch-view", () => ({
  useBranchView: (...args: unknown[]) => mockUseBranchView(...args),
  useBranchViewFileDiff: (...args: unknown[]) =>
    mockUseBranchViewFileDiff(...args),
  useBranchViewSyncControl: (...args: unknown[]) =>
    mockUseBranchViewSyncControl(...args),
  useCreateBranchViewConversationComment: () => ({
    isPending: false,
    mutate: vi.fn(),
  }),
  useCreateBranchViewInlineComment: () => ({
    isPending: false,
    mutate: vi.fn(),
  }),
  useDeleteBranchViewConversationComment: () => ({
    isPending: false,
    mutate: vi.fn(),
  }),
  useDeleteBranchViewReviewComment: () => ({
    isPending: false,
    mutate: vi.fn(),
  }),
  useEditBranchViewConversationComment: () => ({
    isPending: false,
    mutate: vi.fn(),
  }),
  useEditBranchViewReviewComment: () => ({
    isPending: false,
    mutate: vi.fn(),
  }),
  useReplyToComment: () => ({ isPending: false, mutate: vi.fn() }),
  useResolveBranchViewReviewThread: () => ({
    isPending: false,
    mutate: vi.fn(),
  }),
  useSyncBranchView: () => ({
    isPending: false,
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
  }),
  useUnresolveBranchViewReviewThread: () => ({
    isPending: false,
    mutate: vi.fn(),
  }),
}));

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: (key: string) => mockUseFeatureFlag(key),
}));

vi.mock("@repo/auth/client", () => ({
  useOrganization: () => ({ organization: { id: "org_test", slug: "org" } }),
  // BranchViewContainer renders useOrgSlug, which reads isSignedIn to gate its
  // dev-only throw; the org slug above means the throw is never reached.
  useAuth: () => ({ isSignedIn: true }),
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
  useElectronDetection: () => ({ detected: false }),
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useCurrentUser: () => ({ data: null }),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

vi.mock("@/lib/markdown", () => ({
  CommentMarkdown: ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
}));

vi.mock("@repo/design-system/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="diff-effective-scroll-container">
      <div data-slot="scroll-area-viewport" data-testid="diff-scroll-viewport">
        {children}
      </div>
    </div>
  ),
}));

vi.mock("@repo/design-system/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@repo/design-system/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("../components/branch-view-header", () => ({
  BranchViewHeader: () => <div data-testid="branch-header" />,
}));

vi.mock("react-diff-viewer-continued", async () => {
  const React = await vi.importActual<typeof import("react")>("react");

  return {
    default: ({
      alwaysShowLines = [],
      highlightLines = [],
      newValue = "",
      renderGutter,
    }: {
      alwaysShowLines?: string[];
      highlightLines?: string[];
      newValue?: string;
      renderGutter?: (data: {
        additionalLineNumber: number | null;
        additionalPrefix: "L" | "R" | null;
        lineNumber: number;
        prefix: "L" | "R";
        styles: Record<string, string>;
        type: string;
        value: string;
      }) => ReactNode;
    }) => {
      const [ready, setReady] = React.useState(false);

      React.useEffect(() => {
        setReady(false);
        const id = globalThis.setTimeout(() => setReady(true), 20);
        return () => globalThis.clearTimeout(id);
      }, [newValue]);

      asyncDiffViewerState.alwaysShowLines.push(alwaysShowLines);
      asyncDiffViewerState.highlightLines.push(highlightLines);

      if (!ready) {
        return (
          <table>
            <tbody />
          </table>
        );
      }

      if (String(newValue).includes("local new content")) {
        return (
          <table>
            <tbody>
              <tr data-line="1">
                <td>
                  <pre>1</pre>
                </td>
                {renderGutter?.({
                  additionalLineNumber: null,
                  additionalPrefix: null,
                  lineNumber: 1,
                  prefix: "L",
                  styles: {},
                  type: "changed",
                  value: "local old content",
                })}
                <td>
                  <pre />
                </td>
                <td className="left">
                  <pre>local old content</pre>
                </td>
                <td>
                  <pre>1</pre>
                </td>
                {renderGutter?.({
                  additionalLineNumber: null,
                  additionalPrefix: null,
                  lineNumber: 1,
                  prefix: "R",
                  styles: {},
                  type: "changed",
                  value: "local new content",
                })}
                <td>
                  <pre />
                </td>
                <td className="right">
                  <pre>local new content</pre>
                </td>
              </tr>
            </tbody>
          </table>
        );
      }

      return (
        <table>
          <tbody>
            <tr data-line="308">
              <td>
                <pre>308</pre>
              </td>
              {renderGutter?.({
                additionalLineNumber: null,
                additionalPrefix: null,
                lineNumber: 308,
                prefix: "L",
                styles: {},
                type: "changed",
                value: "old near first visible hunk",
              })}
              <td>
                <pre />
              </td>
              <td className="left">
                <pre>old near first visible hunk</pre>
              </td>
              <td>
                <pre>308</pre>
              </td>
              {renderGutter?.({
                additionalLineNumber: null,
                additionalPrefix: null,
                lineNumber: 308,
                prefix: "R",
                styles: {},
                type: "changed",
                value: "new near first visible hunk",
              })}
              <td>
                <pre />
              </td>
              <td className="right">
                <pre>new near first visible hunk</pre>
              </td>
            </tr>
            <tr data-line="364" data-target-row="true">
              <td>
                <pre>360</pre>
              </td>
              {renderGutter?.({
                additionalLineNumber: null,
                additionalPrefix: null,
                lineNumber: 360,
                prefix: "L",
                styles: {},
                type: "changed",
                value: "old target context",
              })}
              <td>
                <pre />
              </td>
              <td className="left">
                <pre>old target context</pre>
              </td>
              <td>
                <pre>364</pre>
              </td>
              {renderGutter?.({
                additionalLineNumber: null,
                additionalPrefix: null,
                lineNumber: 364,
                prefix: "R",
                styles: {},
                type: "changed",
                value: "new target context",
              })}
              <td>
                <pre>+</pre>
              </td>
              <td className="right">
                <pre>new target context</pre>
              </td>
            </tr>
          </tbody>
        </table>
      );
    },
    DiffMethod: { WORDS: "WORDS" },
    LineNumberPrefix: { LEFT: "L", RIGHT: "R" },
  };
});

function makeFile(path: string): BranchViewFile {
  return {
    additions: 1,
    deletions: 0,
    patch: null,
    path,
    previousPath: null,
    status: FileChangeStatus.Modified,
  };
}

function makeData(overrides: Partial<BranchViewData> = {}): BranchViewData {
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
      fileCacheFileCount: 1,
      fileCachePatchBytes: 0,
      fileCacheUpdatedAt: null,
      syncStatus: "fresh",
      lastSyncStartedAt: null,
      lastSyncCompletedAt: null,
      lastSyncErrorCode: null,
      lastSyncErrorMessage: null,
    },
    checksStatus: null,
    canCreateConversationComment: false,
    canCreateInlineComment: false,
    comments: [
      {
        author: "Reviewer",
        authorAvatar: null,
        authorKind: PrCommentAuthorKind.User,
        body: "Needs attention.",
        createdAt: "2026-05-01T12:00:00.000Z",
        githubCommentId: "1001",
        htmlUrl: "https://github.com/acme/repo/pull/1#discussion_r1001",
        id: "comment-1",
        inReplyToId: null,
        kind: CommentKind.ReviewComment,
        line: 364,
        path: "src/app.tsx",
        reviewId: "review-1",
        state: PRReviewCommentState.Pending,
      },
    ],
    committedFiles: [makeFile("src/app.tsx")],
    currentPullRequest: {
      id: "pr-detail-1",
      githubId: "1001",
      number: 1,
      title: "Test PR",
      htmlUrl: "https://github.com/acme/repo/pull/1",
      headBranch: "feat/test",
      baseBranch: "main",
      headSha: null,
      state: GitHubPRState.Open,
      isDraft: false,
      checksStatus: null,
      reviewDecision: null,
    },
    externalLinkId: "ext-1",
    externalUrl: "https://github.com/acme/repo/pull/1",
    featureSlug: null,
    featureTitle: null,
    headBranch: "feat/test",
    headSha: null,
    isAuthor: false,
    isDraft: false,
    prHtmlUrl: "",
    prNumber: 1,
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

beforeEach(() => {
  asyncDiffViewerState.alwaysShowLines = [];
  asyncDiffViewerState.highlightLines = [];
  vi.clearAllMocks();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    globalThis.setTimeout(() => callback(0), 0)
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) =>
    globalThis.clearTimeout(id)
  );
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value(this: HTMLElement, options?: ScrollToOptions) {
      this.scrollTop = Number(options?.top ?? 0);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      if (
        this.getAttribute("data-testid") === "diff-effective-scroll-container"
      ) {
        return 400;
      }
      if (this.getAttribute("data-slot") === "scroll-area-viewport") {
        return 900;
      }
      return 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      if (
        this.getAttribute("data-testid") === "diff-effective-scroll-container"
      ) {
        return 1200;
      }
      if (this.getAttribute("data-slot") === "scroll-area-viewport") {
        return 900;
      }
      return 0;
    },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function getMockRect(this: HTMLElement) {
      if (
        this.getAttribute("data-testid") === "diff-effective-scroll-container"
      ) {
        return {
          bottom: 500,
          height: 400,
          left: 0,
          right: 800,
          top: 100,
          width: 800,
          x: 0,
          y: 100,
          toJSON: () => ({}),
        } as DOMRect;
      }
      if (this.getAttribute("data-slot") === "scroll-area-viewport") {
        return {
          bottom: 1000,
          height: 900,
          left: 0,
          right: 800,
          top: 100,
          width: 800,
          x: 0,
          y: 100,
          toJSON: () => ({}),
        } as DOMRect;
      }
      if (this.closest("[data-target-row='true']")) {
        const scrollContainer = document.querySelector<HTMLElement>(
          "[data-testid='diff-effective-scroll-container']"
        );
        const scrollTop = scrollContainer?.scrollTop ?? 0;
        const top = 830 - scrollTop;
        return {
          bottom: top + 20,
          height: 20,
          left: 0,
          right: 800,
          top,
          width: 800,
          x: 0,
          y: top,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return {
        bottom: 0,
        height: 0,
        left: 0,
        right: 0,
        top: 0,
        width: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    }
  );
  mockUseBranchView.mockReturnValue({
    data: makeData(),
    error: null,
    isLoading: false,
  });
  mockUseBranchViewFileDiff.mockReturnValue({
    data: {
      isBinary: false,
      isDeleted: false,
      isNew: false,
      newContent: "new content",
      oldContent: "old content",
      path: "src/app.tsx",
    },
    error: null,
    isLoading: false,
  });
  mockUseBranchViewSyncControl.mockReturnValue({
    isBranchSyncPending: false,
    isCommentsSyncPending: false,
    refreshBranch: vi.fn(),
    refreshComments: vi.fn(),
    syncRetryState: null,
  });
  mockUseFeatureFlag.mockImplementation((key: string) =>
    key === "branch-pr" ? { enabled: true } : { enabled: false }
  );
  mockUseEngineerRoutingSelection.mockReturnValue({
    computeTargetId: null,
    mode: EngineerRoutingMode.CloudRelay,
  });
  mockUseQuery.mockReturnValue({ data: undefined, isSuccess: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalScrollIntoView) {
    Object.defineProperty(
      Element.prototype,
      "scrollIntoView",
      originalScrollIntoView
    );
  } else {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  }
  if (originalScrollTo) {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  }
  if (originalClientHeight) {
    Object.defineProperty(
      HTMLElement.prototype,
      "clientHeight",
      originalClientHeight
    );
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  }
  if (originalScrollHeight) {
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollHeight",
      originalScrollHeight
    );
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
  }
  vi.restoreAllMocks();
});

describe("BranchViewContainer comment diff navigation", () => {
  test("clicking a review-comment file chip waits for rendered diff rows, scrolls, and highlights the requested line", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(<BranchViewContainer externalLinkId="ext-1" orgSlug="acme" />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    });

    await user.click(
      screen.getByRole("button", {
        name: "View src/app.tsx at line 364",
      })
    );

    const viewport = await screen.findByTestId("diff-scroll-viewport");
    const scrollContainer = await screen.findByTestId(
      "diff-effective-scroll-container"
    );

    await waitFor(() => expect(scrollContainer.scrollTop).toBeGreaterThan(0));

    expect(asyncDiffViewerState.alwaysShowLines).toContainEqual(["R-364"]);
    expect(asyncDiffViewerState.highlightLines).toContainEqual([
      "L-360",
      "R-364",
    ]);
    expect(viewport.scrollTop).toBe(0);
    const viewportRect = scrollContainer.getBoundingClientRect();
    const rowRect = document
      .querySelector<HTMLElement>("[data-target-row='true']")
      ?.getBoundingClientRect();
    expect(rowRect).toBeDefined();
    expect(rowRect?.top).toBeGreaterThanOrEqual(viewportRect.top);
    expect(rowRect?.bottom).toBeLessThanOrEqual(viewportRect.bottom);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  test("clicking a local CloudRelay row opens the selected local diff text", async () => {
    const user = userEvent.setup();
    mockUseEngineerRoutingSelection.mockReturnValue({
      computeTargetId: "target-1",
      mode: EngineerRoutingMode.CloudRelay,
    });
    mockUseBranchView.mockReturnValue({
      data: {
        ...makeData(),
        isAuthor: true,
      },
      error: null,
      isLoading: false,
    });
    mockUseQuery.mockImplementation((options: { queryKey?: unknown[] }) => {
      if (options.queryKey?.[0] === "branch-worktree") {
        return {
          data: { path: "/repo-pr-1", repoPath: "/repo-pr-1" },
          isSuccess: true,
        };
      }
      if (options.queryKey?.[0] === "branch-local-changes") {
        return {
          data: [
            {
              additions: 2,
              deletions: 1,
              patch: null,
              path: "src/local.ts",
              previousPath: null,
              status: FileChangeStatus.Modified,
            },
          ],
          error: null,
          isSuccess: true,
        };
      }
      if (options.queryKey?.[0] === "branch-local-file-diff") {
        return {
          data: {
            isBinary: false,
            isDeleted: false,
            isNew: false,
            newContent: "local new content",
            oldContent: "local old content",
            path: "src/local.ts",
          },
          error: null,
          isLoading: false,
        };
      }
      return { data: undefined, isSuccess: false };
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(<BranchViewContainer externalLinkId="ext-1" orgSlug="acme" />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    });

    await user.click(screen.getByRole("button", { name: "src/local.ts" }));

    expect(screen.getByText("src/local.ts")).toBeInTheDocument();
    expect(await screen.findByText("local new content")).toBeInTheDocument();
  });

  test("does not render inline review cards while opening a local diff with matching AI review comments", async () => {
    const user = userEvent.setup();
    mockUseEngineerRoutingSelection.mockReturnValue({
      computeTargetId: "target-1",
      mode: EngineerRoutingMode.CloudRelay,
    });
    mockUseBranchView.mockReturnValue({
      data: makeData({
        comments: [
          {
            author: "closedloop-ai-stage",
            authorAvatar: null,
            authorKind: PrCommentAuthorKind.Bot,
            body: "AI finding must not render inline on local diff",
            createdAt: "2026-05-01T12:00:00.000Z",
            githubCommentId: "1002",
            htmlUrl: "https://github.com/acme/repo/pull/1#discussion_r1002",
            id: "comment-2",
            inReplyToId: null,
            kind: CommentKind.ReviewComment,
            line: 1,
            path: "src/local.ts",
            reviewId: "review-2",
            side: GitHubDiffSide.Right,
            state: PRReviewCommentState.Pending,
          },
        ],
        isAuthor: true,
      }),
      error: null,
      isLoading: false,
    });
    mockUseQuery.mockImplementation((options: { queryKey?: unknown[] }) => {
      if (options.queryKey?.[0] === "branch-worktree") {
        return {
          data: { path: "/repo-pr-1", repoPath: "/repo-pr-1" },
          isSuccess: true,
        };
      }
      if (options.queryKey?.[0] === "branch-local-changes") {
        return {
          data: [
            {
              additions: 2,
              deletions: 1,
              patch: null,
              path: "src/local.ts",
              previousPath: null,
              status: FileChangeStatus.Modified,
            },
          ],
          error: null,
          isSuccess: true,
        };
      }
      if (options.queryKey?.[0] === "branch-local-file-diff") {
        return {
          data: {
            isBinary: false,
            isDeleted: false,
            isNew: false,
            newContent: "local new content",
            oldContent: "local old content",
            path: "src/local.ts",
          },
          error: null,
          isLoading: false,
        };
      }
      return { data: undefined, isSuccess: false };
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(<BranchViewContainer externalLinkId="ext-1" orgSlug="acme" />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    });

    await user.click(screen.getByRole("button", { name: "src/local.ts" }));

    expect(await screen.findByText("local new content")).toBeInTheDocument();
    expect(
      screen.queryByText("AI finding must not render inline on local diff")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(`inline-comment-${GitHubDiffSide.Right}-1`)
    ).not.toBeInTheDocument();
  });
});
