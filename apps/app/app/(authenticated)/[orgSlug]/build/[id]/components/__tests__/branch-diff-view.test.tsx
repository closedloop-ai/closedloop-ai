import {
  type BranchViewComment,
  BranchViewCommentAction,
  BranchViewCommentActionRecovery,
  type BranchViewCommentActionResult,
  BranchViewCommentActionResultCode,
  BranchViewCommentWriteIdentityStatus,
  CommentKind,
  FileChangeStatus,
  GitHubDiffSide,
  PRReviewCommentState,
  PrCommentAuthorKind,
} from "@repo/api/src/types/branch-view";
import { toast } from "@repo/design-system/components/ui/sonner";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type {
  ComponentProps,
  MouseEvent,
  ReactElement,
  ReactNode,
} from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ReviewFindingPriority } from "@/lib/engineer/review-finding-priority";
import type { BranchViewFileDiff } from "../../types";
import { type ChangedFileEntry, FileSection } from "../../types";
import { BranchDiffView } from "../branch-diff-view";
import { BranchViewCommentIdentityBlockerProvider } from "../branch-view-comment-identity-blocker-store";
import { buildCommentBody } from "./review-comment-body-fixture";

const diffViewerMockState = vi.hoisted(() => ({
  alwaysShowLines: [] as string[][],
  highlightLines: [] as string[][],
  styles: [] as DiffViewerStyleSnapshot[],
}));

const mockUseBranchViewFileDiff = vi.hoisted(() => vi.fn());
const mockCreateInlineComment = vi.hoisted(() => ({
  isPending: false,
  mutate: vi.fn(),
}));
const mockResolveReviewThread = vi.hoisted(() => ({ mutate: vi.fn() }));
const mockUnresolveReviewThread = vi.hoisted(() => ({ mutate: vi.fn() }));
const mockReplyToComment = vi.hoisted(() => ({
  isPending: false,
  mutate: vi.fn(),
}));
const CONNECT_GITHUB_LINK_NAME = /Connect GitHub/u;
const RECONNECT_GITHUB_LINK_NAME = /Reconnect GitHub/u;
const originalClientHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "clientHeight"
);
const originalScrollHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollHeight"
);

type DiffViewerStyleSnapshot = {
  variables?: {
    light?: Record<string, string>;
    dark?: Record<string, string>;
  };
};

vi.mock("@repo/app/documents/hooks/use-branch-view", () => ({
  useCreateBranchViewInlineComment: () => ({
    isPending: mockCreateInlineComment.isPending,
    mutate: mockCreateInlineComment.mutate,
  }),
  useReplyToComment: () => ({
    isPending: mockReplyToComment.isPending,
    mutate: mockReplyToComment.mutate,
  }),
  useResolveBranchViewReviewThread: () => mockResolveReviewThread,
  useUnresolveBranchViewReviewThread: () => mockUnresolveReviewThread,
  useBranchViewFileDiff: (...args: unknown[]) =>
    mockUseBranchViewFileDiff(...args),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    warning: vi.fn(),
  },
}));

