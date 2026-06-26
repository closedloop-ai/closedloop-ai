import {
  BranchViewCommentAction,
  BranchViewCommentActionRecovery,
  BranchViewCommentActionResultCode,
  BranchViewCommentSource,
  BranchViewCommentWriteIdentityStatus,
  CommentKind,
  FileChangeStatus,
  GitHubDiffSide,
  PRReviewCommentState,
  PrCommentAuthorKind,
} from "@repo/api/src/types/branch-view";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ReviewFindingPriority } from "@/lib/engineer/review-finding-priority";
import { getBranchViewCommentUiId } from "../../comment-context";
import type { BranchViewComment, BranchViewFile } from "../../types";
import {
  BranchPrCommentsSection,
  copyBranchViewCommentLinkToClipboard,
} from "../branch-pr-comments-section";
import { BranchViewCommentIdentityBlockerProvider } from "../branch-view-comment-identity-blocker-store";
import { buildCommentBody } from "./review-comment-body-fixture";

const VIEW_AT_LINE_BUTTON_NAME = /View .* at line/u;
const CONNECT_GITHUB_LINK_NAME = /Connect GitHub/u;
const EDIT_MENU_ITEM_NAME = /Edit/u;
const FINDING_BODY_TEXT = /Finding body/u;
const HUMANIZED_FINDING_BODY_TEXT = /Humanized first-party body still appears/u;
const RECONNECT_GITHUB_LINK_NAME = /Reconnect GitHub/u;
const STALE_FINDING_BODY_TEXT = /Stale finding body/u;
const mutationMocks = vi.hoisted(() => ({
  clipboardWrite: vi.fn(),
  createConversation: vi.fn(),
  deleteConversation: vi.fn(),
  deleteReview: vi.fn(),
  editConversation: vi.fn(),
  editReview: vi.fn(),
  reply: vi.fn(),
  resolveReview: vi.fn(),
  resolveReviewPending: { current: false },
  resolveReviewVariables: { current: undefined as string | undefined },
  sync: vi.fn(),
  unresolveReview: vi.fn(),
  unresolveReviewPending: { current: false },
  unresolveReviewVariables: { current: undefined as string | undefined },
}));

vi.mock("@repo/app/documents/hooks/use-branch-view", () => ({
  useCreateBranchViewConversationComment: () => ({
    isPending: false,
    mutate: mutationMocks.createConversation,
  }),
  useDeleteBranchViewConversationComment: () => ({
    isPending: false,
    mutate: mutationMocks.deleteConversation,
  }),
  useDeleteBranchViewReviewComment: () => ({
    isPending: false,
    mutate: mutationMocks.deleteReview,
  }),
  useEditBranchViewConversationComment: () => ({
    isPending: false,
    mutate: mutationMocks.editConversation,
  }),
  useEditBranchViewReviewComment: () => ({
    isPending: false,
    mutate: mutationMocks.editReview,
  }),
  useReplyToComment: () => ({ isPending: false, mutate: mutationMocks.reply }),
  useResolveBranchViewReviewThread: () => ({
    isPending: mutationMocks.resolveReviewPending.current,
    mutate: mutationMocks.resolveReview,
    variables: mutationMocks.resolveReviewVariables.current,
  }),
  useSyncBranchView: () => ({ isPending: false, mutate: mutationMocks.sync }),
  useUnresolveBranchViewReviewThread: () => ({
    isPending: mutationMocks.unresolveReviewPending.current,
    mutate: mutationMocks.unresolveReview,
    variables: mutationMocks.unresolveReviewVariables.current,
  }),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@repo/design-system/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => (
    <div data-slot="scroll-area-viewport">{children}</div>
  ),
}));