vi.mock("react-diff-viewer-continued", () => ({
  default: ({
    alwaysShowLines = [],
    highlightLines = [],
    newValue = "",
    onLineNumberClick,
    renderGutter,
    styles,
  }: {
    alwaysShowLines?: string[];
    highlightLines?: string[];
    newValue?: string;
    onLineNumberClick?: (
      lineId: string,
      event: MouseEvent<HTMLTableCellElement>
    ) => void;
    renderGutter?: (data: {
      additionalLineNumber: number | null;
      additionalPrefix: "L" | "R" | null;
      lineNumber: number;
      prefix: "L" | "R";
      styles: Record<string, string>;
      type: string;
      value: string;
    }) => ReactElement;
    styles?: DiffViewerStyleSnapshot;
  }) => {
    diffViewerMockState.alwaysShowLines.push(alwaysShowLines);
    diffViewerMockState.highlightLines.push(highlightLines);
    diffViewerMockState.styles.push(styles ?? {});
    if (String(newValue).includes("right-364-left-360")) {
      return (
        <table>
          <tbody>
            <tr data-line="364">
              <td>
                <button
                  data-testid="left-line-360"
                  onClick={(event) =>
                    onLineNumberClick?.(
                      "L-360",
                      event as unknown as MouseEvent<HTMLTableCellElement>
                    )
                  }
                  type="button"
                >
                  <pre>360</pre>
                </button>
              </td>
              {renderGutter?.({
                additionalLineNumber: null,
                additionalPrefix: null,
                lineNumber: 360,
                prefix: "L",
                styles: {},
                type: "changed",
                value: "old mapped target",
              })}
              <td>
                <pre />
              </td>
              <td className="left">
                <pre>old mapped target</pre>
              </td>
              <td>
                <button
                  data-testid="right-line-364"
                  onClick={(event) =>
                    onLineNumberClick?.(
                      "R-364",
                      event as unknown as MouseEvent<HTMLTableCellElement>
                    )
                  }
                  type="button"
                >
                  <pre>364</pre>
                </button>
              </td>
              {renderGutter?.({
                additionalLineNumber: null,
                additionalPrefix: null,
                lineNumber: 364,
                prefix: "R",
                styles: {},
                type: "changed",
                value: "new mapped target",
              })}
              <td>
                <pre>+</pre>
              </td>
              <td className="right">
                <pre>new mapped target</pre>
              </td>
            </tr>
          </tbody>
        </table>
      );
    }
    return (
      <table>
        <tbody>
          {String(newValue)
            .split("\n")
            .map((line, index) => {
              const lineNumber = index + 1;
              return (
                <tr data-line={lineNumber} key={`${lineNumber}:${line}`}>
                  <td>
                    <button
                      data-testid={`left-line-${lineNumber}`}
                      onClick={(event) =>
                        onLineNumberClick?.(
                          `L-${lineNumber}`,
                          event as unknown as MouseEvent<HTMLTableCellElement>
                        )
                      }
                      type="button"
                    >
                      <pre>{lineNumber}</pre>
                    </button>
                  </td>
                  {renderGutter?.({
                    additionalLineNumber: null,
                    additionalPrefix: null,
                    lineNumber,
                    prefix: "L",
                    styles: {},
                    type: "changed",
                    value: line,
                  })}
                  <td>
                    <pre />
                  </td>
                  <td className="left">
                    <pre>{line}</pre>
                  </td>
                  <td>
                    <button
                      data-testid={`right-line-${lineNumber}`}
                      onClick={(event) =>
                        onLineNumberClick?.(
                          `R-${lineNumber}`,
                          event as unknown as MouseEvent<HTMLTableCellElement>
                        )
                      }
                      type="button"
                    >
                      <pre>{lineNumber}</pre>
                    </button>
                  </td>
                  {renderGutter?.({
                    additionalLineNumber: null,
                    additionalPrefix: null,
                    lineNumber,
                    prefix: "R",
                    styles: {},
                    type: "changed",
                    value: line,
                  })}
                  <td>
                    <pre />
                  </td>
                  <td className="right">
                    <pre>{line}</pre>
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
    );
  },
  DiffMethod: { WORDS: "WORDS" },
  LineNumberPrefix: { LEFT: "L", RIGHT: "R" },
}));

function makeEntry(path: string): ChangedFileEntry {
  return {
    file: {
      additions: 3,
      deletions: 1,
      path,
      previousPath: null,
      status: FileChangeStatus.Modified,
    },
    fileId: `committed:${path}`,
    section: FileSection.Committed,
  };
}

function makeLocalEntry(path: string): ChangedFileEntry {
  return {
    file: {
      additions: 3,
      deletions: 1,
      path,
      previousPath: null,
      status: FileChangeStatus.Modified,
    },
    fileId: `local:${path}`,
    section: FileSection.Local,
  };
}

function makeInlineComment(
  overrides: Partial<BranchViewComment> = {}
): BranchViewComment {
  return {
    author: "reviewer-user",
    authorAvatar: null,
    authorKind: PrCommentAuthorKind.User,
    body: "Inline comment body",
    createdAt: "2026-05-22T12:00:00.000Z",
    githubCommentId: "9001",
    htmlUrl: "https://github.com/acme/repo/pull/1#discussion_r9001",
    id: "comment-9001",
    inReplyToId: null,
    kind: CommentKind.ReviewComment,
    line: 2,
    path: "src/app.tsx",
    reviewId: "review-1",
    side: GitHubDiffSide.Right,
    state: PRReviewCommentState.Pending,
    ...overrides,
  };
}

function diff(overrides: Partial<BranchViewFileDiff> = {}) {
  return {
    data: {
      isBinary: false,
      isDeleted: false,
      isNew: false,
      newContent: ["one", "two", "three"].join("\n"),
      oldContent: ["one", "old", "three"].join("\n"),
      path: "src/app.tsx",
      ...overrides,
    },
    error: null,
    isLoading: false,
  };
}

function renderDiffView(props: {
  allFiles?: ChangedFileEntry[];
  targetActivationId?: number | null;
  targetLine?: number | null;
  selectedFileId?: string;
  canCreateInlineComment?: boolean;
  commentPromptEligibility?: ComponentProps<
    typeof BranchDiffView
  >["commentPromptEligibility"];
  comments?: BranchViewComment[];
  expectedHeadSha?: string | null;
  branchHeadSha?: string | null;
  localDiffContext?: ComponentProps<typeof BranchDiffView>["localDiffContext"];
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <BranchDiffView
      allFiles={
        props.allFiles ?? [makeEntry("src/app.tsx"), makeEntry("src/next.ts")]
      }
      branchHeadSha={props.branchHeadSha}
      canCreateInlineComment={props.canCreateInlineComment}
      commentPromptEligibility={props.commentPromptEligibility}
      comments={props.comments}
      expectedHeadSha={props.expectedHeadSha}
      externalLinkId="ext-1"
      localDiffContext={props.localDiffContext}
      onClose={vi.fn()}
      onSelectFile={vi.fn()}
      selectedFileId={props.selectedFileId ?? "committed:src/app.tsx"}
      targetActivationId={props.targetActivationId ?? null}
      targetLine={props.targetLine ?? null}
    />,
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <BranchViewCommentIdentityBlockerProvider
          buildId="branch-artifact-1"
          orgSlug="acme"
        >
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
        </BranchViewCommentIdentityBlockerProvider>
      ),
    }
  );
}

function mockDiffViewportGeometry() {
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return this.getAttribute("data-slot") === "scroll-area-viewport"
        ? 400
        : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return this.getAttribute("data-slot") === "scroll-area-viewport"
        ? 1200
        : 0;
    },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function getMockRect(this: HTMLElement) {
      if (this.getAttribute("data-slot") === "scroll-area-viewport") {
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
      if (
        this instanceof HTMLTableRowElement &&
        (this.dataset.line === "2" || this.dataset.line === "364")
      ) {
        return {
          bottom: 850,
          height: 20,
          left: 0,
          right: 800,
          top: 830,
          width: 800,
          x: 0,
          y: 830,
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
}

beforeEach(() => {
  vi.useFakeTimers();
  diffViewerMockState.alwaysShowLines = [];
  diffViewerMockState.highlightLines = [];
  diffViewerMockState.styles = [];
  mockCreateInlineComment.isPending = false;
  mockCreateInlineComment.mutate.mockReset();
  mockResolveReviewThread.mutate.mockReset();
  mockUnresolveReviewThread.mutate.mockReset();
  mockReplyToComment.isPending = false;
  mockReplyToComment.mutate.mockReset();
  vi.mocked(toast.warning).mockReset();
  mockUseBranchViewFileDiff.mockReturnValue(diff());
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    globalThis.setTimeout(() => callback(0), 0)
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) =>
    globalThis.clearTimeout(id)
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalClientHeightDescriptor) {
    Object.defineProperty(
      HTMLElement.prototype,
      "clientHeight",
      originalClientHeightDescriptor
    );
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  }
  if (originalScrollHeightDescriptor) {
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollHeight",
      originalScrollHeightDescriptor
    );
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
  }
});

describe("BranchDiffView target line navigation", () => {
  test("renders the legacy inline create connect prompt with the canonical href", () => {
    renderDiffView({
      canCreateInlineComment: false,
      commentPromptEligibility: {
        createConversation: { prompt: false },
        createInline: {
          identityBlocker: {
            status: BranchViewCommentWriteIdentityStatus.Missing,
          },
          prompt: true,
        },
      },
    });

    expect(
      screen.getByTestId("branch-view-github-identity-prompt")
    ).toHaveTextContent("Connect GitHub to comment");
    expect(
      screen.getByRole("link", { name: CONNECT_GITHUB_LINK_NAME })
    ).toHaveAttribute(
      "href",
      "/api/integrations/github?returnTo=%2Facme%2Fbuild%2Fbranch-artifact-1"
    );
  });

  test("does not render the legacy inline create prompt for non-identity blockers", () => {
    renderDiffView({
      canCreateInlineComment: false,
      commentPromptEligibility: {
        createConversation: { prompt: false },
        createInline: { prompt: false },
      },
    });

    expect(
      screen.queryByTestId("branch-view-github-identity-prompt")
    ).not.toBeInTheDocument();
  });

  test("renders legacy inline reply and management reconnect prompts outside controls", () => {
    const blockedThread = makeInlineComment({
      actionPromptEligibility: {
        delete: { prompt: false },
        edit: { prompt: false },
        reply: {
          identityBlocker: {
            status: BranchViewCommentWriteIdentityStatus.Expired,
          },
          prompt: true,
        },
        resolve: {
          identityBlocker: {
            status: BranchViewCommentWriteIdentityStatus.Revoked,
          },
          prompt: true,
        },
        unresolve: { prompt: false },
      },
      canReply: false,
      id: "blocked-thread",
      line: 1,
    });

    renderDiffView({ comments: [blockedThread] });

    const prompts = screen.getAllByTestId("branch-view-github-identity-prompt");
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(prompt).toHaveTextContent("Reconnect GitHub to comment");
      expect(
        within(prompt).getByRole("link", { name: RECONNECT_GITHUB_LINK_NAME })
      ).toHaveAttribute(
        "href",
        "/api/integrations/github?returnTo=%2Facme%2Fbuild%2Fbranch-artifact-1"
      );
      expect(prompt.closest("button")).toBeNull();
    }
  });

  test("scrolls the diff viewport to a valid target line and keeps the target highlight active", () => {
    const scrollToSpy = vi.fn(function scrollTo(
      this: HTMLElement,
      options?: ScrollToOptions
    ) {
      this.scrollTop = Number(options?.top ?? 0);
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollToSpy,
    });
    mockDiffViewportGeometry();

    renderDiffView({ targetActivationId: 1, targetLine: 2 });

    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(scrollToSpy).toHaveBeenCalledWith({ top: 540 });
    expect(diffViewerMockState.alwaysShowLines.at(-1)).toEqual(["R-2"]);
    expect(diffViewerMockState.highlightLines.at(-1)).toEqual(["L-2", "R-2"]);

    act(() => {
      vi.advanceTimersByTime(1800);
    });

    expect(diffViewerMockState.highlightLines.at(-1)).toEqual(["L-2", "R-2"]);
  });

  test("highlights both sides of a split diff row when the target right line maps to a different left line", () => {
    mockUseBranchViewFileDiff.mockReturnValue(
      diff({ newContent: "right-364-left-360", oldContent: "mapped old" })
    );
    mockDiffViewportGeometry();

    renderDiffView({ targetActivationId: 1, targetLine: 364 });

    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(diffViewerMockState.alwaysShowLines.at(-1)).toEqual(["R-364"]);
    expect(diffViewerMockState.highlightLines.at(-1)).toEqual([
      "L-360",
      "R-364",
    ]);
  });

  test("uses target-colored highlight variables instead of the neutral foreground grey", () => {
    renderDiffView({ targetActivationId: 1, targetLine: 2 });

    const styles = diffViewerMockState.styles.at(-1);
    expect(styles?.variables?.light?.highlightBackground).toContain("#facc15");
    expect(styles?.variables?.light?.highlightGutterBackground).toContain(
      "#facc15"
    );
    expect(styles?.variables?.dark?.highlightBackground).toContain("#fb923c");
    expect(styles?.variables?.dark?.highlightGutterBackground).toContain(
      "#fb923c"
    );
    expect(styles?.variables?.light?.highlightBackground).not.toContain(
      "var(--foreground)"
    );
    expect(styles?.variables?.dark?.highlightBackground).not.toContain(
      "var(--foreground)"
    );
  });

  test("selects a clicked right-side line number with row-wide highlight", () => {
    renderDiffView({});

    fireEvent.click(screen.getByTestId("right-line-2"));

    expect(diffViewerMockState.highlightLines.at(-1)).toEqual(["L-2", "R-2"]);
  });

  test("clears the selection when the already-selected line is clicked again", () => {
    renderDiffView({});

    fireEvent.click(screen.getByTestId("right-line-2"));
    expect(diffViewerMockState.highlightLines.at(-1)).toEqual(["L-2", "R-2"]);

    fireEvent.click(screen.getByTestId("right-line-2"));
    expect(diffViewerMockState.highlightLines.at(-1)).toEqual([]);
  });

  test("replaces the previous selected row when another line number is clicked", () => {
    renderDiffView({});

    fireEvent.click(screen.getByTestId("right-line-2"));
    expect(diffViewerMockState.highlightLines.at(-1)).toEqual(["L-2", "R-2"]);

    fireEvent.click(screen.getByTestId("left-line-3"));

    expect(diffViewerMockState.highlightLines.at(-1)).toEqual(["L-3", "R-3"]);
  });

  test("selects the rendered split row when clicked left and right line numbers differ", () => {
    mockUseBranchViewFileDiff.mockReturnValue(
      diff({ newContent: "right-364-left-360", oldContent: "mapped old" })
    );

    renderDiffView({});

    fireEvent.click(screen.getByTestId("left-line-360"));

    expect(diffViewerMockState.highlightLines.at(-1)).toEqual([
      "L-360",
      "R-364",
    ]);
  });

  test("manual selection replaces chip-selected highlight and persists across later mutations and rerenders", async () => {
    mockDiffViewportGeometry();
    const { rerender } = renderDiffView({
      targetActivationId: 1,
      targetLine: 2,
    });

    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(diffViewerMockState.highlightLines.at(-1)).toEqual(["L-2", "R-2"]);

    fireEvent.click(screen.getByTestId("right-line-3"));

    expect(diffViewerMockState.alwaysShowLines.at(-1)).toEqual(["R-2"]);
    expect(diffViewerMockState.highlightLines.at(-1)).toEqual(["L-3", "R-3"]);

    const table = screen.getByTestId("right-line-3").closest("table");
    await act(async () => {
      table?.append(document.createElement("caption"));
      await Promise.resolve();
      vi.advanceTimersByTime(0);
    });

    expect(diffViewerMockState.highlightLines.at(-1)).toEqual(["L-3", "R-3"]);

    rerender(
      <BranchDiffView
        allFiles={[makeEntry("src/app.tsx"), makeEntry("src/next.ts")]}
        externalLinkId="ext-1"
        onClose={vi.fn()}
        onSelectFile={vi.fn()}
        selectedFileId="committed:src/app.tsx"
        targetActivationId={1}
        targetLine={2}
      />
    );

    expect(diffViewerMockState.alwaysShowLines.at(-1)).toEqual(["R-2"]);
    expect(diffViewerMockState.highlightLines.at(-1)).toEqual(["L-3", "R-3"]);
  });

  test("new chip activation reselects the chip target after manual selection", () => {
    mockDiffViewportGeometry();
    const { rerender } = renderDiffView({
      targetActivationId: 1,
      targetLine: 2,
    });

    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(diffViewerMockState.highlightLines.at(-1)).toEqual(["L-2", "R-2"]);

    fireEvent.click(screen.getByTestId("right-line-3"));

    expect(diffViewerMockState.highlightLines.at(-1)).toEqual(["L-3", "R-3"]);

    rerender(
      <BranchDiffView
        allFiles={[makeEntry("src/app.tsx"), makeEntry("src/next.ts")]}
        externalLinkId="ext-1"
        onClose={vi.fn()}
        onSelectFile={vi.fn()}
        selectedFileId="committed:src/app.tsx"
        targetActivationId={2}
        targetLine={2}
      />
    );

    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(diffViewerMockState.highlightLines.at(-1)).toEqual(["L-2", "R-2"]);
  });

  test("clears the target highlight when there is no active target line", () => {
    mockDiffViewportGeometry();
    const { rerender } = renderDiffView({
      targetActivationId: 1,
      targetLine: 2,
    });

    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(diffViewerMockState.highlightLines.at(-1)).toEqual(["L-2", "R-2"]);

    rerender(
      <BranchDiffView
        allFiles={[makeEntry("src/app.tsx"), makeEntry("src/next.ts")]}
        externalLinkId="ext-1"
        onClose={vi.fn()}
        onSelectFile={vi.fn()}
        selectedFileId="committed:src/app.tsx"
        targetActivationId={2}
        targetLine={null}
      />
    );

    expect(diffViewerMockState.highlightLines.at(-1)).toEqual([]);
  });

  test("reruns scroll and highlight for the same file and line when activation id changes", () => {
    const scrollToSpy = vi.fn(function scrollTo(
      this: HTMLElement,
      options?: ScrollToOptions
    ) {
      this.scrollTop = Number(options?.top ?? 0);
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollToSpy,
    });
    mockDiffViewportGeometry();
    const { rerender } = renderDiffView({
      targetActivationId: 1,
      targetLine: 2,
    });

    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(scrollToSpy).toHaveBeenCalledTimes(1);

    rerender(
      <BranchDiffView
        allFiles={[makeEntry("src/app.tsx"), makeEntry("src/next.ts")]}
        externalLinkId="ext-1"
        onClose={vi.fn()}
        onSelectFile={vi.fn()}
        selectedFileId="committed:src/app.tsx"
        targetActivationId={2}
        targetLine={2}
      />
    );

    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(scrollToSpy).toHaveBeenCalledTimes(2);
    expect(diffViewerMockState.highlightLines.at(-1)).toEqual(["L-2", "R-2"]);
  });

  test("scrolls the viewport to top without highlighting when the target line is missing", () => {
    const scrollToSpy = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollToSpy,
    });

    renderDiffView({ targetActivationId: 1, targetLine: 99 });

    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(scrollToSpy).toHaveBeenCalledWith({ top: 0 });
    expect(diffViewerMockState.highlightLines.at(-1)).toEqual([]);
  });

  test("keeps binary file rendering unchanged and skips scroll/highlight", () => {
    const scrollIntoViewSpy = vi.spyOn(Element.prototype, "scrollIntoView");
    mockUseBranchViewFileDiff.mockReturnValue(diff({ isBinary: true }));

    renderDiffView({ targetActivationId: 1, targetLine: 2 });

    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(screen.getByText("Binary file not shown")).toBeInTheDocument();
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    expect(diffViewerMockState.highlightLines).toEqual([]);
  });

  test("opens the inline composer and dispatches the exact single-line payload", () => {
    renderDiffView({
      canCreateInlineComment: true,
      expectedHeadSha: "file-cache-head-sha",
    });

    fireEvent.click(screen.getByTestId("right-line-2"));
    expect(screen.getByTestId("inline-comment-composer")).toBeInTheDocument();
    expect(screen.getByTestId("inline-comment-composer").closest("tr")).toBe(
      screen.getByTestId("right-line-2").closest("tr")
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "  Inline feedback  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(mockCreateInlineComment.mutate).toHaveBeenCalledWith(
      {
        body: "Inline feedback",
        expectedHeadSha: "file-cache-head-sha",
        line: 2,
        path: "src/app.tsx",
        side: GitHubDiffSide.Right,
      },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });

  test("cancelling the inline composer clears the line selection", () => {
    renderDiffView({
      canCreateInlineComment: true,
      expectedHeadSha: "file-cache-head-sha",
    });

    fireEvent.click(screen.getByTestId("right-line-2"));
    expect(screen.getByTestId("inline-comment-composer")).toBeInTheDocument();
    expect(diffViewerMockState.highlightLines.at(-1)).toEqual(["L-2", "R-2"]);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(
      screen.queryByTestId("inline-comment-composer")
    ).not.toBeInTheDocument();
    expect(diffViewerMockState.highlightLines.at(-1)).toEqual([]);
  });

  test("shift-clicking extends the selection into a multi-line range and submits start/end anchors", () => {
    renderDiffView({
      canCreateInlineComment: true,
      expectedHeadSha: "file-cache-head-sha",
    });

    fireEvent.click(screen.getByTestId("right-line-1"));
    fireEvent.click(screen.getByTestId("right-line-3"), { shiftKey: true });

    expect(diffViewerMockState.highlightLines.at(-1)).toEqual([
      "R-1",
      "R-2",
      "R-3",
    ]);
    expect(screen.getByText("Commenting on lines 1 to 3")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Range feedback" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(mockCreateInlineComment.mutate).toHaveBeenCalledWith(
      {
        body: "Range feedback",
        expectedHeadSha: "file-cache-head-sha",
        line: 3,
        path: "src/app.tsx",
        side: GitHubDiffSide.Right,
        startLine: 1,
        startSide: GitHubDiffSide.Right,
      },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });

  test("renders a range bracket and line label for an existing multi-line comment", () => {
    renderDiffView({
      comments: [
        makeInlineComment({
          body: "Range comment body",
          githubCommentId: "8201",
          id: "range-comment",
          line: 3,
          side: GitHubDiffSide.Right,
          startLine: 1,
          startSide: GitHubDiffSide.Right,
        }),
      ],
    });

    expect(screen.getByTestId("inline-comment-RIGHT-3")).toHaveTextContent(
      "Lines 1 to 3"
    );
    // A bracket segment renders in the right gutter for each line in the range.
    expect(
      screen.getAllByTestId("inline-comment-range-bracket").length
    ).toBeGreaterThanOrEqual(3);
  });

  test("keeps the inline composer open and surfaces projection failures", () => {
    renderDiffView({
      canCreateInlineComment: true,
      expectedHeadSha: "file-cache-head-sha",
    });

    fireEvent.click(screen.getByTestId("right-line-2"));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "  Projection gap  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    const options = mockCreateInlineComment.mutate.mock.calls[0]?.[1] as {
      onSuccess: (result: BranchViewCommentActionResult) => void;
    };
    options.onSuccess({
      action: BranchViewCommentAction.CreateInline,
      code: BranchViewCommentActionResultCode.GithubProjectionFailed,
      github: { commentId: "9001" },
      message: "GitHub succeeded, but branch-view projection failed",
      recovery: BranchViewCommentActionRecovery.BranchViewSync,
      success: false,
    });

    expect(toast.warning).toHaveBeenCalledWith(
      "Comment saved on GitHub, but this view could not update yet",
      {
        description:
          "Use the header refresh to update PR status and comments from GitHub.",
      }
    );
    expect(screen.getByTestId("inline-comment-composer")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("  Projection gap  ");
  });

  test("does not open the inline composer when required gates are missing", () => {
    renderDiffView({
      canCreateInlineComment: true,
      expectedHeadSha: null,
    });

    fireEvent.click(screen.getByTestId("right-line-2"));

    expect(
      screen.queryByTestId("inline-comment-composer")
    ).not.toBeInTheDocument();
    expect(mockCreateInlineComment.mutate).not.toHaveBeenCalled();
  });

  test("does not open the inline composer when server capability is unavailable", () => {
    renderDiffView({
      canCreateInlineComment: false,
      expectedHeadSha: "file-cache-head-sha",
    });

    fireEvent.click(screen.getByTestId("right-line-2"));

    expect(
      screen.queryByTestId("inline-comment-composer")
    ).not.toBeInTheDocument();
    expect(mockCreateInlineComment.mutate).not.toHaveBeenCalled();
  });

  test("renders only side-aware review comments for the current file", () => {
    renderDiffView({
      comments: [
        makeInlineComment({
          body: "Right side note",
          githubCommentId: "8101",
          id: "right-comment",
          line: 2,
          side: GitHubDiffSide.Right,
        }),
        makeInlineComment({
          body: "Left side note",
          githubCommentId: "8102",
          id: "left-comment",
          line: 1,
          side: GitHubDiffSide.Left,
        }),
        makeInlineComment({
          body: "Different file note",
          githubCommentId: "8103",
          id: "other-file-comment",
          path: "src/other.ts",
        }),
        makeInlineComment({
          body: "Missing side note",
          githubCommentId: "8104",
          id: "missing-side-comment",
          side: null,
        }),
        makeInlineComment({
          body: "Issue comment note",
          id: "issue-comment",
          kind: CommentKind.IssueComment,
        }),
      ],
    });

    expect(screen.getByTestId("inline-comment-RIGHT-2")).toHaveTextContent(
      "Right side note"
    );
    expect(screen.getByTestId("inline-comment-LEFT-1")).toHaveTextContent(
      "Left side note"
    );
    expect(screen.getByTestId("inline-comment-RIGHT-2").closest("tr")).toBe(
      screen.getByTestId("right-line-2").closest("tr")
    );
    expect(screen.getByTestId("inline-comment-LEFT-1").closest("tr")).toBe(
      screen.getByTestId("left-line-1").closest("tr")
    );
    expect(screen.queryByText("Different file note")).not.toBeInTheDocument();
    expect(screen.queryByText("Missing side note")).not.toBeInTheDocument();
    expect(screen.queryByText("Issue comment note")).not.toBeInTheDocument();
  });

  test("hides injected metadata markers from inline review comment bodies", () => {
    renderDiffView({
      comments: [
        makeInlineComment({
          body: 'Looks good to me.\n\n<!-- closedloop-code-review: {"version":1,"kind":"visibility-test"} -->',
          id: "metadata-comment",
          line: 2,
          side: GitHubDiffSide.Right,
        }),
      ],
    });

    const card = screen.getByTestId("inline-comment-RIGHT-2");
    expect(card).toHaveTextContent("Looks good to me.");
    expect(card.textContent).not.toContain("closedloop-code-review");
  });

  test("renders current AI review findings as row markers with read-only expanded cards", () => {
    renderDiffView({
      comments: [
        makeInlineComment({
          anchorCommitSha: "file-cache-head-sha",
          author: "closedloop-ai[bot]",
          authorKind: PrCommentAuthorKind.Bot,
          body: [
            "**[P2]** Avoid stale placement",
            "",
            "> **Suggestion:** Compare against the file-cache SHA.",
            "Confidence: high",
            "LOC savings: 12",
          ].join("\n"),
          canReply: true,
          canResolve: true,
          id: "finding-comment",
          line: 2,
          resolvable: true,
          side: GitHubDiffSide.Right,
        }),
      ],
      expectedHeadSha: "file-cache-head-sha",
    });

    const marker = screen.getByTestId("inline-finding-marker-RIGHT-2");
    expect(marker.closest("tr")).toBe(
      screen.getByTestId("right-line-2").closest("tr")
    );
    fireEvent.click(marker);

    expect(screen.getAllByText("Avoid stale placement")).toHaveLength(2);
    expect(
      screen.getByText("Suggestion: Compare against the file-cache SHA.")
    ).toBeInTheDocument();
    expect(screen.getByText("Confidence: high")).toBeInTheDocument();
    expect(screen.getByText("LOC savings: 12")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
  });

  test("renders malicious oversized finding bodies through markdown without executable HTML or javascript links", () => {
    const unsafeBody = [
      "**[P1]** Unsafe finding body",
      "",
      "<script>globalThis.__branchFindingXss = true</script>",
      '<img src="x" onerror="globalThis.__branchFindingXss = true">',
      "[unsafe link](javascript:globalThis.__branchFindingXss=true)",
      "x".repeat(9000),
    ].join("\n");
    const { container } = renderDiffView({
      comments: [
        makeInlineComment({
          anchorCommitSha: "file-cache-head-sha",
          author: "closedloop-ai[bot]",
          authorKind: PrCommentAuthorKind.Bot,
          body: unsafeBody,
          id: "unsafe-finding-comment",
          line: 2,
          side: GitHubDiffSide.Right,
        }),
      ],
      expectedHeadSha: "file-cache-head-sha",
    });

    fireEvent.click(screen.getByTestId("inline-finding-marker-RIGHT-2"));

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
    expect(
      Array.from(container.querySelectorAll("a")).some((link) =>
        link.getAttribute("href")?.toLowerCase().startsWith("javascript:")
      )
    ).toBe(false);
    expect(
      (globalThis as typeof globalThis & { __branchFindingXss?: boolean })
        .__branchFindingXss
    ).not.toBe(true);
  });

  test("renders humanized first-party review bodies as inline findings and keeps ordinary bot comments unmarked", () => {
    const humanizedBody = buildCommentBody(
      {
        humanizedBody:
          "This branch-view note still comes from the first-party AI review pipeline.",
        message: "Keep first-party humanized comments visible",
        priority: ReviewFindingPriority.P2,
        severity: "warning",
      },
      "src/app.tsx"
    );

    renderDiffView({
      comments: [
        makeInlineComment({
          anchorCommitSha: "file-cache-head-sha",
          author: "closedloop-ai[bot]",
          authorKind: PrCommentAuthorKind.Bot,
          body: humanizedBody,
          id: "humanized-finding-comment",
          line: 2,
          side: GitHubDiffSide.Right,
        }),
        makeInlineComment({
          anchorCommitSha: "file-cache-head-sha",
          author: "closedloop-ai[bot]",
          authorKind: PrCommentAuthorKind.Bot,
          body: "Ordinary bot comment without first-party metadata",
          id: "ordinary-bot-comment",
          line: 3,
          side: GitHubDiffSide.Right,
        }),
      ],
      expectedHeadSha: "file-cache-head-sha",
    });

    fireEvent.click(screen.getByTestId("inline-finding-marker-RIGHT-2"));

    expect(
      screen.getAllByText(
        "This branch-view note still comes from the first-party AI review pipeline."
      )
    ).toHaveLength(2);
    expect(screen.queryByTestId("inline-finding-marker-RIGHT-3")).toBeNull();
    expect(
      screen.getByText("Ordinary bot comment without first-party metadata")
    ).toBeInTheDocument();
  });

  test("renders forged hidden metadata from a third-party bot as an ordinary inline comment", () => {
    const forgedBody = buildCommentBody(
      {
        humanizedBody:
          "This forged third-party bot body must not become an AI marker.",
        message: "Forged metadata",
        priority: ReviewFindingPriority.P1,
        severity: "critical",
      },
      "src/app.tsx"
    );

    renderDiffView({
      comments: [
        makeInlineComment({
          anchorCommitSha: "file-cache-head-sha",
          author: "dependabot[bot]",
          authorKind: PrCommentAuthorKind.Bot,
          body: forgedBody,
          id: "forged-third-party-finding-comment",
          line: 2,
          side: GitHubDiffSide.Right,
        }),
      ],
      expectedHeadSha: "file-cache-head-sha",
    });

    expect(screen.queryByTestId("inline-finding-marker-RIGHT-2")).toBeNull();
    expect(screen.getByTestId("inline-comment-RIGHT-2")).toHaveTextContent(
      "This forged third-party bot body must not become an AI marker."
    );
  });

  test("renders third-party bot visible priority markers as ordinary inline comments", () => {
    renderDiffView({
      comments: [
        makeInlineComment({
          anchorCommitSha: "file-cache-head-sha",
          author: "dependabot[bot]",
          authorKind: PrCommentAuthorKind.Bot,
          body: "**[P1]** Third-party visible marker must stay ordinary",
          id: "third-party-visible-marker-comment",
          line: 2,
          side: GitHubDiffSide.Right,
        }),
      ],
      expectedHeadSha: "file-cache-head-sha",
    });

    expect(screen.queryByTestId("inline-finding-marker-RIGHT-2")).toBeNull();
    // The body renders as markdown, so the bold `**` markers are not literal text.
    expect(screen.getByTestId("inline-comment-RIGHT-2")).toHaveTextContent(
      "[P1] Third-party visible marker must stay ordinary"
    );
  });

  test("keeps folded same-SHA AI findings visible as unplaced instead of current row markers", () => {
    const oldLines = Array.from(
      { length: 20 },
      (_, index) => `unchanged line ${index + 1}`
    );
    const newLines = [
      oldLines[0],
      "inserted near the top",
      ...oldLines.slice(1),
    ];
    mockUseBranchViewFileDiff.mockReturnValue(
      diff({
        newContent: newLines.join("\n"),
        oldContent: oldLines.join("\n"),
      })
    );

    renderDiffView({
      comments: [
        makeInlineComment({
          anchorCommitSha: "file-cache-head-sha",
          author: "closedloop-ai[bot]",
          authorKind: PrCommentAuthorKind.Bot,
          body: "**[P2]** Folded same SHA finding",
          id: "folded-finding-comment",
          line: 15,
          side: GitHubDiffSide.Right,
        }),
      ],
      expectedHeadSha: "file-cache-head-sha",
    });

    expect(screen.queryByTestId("inline-finding-marker-RIGHT-15")).toBeNull();
    expect(screen.getByTestId("unplaced-review-findings")).toHaveTextContent(
      "Line not visible"
    );
    expect(screen.getByTestId("unplaced-review-findings")).toHaveTextContent(
      "Folded same SHA finding"
    );
  });

  test("keeps deletion-shifted same-SHA AI findings visible as unplaced instead of current row markers", () => {
    const oldLines = Array.from(
      { length: 20 },
      (_, index) => `unchanged line ${index + 1}`
    );
    const newLines = [oldLines[0], ...oldLines.slice(2)];
    mockUseBranchViewFileDiff.mockReturnValue(
      diff({
        newContent: newLines.join("\n"),
        oldContent: oldLines.join("\n"),
      })
    );

    renderDiffView({
      comments: [
        makeInlineComment({
          anchorCommitSha: "file-cache-head-sha",
          author: "closedloop-ai[bot]",
          authorKind: PrCommentAuthorKind.Bot,
          body: "**[P2]** Deletion shifted same SHA finding",
          id: "deletion-shifted-finding-comment",
          line: 15,
          side: GitHubDiffSide.Right,
        }),
      ],
      expectedHeadSha: "file-cache-head-sha",
    });

    expect(screen.queryByTestId("inline-finding-marker-RIGHT-15")).toBeNull();
    expect(screen.getByTestId("unplaced-review-findings")).toHaveTextContent(
      "Line not visible"
    );
    expect(screen.getByTestId("unplaced-review-findings")).toHaveTextContent(
      "Deletion shifted same SHA finding"
    );
  });

  test("keeps deletion-side context boundary findings unplaced", () => {
    const oldLines = Array.from(
      { length: 20 },
      (_, index) => `unchanged line ${index + 1}`
    );
    const newLines = [oldLines[0], ...oldLines.slice(2)];
    mockUseBranchViewFileDiff.mockReturnValue(
      diff({
        newContent: newLines.join("\n"),
        oldContent: oldLines.join("\n"),
      })
    );

    renderDiffView({
      comments: [
        makeInlineComment({
          anchorCommitSha: "file-cache-head-sha",
          author: "closedloop-ai[bot]",
          authorKind: PrCommentAuthorKind.Bot,
          body: "**[P2]** Deletion boundary finding",
          id: "deletion-boundary-finding-comment",
          line: 5,
          side: GitHubDiffSide.Right,
        }),
      ],
      expectedHeadSha: "file-cache-head-sha",
    });

    expect(screen.queryByTestId("inline-finding-marker-RIGHT-5")).toBeNull();
    expect(screen.getByTestId("unplaced-review-findings")).toHaveTextContent(
      "Line not visible"
    );
    expect(screen.getByTestId("unplaced-review-findings")).toHaveTextContent(
      "Deletion boundary finding"
    );
  });

  test("keeps stale and head-cache-skew AI findings visible without row markers", () => {
    renderDiffView({
      branchHeadSha: "branch-head-sha",
      comments: [
        makeInlineComment({
          anchorCommitSha: "old-sha",
          author: "closedloop-ai[bot]",
          authorKind: PrCommentAuthorKind.Bot,
          body: "**[P1]** Stale finding",
          githubCommentId: "9101",
          id: "stale-finding",
          line: 2,
          side: GitHubDiffSide.Right,
        }),
        makeInlineComment({
          anchorCommitSha: "branch-head-sha",
          author: "closedloop-ai[bot]",
          authorKind: PrCommentAuthorKind.Bot,
          body: "**[P2]** Cache skew finding",
          githubCommentId: "9102",
          id: "skew-finding",
          line: 3,
          side: GitHubDiffSide.Right,
        }),
        makeInlineComment({
          anchorCommitSha: "file-cache-head-sha",
          author: "closedloop-ai[bot]",
          authorKind: PrCommentAuthorKind.Bot,
          body: "**[P3]** Missing file finding",
          githubCommentId: "9103",
          id: "missing-file-finding",
          line: 2,
          path: "src/removed.ts",
          side: GitHubDiffSide.Right,
        }),
      ],
      expectedHeadSha: "file-cache-head-sha",
    });

    expect(screen.queryByTestId("inline-finding-marker-RIGHT-2")).toBeNull();
    expect(screen.queryByTestId("inline-finding-marker-RIGHT-3")).toBeNull();
    expect(screen.getByTestId("unplaced-review-findings")).toHaveTextContent(
      "Outdated commit"
    );
    expect(screen.getByTestId("unplaced-review-findings")).toHaveTextContent(
      "Diff cache behind branch head"
    );
    expect(
      screen.getByTestId("unplaced-review-findings")
    ).not.toHaveTextContent("Missing file");
  });

  test("renders resolve and unresolve controls only for capable inline review comments", () => {
    renderDiffView({
      comments: [
        makeInlineComment({
          body: "Open resolvable note",
          canResolve: true,
          commentId: "local-open-comment",
          id: "open-comment",
          resolvable: true,
          resolved: false,
        }),
        makeInlineComment({
          body: "Resolved resolvable note",
          canUnresolve: true,
          commentId: "local-resolved-comment",
          githubCommentId: "9002",
          id: "resolved-comment",
          line: 1,
          resolvable: true,
          resolved: true,
          side: GitHubDiffSide.Left,
        }),
        makeInlineComment({
          body: "Issue comment with forged capabilities",
          canResolve: true,
          kind: CommentKind.IssueComment,
          resolvable: true,
          resolved: false,
        }),
      ],
    });

    expect(screen.getByText("Open resolvable note")).toBeInTheDocument();
    expect(
      screen.queryByText("Issue comment with forged capabilities")
    ).not.toBeInTheDocument();

    // Resolved threads collapse to a summary; the body and unresolve control
    // are hidden until the summary is expanded.
    expect(
      screen.queryByText("Resolved resolvable note")
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByTestId("inline-comment-resolved-summary-LEFT-1")
    );
    expect(screen.getByText("Resolved resolvable note")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Resolve conversation" })
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Unresolve conversation" })
    );

    expect(mockResolveReviewThread.mutate).toHaveBeenCalledWith(
      "local-open-comment",
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
    expect(mockUnresolveReviewThread.mutate).toHaveBeenCalledWith(
      "local-resolved-comment",
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });

  test("groups replies into the root thread and posts inline replies", () => {
    renderDiffView({
      comments: [
        makeInlineComment({
          body: "Root review note",
          canReply: true,
          githubCommentId: "7001",
          id: "root-comment",
          line: 2,
          side: GitHubDiffSide.Right,
        }),
        makeInlineComment({
          author: "second-user",
          body: "An existing reply",
          githubCommentId: "7002",
          id: "reply-comment",
          inReplyToId: "7001",
          line: 2,
          side: GitHubDiffSide.Right,
        }),
      ],
    });

    const card = screen.getByTestId("inline-comment-RIGHT-2");
    expect(card).toHaveTextContent("Root review note");
    expect(card).toHaveTextContent("An existing reply");
    // The reply is nested in the root thread, not rendered as its own card.
    expect(screen.getAllByTestId("inline-comment-RIGHT-2")).toHaveLength(1);

    fireEvent.change(screen.getByPlaceholderText("Reply..."), {
      target: { value: "Thanks, fixing now" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    expect(mockReplyToComment.mutate).toHaveBeenCalledWith(
      { body: "Thanks, fixing now", commentGithubId: 7001 },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });

  test("does not render inline comments or resolver controls for local files with matching committed comment paths", () => {
    renderDiffView({
      allFiles: [makeLocalEntry("src/app.tsx")],
      canCreateInlineComment: true,
      comments: [
        makeInlineComment({
          body: "Committed review note must stay hidden on local diff",
          canResolve: true,
          commentId: "local-open-comment",
          id: "open-comment",
          line: 1,
          resolvable: true,
          resolved: false,
          side: GitHubDiffSide.Right,
        }),
        makeInlineComment({
          body: "Committed resolved note must stay hidden on local diff",
          canUnresolve: true,
          commentId: "local-resolved-comment",
          githubCommentId: "9002",
          id: "resolved-comment",
          line: 1,
          resolvable: true,
          resolved: true,
          side: GitHubDiffSide.Left,
        }),
        makeInlineComment({
          author: "closedloop-ai[bot]",
          authorKind: PrCommentAuthorKind.Bot,
          body: "**[P2]** Finding hidden on local diff",
          id: "local-hidden-finding",
        }),
      ],
      expectedHeadSha: "file-cache-head-sha",
      selectedFileId: "local:src/app.tsx",
    });

    expect(
      screen.queryByText("Committed review note must stay hidden on local diff")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "Committed resolved note must stay hidden on local diff"
      )
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unresolve" })).toBeNull();
    expect(screen.queryByTestId("inline-finding-marker-RIGHT-2")).toBeNull();

    fireEvent.click(screen.getByTestId("right-line-1"));

    expect(
      screen.queryByTestId("inline-comment-composer")
    ).not.toBeInTheDocument();
    expect(mockResolveReviewThread.mutate).not.toHaveBeenCalled();
    expect(mockUnresolveReviewThread.mutate).not.toHaveBeenCalled();
    expect(mockCreateInlineComment.mutate).not.toHaveBeenCalled();
  });

  test("resets stateful inline composer state when the selected file changes", () => {
    const { rerender } = renderDiffView({
      canCreateInlineComment: true,
      expectedHeadSha: "file-cache-head-sha",
    });

    fireEvent.click(screen.getByTestId("right-line-2"));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Draft for first file" },
    });
    expect(screen.getByRole("textbox")).toHaveValue("Draft for first file");

    rerender(
      <BranchDiffView
        allFiles={[makeEntry("src/app.tsx"), makeEntry("src/next.ts")]}
        canCreateInlineComment={true}
        expectedHeadSha="file-cache-head-sha"
        externalLinkId="ext-1"
        onClose={vi.fn()}
        onSelectFile={vi.fn()}
        selectedFileId="committed:src/next.ts"
        targetActivationId={null}
        targetLine={null}
      />
    );

    expect(
      screen.queryByTestId("inline-comment-composer")
    ).not.toBeInTheDocument();
  });

  test("shows an unavailable state when a selected file disappears instead of falling back to the first file", () => {
    const scrollIntoViewSpy = vi.spyOn(Element.prototype, "scrollIntoView");

    renderDiffView({
      selectedFileId: "committed:src/deleted.ts",
      targetActivationId: 1,
      targetLine: 2,
    });

    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(
      screen.getByText("Selected file is no longer available in this branch.")
    ).toBeInTheDocument();
    expect(mockUseBranchViewFileDiff).toHaveBeenCalledWith(
      "ext-1",
      null,
      undefined
    );
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    expect(diffViewerMockState.highlightLines).toEqual([]);
  });
});