vi.mock("@repo/design-system/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    disabled,
    onClick,
    onSelect,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
    onSelect?: (event: Event) => void;
  }) => (
    <button
      disabled={disabled}
      onClick={() => {
        onClick?.();
        onSelect?.(new Event("select"));
      }}
      type="button"
    >
      {children}
    </button>
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

vi.mock("@/lib/markdown", () => ({
  CommentMarkdown: ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
}));

function makeFile(
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

function makeComment(
  overrides: Partial<BranchViewComment> & Pick<BranchViewComment, "id">
): BranchViewComment {
  const { id, ...rest } = overrides;
  return {
    author: "Daniel",
    authorAvatar: null,
    authorKind: PrCommentAuthorKind.User,
    body: `Body for ${id}`,
    createdAt: "2026-05-01T12:00:00.000Z",
    githubCommentId: id.replace(/\D/g, "") || id,
    htmlUrl: `https://github.com/acme/repo/pull/1#${id}`,
    id,
    inReplyToId: null,
    kind: CommentKind.ReviewComment,
    line: 42,
    path: "src/app.tsx",
    reviewId: "review-1",
    state: PRReviewCommentState.Pending,
    ...rest,
  };
}

function expandResolvedThread(comment: BranchViewComment) {
  fireEvent.click(
    screen.getByTestId(
      `pr-comment-resolved-summary-${getBranchViewCommentUiId(comment)}`
    )
  );
}

function renderSection({
  canCreateConversationComment = false,
  commentPromptEligibility,
  comments,
  committedFiles = [makeFile("src/app.tsx")],
  fileCacheHeadSha = null,
  headSha = null,
  onSelectComment = vi.fn(),
  onSelectCommentDiffTarget = vi.fn(),
}: {
  canCreateConversationComment?: boolean;
  commentPromptEligibility?: Parameters<
    typeof BranchPrCommentsSection
  >[0]["commentPromptEligibility"];
  comments: BranchViewComment[];
  committedFiles?: BranchViewFile[];
  fileCacheHeadSha?: string | null;
  headSha?: string | null;
  onSelectComment?: (id: string | null) => void;
  onSelectCommentDiffTarget?: Parameters<
    typeof BranchPrCommentsSection
  >[0]["onSelectCommentDiffTarget"];
}) {
  render(
    <BranchViewCommentIdentityBlockerProvider
      buildId="branch-artifact-1"
      orgSlug="acme"
    >
      <BranchPrCommentsSection
        canCreateConversationComment={canCreateConversationComment}
        commentPromptEligibility={commentPromptEligibility}
        comments={comments}
        committedFiles={committedFiles}
        externalLinkId="ext-1"
        fileCacheHeadSha={fileCacheHeadSha}
        headSha={headSha}
        onSelectComment={onSelectComment}
        onSelectCommentDiffTarget={onSelectCommentDiffTarget}
        selectedCommentId={null}
      />
    </BranchViewCommentIdentityBlockerProvider>
  );
  return { onSelectComment, onSelectCommentDiffTarget };
}

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(globalThis.navigator),
  "clipboard"
);

beforeEach(() => {
  vi.clearAllMocks();
  mutationMocks.resolveReviewPending.current = false;
  mutationMocks.resolveReviewVariables.current = undefined;
  mutationMocks.unresolveReviewPending.current = false;
  mutationMocks.unresolveReviewVariables.current = undefined;
  mutationMocks.clipboardWrite.mockResolvedValue(undefined);
  Reflect.deleteProperty(globalThis.navigator, "clipboard");
  Object.defineProperty(
    Object.getPrototypeOf(globalThis.navigator),
    "clipboard",
    {
      configurable: true,
      get: () => ({
        writeText: (value: string) => mutationMocks.clipboardWrite(value),
      }),
    }
  );
  mutationMocks.createConversation.mockImplementation((_input, options) =>
    options?.onSuccess?.({ success: true })
  );
  mutationMocks.deleteConversation.mockImplementation((_input, options) =>
    options?.onSuccess?.({ success: true })
  );
  mutationMocks.editConversation.mockImplementation((_input, options) =>
    options?.onSuccess?.({ success: true })
  );
  mutationMocks.deleteReview.mockImplementation((_input, options) =>
    options?.onSuccess?.({ success: true })
  );
  mutationMocks.editReview.mockImplementation((_input, options) =>
    options?.onSuccess?.({ success: true })
  );
  mutationMocks.resolveReview.mockImplementation((_input, options) =>
    options?.onSuccess?.({ success: true })
  );
  mutationMocks.unresolveReview.mockImplementation((_input, options) =>
    options?.onSuccess?.({ success: true })
  );
});

afterEach(() => {
  if (originalClipboardDescriptor) {
    Object.defineProperty(
      Object.getPrototypeOf(globalThis.navigator),
      "clipboard",
      originalClipboardDescriptor
    );
    return;
  }
  Reflect.deleteProperty(
    Object.getPrototypeOf(globalThis.navigator),
    "clipboard"
  );
});

describe("BranchPrCommentsSection", () => {
  test("does not render a dedicated comments sync control", () => {
    renderSection({ comments: [] });

    expect(
      screen.queryByRole("button", { name: "Sync comments from GitHub" })
    ).not.toBeInTheDocument();
  });

  test("renders the legacy PR compose connect prompt with the canonical href", () => {
    renderSection({
      commentPromptEligibility: {
        createConversation: {
          identityBlocker: {
            status: BranchViewCommentWriteIdentityStatus.Missing,
          },
          prompt: true,
        },
        createInline: { prompt: false },
      },
      comments: [],
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

  test("does not render the legacy PR compose prompt for non-identity blockers", () => {
    renderSection({
      commentPromptEligibility: {
        createConversation: { prompt: false },
        createInline: { prompt: false },
      },
      comments: [],
    });

    expect(
      screen.queryByTestId("branch-view-github-identity-prompt")
    ).not.toBeInTheDocument();
  });

  test("renders legacy reply and management reconnect prompts outside action menus", () => {
    const replyBlocked = makeComment({
      actionPromptEligibility: {
        delete: { prompt: false },
        edit: { prompt: false },
        reply: {
          identityBlocker: {
            status: BranchViewCommentWriteIdentityStatus.Expired,
          },
          prompt: true,
        },
        resolve: { prompt: false },
        unresolve: { prompt: false },
      },
      id: "reply-blocked",
    });
    const managementBlocked = makeComment({
      actionPromptEligibility: {
        delete: { prompt: false },
        edit: { prompt: false },
        reply: { prompt: false },
        resolve: {
          identityBlocker: {
            status: BranchViewCommentWriteIdentityStatus.Revoked,
          },
          prompt: true,
        },
        unresolve: { prompt: false },
      },
      id: "management-blocked",
    });

    renderSection({ comments: [replyBlocked, managementBlocked] });

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

  test("creates a top-level conversation comment when capability is present", async () => {
    const user = userEvent.setup();
    renderSection({
      canCreateConversationComment: true,
      comments: [],
    });

    await user.type(
      screen.getByPlaceholderText("Write a comment..."),
      " New note "
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(mutationMocks.createConversation).toHaveBeenCalledWith(
      { body: "New note" },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });

  test("edits and deletes conversation comments through scoped action hooks", async () => {
    const user = userEvent.setup();
    renderSection({
      comments: [
        makeComment({
          canDelete: true,
          canEdit: true,
          id: "issue-1",
          githubCommentId: "9001",
          kind: CommentKind.IssueComment,
          path: null,
          line: null,
          body: "Original body",
        }),
      ],
    });

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("button", { name: EDIT_MENU_ITEM_NAME }));
    const editBox = screen.getByDisplayValue("Original body");
    await user.clear(editBox);
    await user.type(editBox, "Edited body");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mutationMocks.editConversation).toHaveBeenCalledWith(
      { githubCommentId: "9001", body: "Edited body" },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(mutationMocks.deleteConversation).toHaveBeenCalledWith(
      "9001",
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });

  test("disables conversation edit and delete controls when capabilities are absent", async () => {
    const user = userEvent.setup();
    renderSection({
      comments: [
        makeComment({
          canDelete: false,
          canEdit: false,
          id: "issue-1",
          githubCommentId: "9001",
          kind: CommentKind.IssueComment,
          path: null,
          line: null,
          body: "Other user body",
        }),
      ],
    });

    await user.click(screen.getByRole("button", { name: "More actions" }));
    const editAction = screen.getByRole("button", {
      name: EDIT_MENU_ITEM_NAME,
    });
    const deleteAction = screen.getByRole("button", { name: "Delete" });

    expect(editAction).toBeDisabled();
    expect(deleteAction).toBeDisabled();

    fireEvent.click(editAction);
    fireEvent.click(deleteAction);

    expect(mutationMocks.editConversation).not.toHaveBeenCalled();
    expect(mutationMocks.deleteConversation).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue("Other user body")).toBeNull();
  });

  test("hides resolve actions for issue comments and omits resolve-all when no review comment is resolvable", async () => {
    const user = userEvent.setup();
    renderSection({
      comments: [
        makeComment({
          canDelete: true,
          canEdit: true,
          id: "issue-1",
          githubCommentId: "9001",
          kind: CommentKind.IssueComment,
          path: null,
          line: null,
        }),
      ],
    });

    await user.click(screen.getByRole("button", { name: "More actions" }));

    expect(screen.queryByRole("button", { name: "Resolve thread" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resolve All" })).toBeNull();
    expect(
      screen.getByRole("button", { name: EDIT_MENU_ITEM_NAME })
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  test("copies the exact API-projected comment URL only after clipboard write succeeds", async () => {
    const htmlUrl = "https://github.com/acme/repo/pull/1#discussion_r123456";
    const comment = makeComment({
      canResolve: true,
      commentId: "review-comment-1",
      htmlUrl,
      id: "review-1",
      resolvable: true,
    });

    copyBranchViewCommentLinkToClipboard(comment);

    expect(mutationMocks.clipboardWrite).toHaveBeenCalledWith(htmlUrl);
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Copied link")
    );
  });

  test("does not show copy success when clipboard write fails", async () => {
    mutationMocks.clipboardWrite.mockRejectedValueOnce(new Error("denied"));
    const comment = makeComment({
      htmlUrl: "https://github.com/acme/repo/pull/1#discussion_rclipboard",
      id: "review-clipboard-failure",
    });

    copyBranchViewCommentLinkToClipboard(comment);

    await waitFor(() =>
      expect(mutationMocks.clipboardWrite).toHaveBeenCalled()
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  test("does not copy or confirm when clipboard writing is unavailable", () => {
    Reflect.deleteProperty(
      Object.getPrototypeOf(globalThis.navigator),
      "clipboard"
    );
    const comment = makeComment({
      htmlUrl: "https://github.com/acme/repo/pull/1#discussion_rno_clipboard",
      id: "review-no-clipboard",
    });

    copyBranchViewCommentLinkToClipboard(comment);

    expect(mutationMocks.clipboardWrite).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  test("does not render copy link for blank API-projected URLs", () => {
    const blankUrlComment = makeComment({
      htmlUrl: "",
      id: "review-blank-url",
    });
    const whitespaceUrlComment = makeComment({
      htmlUrl: "   ",
      id: "review-whitespace-url",
    });
    renderSection({ comments: [blankUrlComment, whitespaceUrlComment] });

    for (const comment of [blankUrlComment, whitespaceUrlComment]) {
      expect(
        within(
          screen.getByTestId(`comment-row-${getBranchViewCommentUiId(comment)}`)
        ).queryByRole("button", { name: "Copy link" })
      ).toBeNull();
    }
    expect(mutationMocks.clipboardWrite).not.toHaveBeenCalled();
  });

  test("keeps overflow actions available without a nested feature flag", async () => {
    const user = userEvent.setup();
    const comment = makeComment({
      canResolve: true,
      htmlUrl: "https://github.com/org/repo/pull/1#discussion_r1",
      id: "review-without-nested-flag",
      resolvable: true,
      resolved: false,
    });
    renderSection({
      comments: [comment],
    });

    await user.click(screen.getByRole("button", { name: "More actions" }));

    expect(screen.getByRole("button", { name: "Copy link" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Resolve thread" })
    ).toBeEnabled();
  });

  test("resolves and unresolves review threads with the exact Branch View comment id", async () => {
    const user = userEvent.setup();
    const unresolved = makeComment({
      canResolve: true,
      commentId: "review-comment-id",
      id: "review-raw-id",
      resolvable: true,
      resolved: false,
    });
    const resolved = makeComment({
      canUnresolve: true,
      id: "resolved-fallback-id",
      resolvable: true,
      resolved: true,
      state: PRReviewCommentState.Addressed,
    });
    renderSection({ comments: [unresolved, resolved] });

    const unresolvedRow = screen.getByTestId(
      `comment-row-${getBranchViewCommentUiId(unresolved)}`
    );
    await user.click(
      within(unresolvedRow).getByRole("button", { name: "More actions" })
    );
    await user.click(
      within(unresolvedRow).getByRole("button", { name: "Resolve thread" })
    );
    expect(mutationMocks.resolveReview).toHaveBeenCalledWith(
      "review-comment-id",
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );

    expandResolvedThread(resolved);
    const resolvedRow = screen.getByTestId(
      `comment-row-${getBranchViewCommentUiId(resolved)}`
    );
    await user.click(
      within(resolvedRow).getByRole("button", { name: "More actions" })
    );
    await user.click(
      within(resolvedRow).getByRole("button", { name: "Unresolve thread" })
    );
    expect(mutationMocks.unresolveReview).toHaveBeenCalledWith(
      "resolved-fallback-id",
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
    expect(toast.warning).not.toHaveBeenCalled();
  });

  test("fails closed for malformed or denied resolve capabilities", async () => {
    const user = userEvent.setup();
    const malformedIssue = makeComment({
      canResolve: true,
      canUnresolve: true,
      id: "issue-malformed",
      kind: CommentKind.IssueComment,
      line: null,
      path: null,
      resolvable: true,
      resolved: false,
    });
    const cannotResolve = makeComment({
      canResolve: false,
      id: "review-cannot-resolve",
      resolvable: true,
      resolved: false,
    });
    const cannotUnresolve = makeComment({
      canUnresolve: false,
      id: "review-cannot-unresolve",
      resolvable: true,
      resolved: true,
      state: PRReviewCommentState.Addressed,
    });
    renderSection({
      comments: [malformedIssue, cannotResolve, cannotUnresolve],
    });

    await user.click(
      screen.getAllByRole("button", { name: "More actions" })[0]
    );

    expect(screen.queryByRole("button", { name: "Resolve thread" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Unresolve thread" })
    ).toBeNull();
    expect(
      within(
        screen.getByTestId(
          `comment-row-${getBranchViewCommentUiId(cannotResolve)}`
        )
      ).queryByRole("button", { name: "Resolve thread" })
    ).toBeNull();
    expandResolvedThread(cannotUnresolve);
    expect(
      within(
        screen.getByTestId(
          `comment-row-${getBranchViewCommentUiId(cannotUnresolve)}`
        )
      ).queryByRole("button", { name: "Unresolve thread" })
    ).toBeNull();
    expect(mutationMocks.resolveReview).not.toHaveBeenCalled();
    expect(mutationMocks.unresolveReview).not.toHaveBeenCalled();
  });

  test("fails closed when review-thread capability fields are omitted", () => {
    const missingResolveCapability = makeComment({
      id: "review-missing-can-resolve",
      resolvable: true,
      resolved: false,
    });
    const missingUnresolveCapability = makeComment({
      id: "review-missing-can-unresolve",
      resolvable: true,
      resolved: true,
      state: PRReviewCommentState.Addressed,
    });
    renderSection({
      comments: [missingResolveCapability, missingUnresolveCapability],
    });

    expect(
      within(
        screen.getByTestId(
          `comment-row-${getBranchViewCommentUiId(missingResolveCapability)}`
        )
      ).queryByRole("button", { name: "Resolve thread" })
    ).toBeNull();
    expandResolvedThread(missingUnresolveCapability);
    expect(
      within(
        screen.getByTestId(
          `comment-row-${getBranchViewCommentUiId(missingUnresolveCapability)}`
        )
      ).queryByRole("button", { name: "Unresolve thread" })
    ).toBeNull();
    expect(mutationMocks.resolveReview).not.toHaveBeenCalled();
    expect(mutationMocks.unresolveReview).not.toHaveBeenCalled();
  });

  test("disables the active resolve action while a review-thread mutation is pending", async () => {
    const user = userEvent.setup();
    mutationMocks.resolveReviewPending.current = true;
    mutationMocks.resolveReviewVariables.current = "review-pending-resolve";
    renderSection({
      comments: [
        makeComment({
          canResolve: true,
          id: "review-pending-resolve",
          resolvable: true,
        }),
      ],
    });

    await user.click(screen.getByRole("button", { name: "More actions" }));

    expect(
      screen.getByRole("button", { name: "Resolve thread" })
    ).toBeDisabled();
  });

  test("keeps unrelated review-thread actions enabled while another row is pending", () => {
    mutationMocks.resolveReviewPending.current = true;
    mutationMocks.resolveReviewVariables.current = "pending-resolve-target";
    mutationMocks.unresolveReviewPending.current = true;
    mutationMocks.unresolveReviewVariables.current = "pending-unresolve-target";
    const pendingResolve = makeComment({
      canResolve: true,
      commentId: "pending-resolve-target",
      id: "review-pending-resolve-row",
      resolvable: true,
      resolved: false,
    });
    const unrelatedResolve = makeComment({
      canResolve: true,
      commentId: "unrelated-resolve-target",
      id: "review-unrelated-resolve-row",
      resolvable: true,
      resolved: false,
    });
    const pendingUnresolve = makeComment({
      canUnresolve: true,
      commentId: "pending-unresolve-target",
      id: "review-pending-unresolve-row",
      resolvable: true,
      resolved: true,
      state: PRReviewCommentState.Addressed,
    });
    const unrelatedUnresolve = makeComment({
      canUnresolve: true,
      commentId: "unrelated-unresolve-target",
      id: "review-unrelated-unresolve-row",
      resolvable: true,
      resolved: true,
      state: PRReviewCommentState.Addressed,
    });
    renderSection({
      comments: [
        pendingResolve,
        unrelatedResolve,
        pendingUnresolve,
        unrelatedUnresolve,
      ],
    });

    expect(
      within(
        screen.getByTestId(
          `comment-row-${getBranchViewCommentUiId(pendingResolve)}`
        )
      ).getByRole("button", { name: "Resolve thread" })
    ).toBeDisabled();
    expect(
      within(
        screen.getByTestId(
          `comment-row-${getBranchViewCommentUiId(unrelatedResolve)}`
        )
      ).getByRole("button", { name: "Resolve thread" })
    ).toBeEnabled();
    expandResolvedThread(pendingUnresolve);
    expandResolvedThread(unrelatedUnresolve);
    expect(
      within(
        screen.getByTestId(
          `comment-row-${getBranchViewCommentUiId(pendingUnresolve)}`
        )
      ).getByRole("button", { name: "Unresolve thread" })
    ).toBeDisabled();
    expect(
      within(
        screen.getByTestId(
          `comment-row-${getBranchViewCommentUiId(unrelatedUnresolve)}`
        )
      ).getByRole("button", { name: "Unresolve thread" })
    ).toBeEnabled();
  });

  test("keeps issue-comment controls separate from inline review-comment controls", () => {
    renderSection({
      comments: [
        makeComment({
          canDelete: true,
          canEdit: true,
          id: "issue-1",
          githubCommentId: "9001",
          kind: CommentKind.IssueComment,
          line: 24,
          path: "src/conversation.ts",
          resolvable: false,
        }),
        makeComment({
          canReply: true,
          id: "review-1",
          line: 42,
          path: "src/app.tsx",
          resolvable: true,
        }),
      ],
      committedFiles: [
        makeFile("src/app.tsx"),
        makeFile("src/conversation.ts"),
      ],
    });

    expect(
      screen.queryByRole("button", {
        name: "View src/conversation.ts at line 24",
      })
    ).toBeNull();
    expect(screen.getByText("src/conversation.ts:24")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "View src/app.tsx at line 42" })
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Reply" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Resolve thread" })).toBeNull();
  });

  test("keeps same-raw-id issue and review comments isolated in rendering and actions", async () => {
    const user = userEvent.setup();
    const sharedGithubCommentId = "9001";
    const reviewRoot = makeComment({
      body: "Review root body",
      canDelete: true,
      canEdit: true,
      canReply: true,
      commentId: "comment-review-root",
      githubCommentId: sharedGithubCommentId,
      id: sharedGithubCommentId,
      line: 42,
      path: "src/review.ts",
      resolvable: true,
      threadId: "thread-review",
    });
    const issueRoot = makeComment({
      body: "Issue root body",
      canDelete: true,
      canEdit: true,
      commentId: "comment-issue-root",
      githubCommentId: sharedGithubCommentId,
      id: sharedGithubCommentId,
      kind: CommentKind.IssueComment,
      line: null,
      path: null,
      resolvable: false,
      reviewId: null,
      threadId: "thread-issue",
    });
    const reviewReply = makeComment({
      body: "Review reply body",
      commentId: "comment-review-reply",
      githubCommentId: "9002",
      id: "9002",
      inReplyToId: sharedGithubCommentId,
      line: null,
      path: null,
      threadId: "thread-review",
    });

    renderSection({
      comments: [reviewRoot, issueRoot, reviewReply],
    });

    const issueRow = screen.getByTestId(
      `comment-row-${getBranchViewCommentUiId(issueRoot)}`
    );
    const reviewRow = screen.getByTestId(
      `comment-row-${getBranchViewCommentUiId(reviewRoot)}`
    );
    expect(within(issueRow).getByText("Issue root body")).toBeInTheDocument();
    expect(within(issueRow).queryByText("Review reply body")).toBeNull();
    expect(within(reviewRow).getByText("Review root body")).toBeInTheDocument();
    expect(
      within(reviewRow).getByText("Review reply body")
    ).toBeInTheDocument();

    await user.click(
      within(issueRow).getByRole("button", { name: "More actions" })
    );
    await user.click(within(issueRow).getByRole("button", { name: "Edit" }));
    const issueEditBox = screen.getByDisplayValue("Issue root body");
    await user.clear(issueEditBox);
    await user.type(issueEditBox, "Edited issue body");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(mutationMocks.editConversation).toHaveBeenCalledWith(
      { githubCommentId: sharedGithubCommentId, body: "Edited issue body" },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );

    await user.click(
      within(reviewRow).getByRole("button", { name: "More actions" })
    );
    await user.click(within(reviewRow).getByRole("button", { name: "Edit" }));
    const reviewEditBox = screen.getByDisplayValue("Review root body");
    await user.clear(reviewEditBox);
    await user.type(reviewEditBox, "Edited review body");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(mutationMocks.editReview).toHaveBeenCalledWith(
      { commentId: "comment-review-root", body: "Edited review body" },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );

    await user.click(
      within(issueRow).getByRole("button", { name: "More actions" })
    );
    await user.click(within(issueRow).getByRole("button", { name: "Delete" }));
    expect(mutationMocks.deleteConversation).toHaveBeenCalledWith(
      sharedGithubCommentId,
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );

    await user.click(
      within(reviewRow).getByRole("button", { name: "More actions" })
    );
    await user.click(within(reviewRow).getByRole("button", { name: "Delete" }));
    expect(mutationMocks.deleteReview).toHaveBeenCalledWith(
      "comment-review-root",
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );

    await user.click(
      within(reviewRow).getAllByRole("button", { name: "Reply" })[0]
    );
    await user.type(
      screen.getByPlaceholderText("Write a reply..."),
      "Reply draft"
    );
    const replyButtons = screen.getAllByRole("button", { name: "Reply" });
    await user.click(replyButtons.at(-1)!);
    expect(mutationMocks.reply).toHaveBeenCalledWith(
      { commentGithubId: 9001, body: "Reply draft" },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  }, 10_000);

  test("attaches replies when optional source serialization differs from the parent", () => {
    const root = makeComment({
      body: "Parent body",
      commentId: "comment-root",
      githubCommentId: "9101",
      id: "9101",
      source: BranchViewCommentSource.Github,
      threadId: "thread-review-source-mismatch",
    });
    const reply = makeComment({
      body: "Reply body",
      commentId: "comment-reply",
      githubCommentId: "9102",
      id: "9102",
      inReplyToId: "9101",
      line: null,
      path: null,
      threadId: "thread-review-source-mismatch",
    });

    renderSection({
      comments: [root, reply],
    });

    const rootRow = screen.getByTestId(
      `comment-row-${getBranchViewCommentUiId(root)}`
    );
    expect(within(rootRow).getByText("Parent body")).toBeInTheDocument();
    expect(within(rootRow).getByText("Reply body")).toBeInTheDocument();
    expect(
      screen.queryByTestId(`comment-row-${getBranchViewCommentUiId(reply)}`)
    ).toBeNull();
  });

  test("keeps resolve-all disabled when only issue comments are pending", () => {
    renderSection({
      comments: [
        makeComment({
          id: "review-resolved",
          resolvable: true,
          resolved: true,
          state: PRReviewCommentState.Addressed,
        }),
        makeComment({
          id: "issue-pending",
          kind: CommentKind.IssueComment,
          line: null,
          path: null,
          state: PRReviewCommentState.Pending,
        }),
      ],
    });

    expect(screen.getByRole("button", { name: "Resolve All" })).toBeDisabled();
  });

  test("splits comments into inline review and general conversation filters", async () => {
    const user = userEvent.setup();
    renderSection({
      comments: [
        makeComment({
          body: "Issue first body",
          id: "issue-first",
          kind: CommentKind.IssueComment,
          line: null,
          path: null,
          state: PRReviewCommentState.Pending,
        }),
        makeComment({
          body: "Issue second body",
          id: "issue-second",
          kind: CommentKind.IssueComment,
          line: null,
          path: null,
          state: PRReviewCommentState.Addressed,
        }),
        makeComment({
          body: "Review first body",
          id: "review-first",
          state: PRReviewCommentState.Pending,
        }),
        makeComment({
          body: "Review second body",
          id: "review-second",
          state: PRReviewCommentState.Addressed,
        }),
      ],
    });

    expect(screen.getByRole("tab", { name: "All (4)" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Inline (2)" })).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "General (2)" })
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Inline (2)" }));
    expect(screen.getByText("Review first body")).toBeInTheDocument();
    expect(screen.getByText("Review second body")).toBeInTheDocument();
    expect(screen.queryByText("Issue first body")).toBeNull();
    expect(screen.queryByText("Issue second body")).toBeNull();

    await user.click(screen.getByRole("tab", { name: "General (2)" }));
    expect(screen.getByText("Issue first body")).toBeInTheDocument();
    expect(screen.getByText("Issue second body")).toBeInTheDocument();
    expect(screen.queryByText("Review first body")).toBeNull();
    expect(screen.queryByText("Review second body")).toBeNull();
  });

  test("collapses resolved review threads into a summary that expands on click", async () => {
    const user = userEvent.setup();
    const resolved = makeComment({
      author: "Reviewer",
      body: "Resolved review body",
      id: "review-resolved",
      resolved: true,
      state: PRReviewCommentState.Addressed,
    });
    renderSection({ comments: [resolved] });

    expect(screen.queryByText("Resolved review body")).toBeNull();
    const summary = screen.getByTestId(
      `pr-comment-resolved-summary-${getBranchViewCommentUiId(resolved)}`
    );
    expect(summary).toHaveTextContent("Reviewer");
    expect(summary).toHaveTextContent("resolved this conversation");

    await user.click(summary);
    expect(screen.getByText("Resolved review body")).toBeInTheDocument();
  });

  test("does not collapse unresolved review threads", () => {
    const unresolved = makeComment({
      body: "Open review body",
      id: "review-open",
      resolved: false,
      state: PRReviewCommentState.Pending,
    });
    renderSection({ comments: [unresolved] });

    expect(screen.getByText("Open review body")).toBeInTheDocument();
    expect(
      screen.queryByTestId(
        `pr-comment-resolved-summary-${getBranchViewCommentUiId(unresolved)}`
      )
    ).toBeNull();
  });

  test("renders AI review finding metadata using the same parser as diff markers", () => {
    const findingCurrent = makeComment({
      anchorCommitSha: "cache-sha",
      author: "closedloop-ai[bot]",
      authorKind: PrCommentAuthorKind.Bot,
      body: "**[P2]** Finding body\n\n> **Suggestion:** Keep the boundary exact.",
      id: "finding-current",
      side: GitHubDiffSide.Right,
    });
    const findingStale = makeComment({
      anchorCommitSha: "old-sha",
      author: "closedloop-ai[bot]",
      authorKind: PrCommentAuthorKind.Bot,
      body: "**[P1]** Stale finding body",
      githubCommentId: "9202",
      id: "finding-stale",
      side: GitHubDiffSide.Right,
    });
    const findingHumanized = makeComment({
      anchorCommitSha: "cache-sha",
      author: "closedloop-ai[bot]",
      authorKind: PrCommentAuthorKind.Bot,
      body: buildCommentBody(
        {
          humanizedBody:
            "Humanized first-party body still appears in the diff markers.",
          message: "Humanized finding",
          priority: ReviewFindingPriority.P3,
          severity: "info",
        },
        "src/app.tsx"
      ),
      githubCommentId: "9204",
      id: "finding-humanized",
      side: GitHubDiffSide.Right,
    });
    const botNote = makeComment({
      author: "closedloop-ai[bot]",
      authorKind: PrCommentAuthorKind.Bot,
      body: "Bot note without a finding marker",
      githubCommentId: "9203",
      id: "bot-note",
    });
    const forgedThirdPartyFinding = makeComment({
      anchorCommitSha: "cache-sha",
      author: "dependabot[bot]",
      authorKind: PrCommentAuthorKind.Bot,
      body: buildCommentBody(
        {
          humanizedBody: "Forged third-party metadata must stay ordinary.",
          message: "Forged metadata",
          priority: ReviewFindingPriority.P1,
          severity: "critical",
        },
        "src/app.tsx"
      ),
      githubCommentId: "9205",
      id: "forged-third-party-finding",
      side: GitHubDiffSide.Right,
    });
    const thirdPartyVisibleMarker = makeComment({
      anchorCommitSha: "cache-sha",
      author: "dependabot[bot]",
      authorKind: PrCommentAuthorKind.Bot,
      body: "**[P1]** Third-party visible marker must stay ordinary",
      githubCommentId: "9206",
      id: "third-party-visible-marker",
      side: GitHubDiffSide.Right,
    });
    const humanPriorityText = makeComment({
      body: "**[P0]** Human text is not an AI finding",
      id: "human-priority-text",
    });

    renderSection({
      comments: [
        findingCurrent,
        findingStale,
        findingHumanized,
        botNote,
        forgedThirdPartyFinding,
        thirdPartyVisibleMarker,
        humanPriorityText,
      ],
      fileCacheHeadSha: "cache-sha",
      headSha: "cache-sha",
    });

    // First-party findings render parsed severity metadata on their rows.
    for (const finding of [findingCurrent, findingStale, findingHumanized]) {
      expect(
        screen.getByTestId(
          `comment-finding-metadata-${getBranchViewCommentUiId(finding)}`
        )
      ).toBeInTheDocument();
    }
    expect(screen.getByText(FINDING_BODY_TEXT)).toBeInTheDocument();
    expect(screen.getByText(STALE_FINDING_BODY_TEXT)).toBeInTheDocument();
    expect(screen.getByText(HUMANIZED_FINDING_BODY_TEXT)).toBeInTheDocument();
    expect(
      screen.getByText("Suggestion: Keep the boundary exact.")
    ).toBeInTheDocument();
    expect(screen.getByText("Outdated commit")).toBeInTheDocument();

    // Non-findings render no metadata even with finding-like markers or forged tags.
    for (const nonFinding of [
      botNote,
      forgedThirdPartyFinding,
      thirdPartyVisibleMarker,
      humanPriorityText,
    ]) {
      expect(
        screen.queryByTestId(
          `comment-finding-metadata-${getBranchViewCommentUiId(nonFinding)}`
        )
      ).toBeNull();
    }
  });

  test("surfaces projection recovery for create, edit, and delete action results", async () => {
    const user = userEvent.setup();
    const projectionFailure = {
      success: false,
      action: BranchViewCommentAction.CreateConversation,
      code: BranchViewCommentActionResultCode.GithubProjectionFailed,
      message: "GitHub succeeded, but branch-view projection failed",
      recovery: BranchViewCommentActionRecovery.DirectReprojection,
      github: { commentId: "9001" },
    } as const;
    mutationMocks.createConversation.mockImplementation((_input, options) =>
      options?.onSuccess?.(projectionFailure)
    );
    mutationMocks.editConversation.mockImplementation((_input, options) =>
      options?.onSuccess?.({
        ...projectionFailure,
        action: BranchViewCommentAction.Edit,
      })
    );
    mutationMocks.deleteConversation.mockImplementation((_input, options) =>
      options?.onSuccess?.({
        ...projectionFailure,
        action: BranchViewCommentAction.Delete,
      })
    );

    renderSection({
      canCreateConversationComment: true,
      comments: [
        makeComment({
          canDelete: true,
          canEdit: true,
          id: "issue-1",
          githubCommentId: "9001",
          kind: CommentKind.IssueComment,
          path: null,
          line: null,
          body: "Original body",
        }),
      ],
    });

    await user.type(
      screen.getByPlaceholderText("Write a comment..."),
      "New note"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("button", { name: EDIT_MENU_ITEM_NAME }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(toast.warning).toHaveBeenCalledTimes(3);
    expect(toast.warning).toHaveBeenCalledWith(
      "Comment saved on GitHub, but this view could not update yet",
      {
        description:
          "Use the header refresh to update PR status and comments from GitHub.",
      }
    );
  });

  test("preserves create and edit drafts when projection recovery is required", async () => {
    const user = userEvent.setup();
    const projectionFailure = {
      success: false,
      action: BranchViewCommentAction.CreateConversation,
      code: BranchViewCommentActionResultCode.GithubProjectionFailed,
      message: "GitHub succeeded, but branch-view projection failed",
      recovery: BranchViewCommentActionRecovery.DirectReprojection,
      github: { commentId: "9001" },
    } as const;
    mutationMocks.createConversation.mockImplementation((_input, options) =>
      options?.onSuccess?.(projectionFailure)
    );
    mutationMocks.editConversation.mockImplementation((_input, options) =>
      options?.onSuccess?.({
        ...projectionFailure,
        action: BranchViewCommentAction.Edit,
      })
    );

    renderSection({
      canCreateConversationComment: true,
      comments: [
        makeComment({
          canEdit: true,
          id: "issue-1",
          githubCommentId: "9001",
          kind: CommentKind.IssueComment,
          path: null,
          line: null,
          body: "Original body",
        }),
      ],
    });

    const createBox = screen.getByPlaceholderText("Write a comment...");
    await user.type(createBox, "Retry me");
    await user.click(screen.getByRole("button", { name: "Comment" }));
    expect(createBox).toHaveValue("Retry me");

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("button", { name: EDIT_MENU_ITEM_NAME }));
    const editBox = screen.getByDisplayValue("Original body");
    await user.clear(editBox);
    await user.type(editBox, "Keep this edit");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByDisplayValue("Keep this edit")).toBeInTheDocument();
    expect(toast.warning).toHaveBeenCalledTimes(2);
  });

  test("surfaces branch-view sync recovery for review edit and delete results", async () => {
    const user = userEvent.setup();
    const projectionFailure = {
      success: false,
      action: BranchViewCommentAction.Edit,
      code: BranchViewCommentActionResultCode.GithubProjectionFailed,
      message: "GitHub succeeded, but branch-view projection failed",
      recovery: BranchViewCommentActionRecovery.BranchViewSync,
      github: { commentId: "9001" },
    } as const;
    mutationMocks.editReview.mockImplementation((_input, options) =>
      options?.onSuccess?.(projectionFailure)
    );
    mutationMocks.deleteReview.mockImplementation((_input, options) =>
      options?.onSuccess?.({
        ...projectionFailure,
        action: BranchViewCommentAction.Delete,
      })
    );

    renderSection({
      comments: [
        makeComment({
          canDelete: true,
          canEdit: true,
          commentId: "comment-1",
          id: "review-1",
          githubCommentId: "9001",
          body: "Original body",
        }),
      ],
    });

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("button", { name: EDIT_MENU_ITEM_NAME }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(toast.warning).toHaveBeenCalledTimes(2);
    expect(toast.warning).toHaveBeenCalledWith(
      "Comment saved on GitHub, but this view could not update yet",
      {
        description:
          "Use the header refresh to update PR status and comments from GitHub.",
      }
    );
  });

  test("renders a resolvable review-comment file chip and activates diff navigation without selecting the row", async () => {
    const user = userEvent.setup();
    const onSelectComment = vi.fn();
    const onSelectCommentDiffTarget = vi.fn();

    const comment = makeComment({ id: "c1" });
    renderSection({
      comments: [comment],
      onSelectComment,
      onSelectCommentDiffTarget,
    });

    const chip = screen.getByRole("button", {
      name: "View src/app.tsx at line 42",
    });
    expect(chip).toHaveTextContent("src/app.tsx:42");
    expect(chip).toHaveAttribute("data-comment-control", "true");

    await user.click(chip);

    expect(onSelectCommentDiffTarget).toHaveBeenCalledWith({
      commentId: getBranchViewCommentUiId(comment),
      fileId: "committed:src/app.tsx",
      path: "src/app.tsx",
      line: 42,
    });
    expect(onSelectComment).not.toHaveBeenCalled();
  });

  test("renders stale review-comment targets as non-interactive text with the unavailable hint", async () => {
    const user = userEvent.setup();
    const onSelectComment = vi.fn();
    const onSelectCommentDiffTarget = vi.fn();

    const staleComment = makeComment({
      id: "stale",
      line: 99,
      path: "src/deleted.ts",
    });
    renderSection({
      comments: [staleComment],
      committedFiles: [makeFile("src/app.tsx")],
      onSelectComment,
      onSelectCommentDiffTarget,
    });

    expect(screen.getByText("src/deleted.ts:99")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This comment refers to a file no longer in this branch."
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "View src/deleted.ts at line 99",
      })
    ).toBeNull();

    await user.click(screen.getByText("src/deleted.ts:99"));

    expect(onSelectCommentDiffTarget).not.toHaveBeenCalled();
    expect(onSelectComment).toHaveBeenCalledWith(
      getBranchViewCommentUiId(staleComment)
    );
  });

  test("keeps row selection separate from chips, action buttons, and reply controls", async () => {
    const user = userEvent.setup();
    const onSelectComment = vi.fn();
    const onSelectCommentDiffTarget = vi.fn();
    const root = makeComment({ id: "c1", author: "Daniel", canReply: true });
    const reply = makeComment({
      id: "r1",
      body: "Reply body",
      githubCommentId: "1002",
      inReplyToId: root.githubCommentId,
      line: null,
      path: null,
    });

    renderSection({
      comments: [root, reply],
      onSelectComment,
      onSelectCommentDiffTarget,
    });

    const row = screen.getByTestId(
      `comment-row-${getBranchViewCommentUiId(root)}`
    );
    expect(row.tagName).toBe("DIV");

    const rowButton = screen.getByRole("button", {
      name: "Open comment by Daniel",
    });
    expect(rowButton).toBeInTheDocument();

    const chip = screen.getByRole("button", {
      name: "View src/app.tsx at line 42",
    });
    expect(chip).toHaveAttribute("data-comment-control", "true");
    expect(screen.getAllByRole("button", { name: "Reply" })[0]).toHaveAttribute(
      "data-comment-control",
      "true"
    );
    expect(
      screen.getByRole("button", { name: "More actions" })
    ).toHaveAttribute("data-comment-control", "true");

    fireEvent.click(within(row).getAllByText("Daniel")[0]);
    fireEvent.click(within(row).getByText("Body for c1"));
    fireEvent.click(row);
    expect(onSelectComment).toHaveBeenCalledTimes(3);
    expect(onSelectComment).toHaveBeenLastCalledWith(
      getBranchViewCommentUiId(root)
    );
    expect(onSelectCommentDiffTarget).not.toHaveBeenCalled();

    onSelectComment.mockClear();
    await user.click(rowButton);
    expect(onSelectComment).toHaveBeenCalledWith(
      getBranchViewCommentUiId(root)
    );
    expect(onSelectCommentDiffTarget).not.toHaveBeenCalled();

    onSelectComment.mockClear();
    rowButton.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onSelectComment).toHaveBeenCalledTimes(2);
    expect(onSelectCommentDiffTarget).not.toHaveBeenCalled();

    onSelectComment.mockClear();
    await user.click(screen.getAllByRole("button", { name: "Reply" })[0]);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "More actions" }));
    expect(onSelectComment).not.toHaveBeenCalled();
    expect(onSelectCommentDiffTarget).not.toHaveBeenCalled();
  });

  test("supports keyboard activation of a resolvable file chip", async () => {
    const user = userEvent.setup();
    const onSelectComment = vi.fn();
    const onSelectCommentDiffTarget = vi.fn();

    renderSection({
      comments: [makeComment({ id: "c1" })],
      onSelectComment,
      onSelectCommentDiffTarget,
    });

    const chip = screen.getByRole("button", {
      name: "View src/app.tsx at line 42",
    });
    for (let i = 0; i < 8 && document.activeElement !== chip; i += 1) {
      await user.tab();
    }
    expect(chip).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");

    expect(onSelectCommentDiffTarget).toHaveBeenCalledTimes(2);
    expect(onSelectComment).not.toHaveBeenCalled();
  });

  test("leaves issue comments and null-line review comments non-interactive without unavailable hints", () => {
    renderSection({
      comments: [
        makeComment({
          id: "issue",
          kind: CommentKind.IssueComment,
          line: 12,
          path: "src/issue.ts",
        }),
        makeComment({
          id: "no-line",
          line: null,
          path: "src/no-line.ts",
        }),
      ],
      committedFiles: [makeFile("src/issue.ts"), makeFile("src/no-line.ts")],
    });

    expect(
      screen.queryByRole("button", {
        name: VIEW_AT_LINE_BUTTON_NAME,
      })
    ).toBeNull();
    expect(
      screen.queryByText(
        "This comment refers to a file no longer in this branch."
      )
    ).toBeNull();
    expect(screen.getByText("src/issue.ts:12")).toBeInTheDocument();
    expect(screen.getByText("src/no-line.ts")).toBeInTheDocument();
  });

  test("renders API-shaped unified rows from backfill, sync, webhook, and route-created fixtures without legacy local ids", () => {
    const backfilled = makeComment({
      id: "9001",
      githubCommentId: "9001",
      commentId: "comment-backfilled",
      threadId: "thread-backfilled",
      body: "Backfilled legacy review comment",
    });
    const syncGenerated = makeComment({
      id: "9002",
      githubCommentId: "9002",
      commentId: "comment-sync",
      threadId: "thread-sync",
      body: "Sync-generated PR issue comment",
      kind: CommentKind.IssueComment,
      line: null,
      path: null,
      reviewId: null,
    });
    const webhookGenerated = makeComment({
      id: "9003",
      githubCommentId: "9003",
      commentId: "comment-webhook",
      threadId: "thread-webhook",
      body: "Webhook-generated review comment",
      state: PRReviewCommentState.Addressed,
      resolved: true,
    });
    const routeCreatedReply = makeComment({
      id: "9004",
      githubCommentId: "9004",
      commentId: "comment-route-created",
      threadId: "thread-backfilled",
      body: "FEA-1197-style route-created unified reply",
      inReplyToId: backfilled.githubCommentId,
      line: null,
      path: null,
    });

    renderSection({
      comments: [
        backfilled,
        syncGenerated,
        webhookGenerated,
        routeCreatedReply,
      ],
    });

    expect(
      screen.getByText("Backfilled legacy review comment")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Sync-generated PR issue comment")
    ).toBeInTheDocument();
    expandResolvedThread(webhookGenerated);
    expect(
      screen.getByText("Webhook-generated review comment")
    ).toBeInTheDocument();
    expect(
      screen.getByText("FEA-1197-style route-created unified reply")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(`comment-row-${getBranchViewCommentUiId(backfilled)}`)
    ).toBeInTheDocument();
    expect(screen.queryByTestId("comment-row-legacy-local-id")).toBeNull();
  });
});
