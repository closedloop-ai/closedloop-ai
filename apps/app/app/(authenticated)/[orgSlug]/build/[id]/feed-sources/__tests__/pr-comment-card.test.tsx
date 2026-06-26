// @vitest-environment jsdom
import {
  type BranchViewComment,
  BranchViewCommentWriteIdentityStatus,
  PRReviewCommentState,
} from "@repo/api/src/types/branch-view";
import { FeedItemKind } from "@repo/app/documents/components/feed-sidebar/feed-item";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BranchViewProvider } from "../../branch-view-context";
import { getBranchViewCommentUiId } from "../../comment-context";
import { BranchViewCommentIdentityBlockerProvider } from "../../components/branch-view-comment-identity-blocker-store";
import { PrCommentCard } from "../pr-comment-card";
import type { PrCommentItem } from "../pr-comment-types";
import { makeBranchViewContextValue, makeComment } from "./test-utils";

const CONNECT_GITHUB_LINK_NAME = /Connect GitHub/u;
const RECONNECT_GITHUB_LINK_NAME = /Reconnect GitHub/u;

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/markdown", () => ({
  CommentMarkdown: ({ children }: { children: string }) => (
    <div data-testid="md">{children}</div>
  ),
}));

function makeItem(
  root: BranchViewComment,
  replies: BranchViewComment[] = []
): PrCommentItem {
  return {
    id: root.id,
    kind: FeedItemKind.PrComment,
    sourceId: "pr-comment",
    createdAt: new Date(root.createdAt),
    threadId: root.id,
    root,
    replies,
    finding: null,
    findingAnchor: null,
    commentFileTarget: null,
  };
}

function renderCard(
  item: PrCommentItem,
  selectedCommentId: string | null = null,
  input: { onSelectComment?: (id: string | null) => void } = {}
) {
  const value = makeBranchViewContextValue({
    comments: [item.root, ...item.replies],
    selectedCommentId,
  });
  if (input.onSelectComment) {
    value.onSelectComment = input.onSelectComment;
  }

  return render(
    <BranchViewCommentIdentityBlockerProvider
      buildId="branch-artifact-1"
      orgSlug="acme"
    >
      <BranchViewProvider value={value}>
        <PrCommentCard item={item} />
      </BranchViewProvider>
    </BranchViewCommentIdentityBlockerProvider>
  );
}

describe("PrCommentCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the comment body in the expanded state", () => {
    const item = makeItem(makeComment({ body: "Hello world" }));
    renderCard(item);
    expect(screen.getByTestId("md").textContent).toBe("Hello world");
  });

  it("renders the collapsed row when the root is resolved", () => {
    const item = makeItem(
      makeComment({
        resolved: true,
        state: PRReviewCommentState.Addressed,
      })
    );
    renderCard(item);
    expect(screen.getByText("Comment resolved")).toBeInTheDocument();
  });

  it("expands the collapsed row when the user clicks it", () => {
    const item = makeItem(
      makeComment({
        body: "Hello world",
        resolved: true,
        state: PRReviewCommentState.Addressed,
      })
    );
    renderCard(item);
    const collapsedButton = screen
      .getByText("Comment resolved")
      .closest("button");
    expect(collapsedButton).not.toBeNull();
    if (collapsedButton) {
      fireEvent.click(collapsedButton);
    }
    expect(screen.getByTestId("md").textContent).toBe("Hello world");
  });

  it("starts expanded when the comment is the selected permalink target", () => {
    const root = makeComment({
      id: "c_42",
      body: "Selected body",
      resolved: true,
      state: PRReviewCommentState.Addressed,
    });
    const item = makeItem(root);
    renderCard(item, getBranchViewCommentUiId(root));
    expect(screen.queryByText("Comment resolved")).toBeNull();
  });

  it("selects the comment when the card surface is clicked", () => {
    const root = makeComment({ id: "c_42", body: "Selected body" });
    const item = makeItem(root);
    const onSelectComment = vi.fn();

    renderCard(item, null, { onSelectComment });

    fireEvent.click(
      screen.getByTestId(`pr-comment-card-${getBranchViewCommentUiId(root)}`)
    );

    expect(onSelectComment).toHaveBeenCalledWith(
      getBranchViewCommentUiId(root)
    );
  });

  it("renders projected management reconnect prompts outside the action menu", () => {
    const root = makeComment({
      canDelete: true,
      actionPromptEligibility: {
        reply: { prompt: false },
        edit: { prompt: false },
        delete: {
          prompt: true,
          identityBlocker: {
            status: BranchViewCommentWriteIdentityStatus.Expired,
          },
        },
        resolve: { prompt: false },
        unresolve: { prompt: false },
      },
    });
    const item = makeItem(root);

    renderCard(item);

    const prompt = screen.getByTestId("branch-view-github-identity-prompt");
    expect(prompt).toHaveTextContent("Reconnect GitHub to comment");
    const link = screen.getByRole("link", {
      name: RECONNECT_GITHUB_LINK_NAME,
    });
    expect(link).toHaveAttribute(
      "href",
      "/api/integrations/github?returnTo=%2Facme%2Fbuild%2Fbranch-artifact-1"
    );
    expect(prompt.closest('[role="menu"]')).toBeNull();
  });

  it("does not select the comment when the Connect GitHub CTA is clicked", () => {
    const root = makeComment({
      actionPromptEligibility: {
        reply: {
          prompt: true,
          identityBlocker: {
            status: BranchViewCommentWriteIdentityStatus.Missing,
          },
        },
        edit: { prompt: false },
        delete: { prompt: false },
        resolve: { prompt: false },
        unresolve: { prompt: false },
      },
    });
    const item = makeItem(root);
    const onSelectComment = vi.fn();

    renderCard(item, null, { onSelectComment });

    const link = screen.getByRole("link", { name: CONNECT_GITHUB_LINK_NAME });
    link.addEventListener("click", (event) => event.preventDefault());

    fireEvent.click(link);

    expect(onSelectComment).not.toHaveBeenCalled();
  });

  it("collapses same-card reply and management identity prompts to one recovery prompt", () => {
    const root = makeComment({
      canDelete: true,
      canReply: true,
      actionPromptEligibility: {
        reply: {
          prompt: true,
          identityBlocker: {
            status: BranchViewCommentWriteIdentityStatus.Missing,
          },
        },
        edit: { prompt: false },
        delete: {
          prompt: true,
          identityBlocker: {
            status: BranchViewCommentWriteIdentityStatus.Missing,
          },
        },
        resolve: { prompt: false },
        unresolve: { prompt: false },
      },
    });
    const item = makeItem(root);

    renderCard(item);

    const prompts = screen.getAllByTestId("branch-view-github-identity-prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toHaveTextContent("Connect GitHub to comment");
    expect(
      screen.getByRole("link", { name: CONNECT_GITHUB_LINK_NAME })
    ).toHaveAttribute(
      "href",
      "/api/integrations/github?returnTo=%2Facme%2Fbuild%2Fbranch-artifact-1"
    );
  });

  it("collapses reply-row management identity prompts into the card-level prompt", () => {
    const root = makeComment({
      actionPromptEligibility: {
        reply: {
          prompt: true,
          identityBlocker: {
            status: BranchViewCommentWriteIdentityStatus.Missing,
          },
        },
        edit: { prompt: false },
        delete: { prompt: false },
        resolve: { prompt: false },
        unresolve: { prompt: false },
      },
    });
    const reply = makeComment({
      id: "reply-1",
      inReplyToId: root.id,
      actionPromptEligibility: {
        reply: { prompt: false },
        edit: {
          prompt: true,
          identityBlocker: {
            status: BranchViewCommentWriteIdentityStatus.Missing,
          },
        },
        delete: { prompt: false },
        resolve: { prompt: false },
        unresolve: { prompt: false },
      },
    });
    const item = makeItem(root, [reply]);

    renderCard(item);

    expect(
      screen.getAllByTestId("branch-view-github-identity-prompt")
    ).toHaveLength(1);
  });

  it("uses a stacked non-truncating prompt layout for narrow sidebars", () => {
    const root = makeComment({
      actionPromptEligibility: {
        reply: {
          prompt: true,
          identityBlocker: {
            status: BranchViewCommentWriteIdentityStatus.Missing,
          },
        },
        edit: { prompt: false },
        delete: { prompt: false },
        resolve: { prompt: false },
        unresolve: { prompt: false },
      },
    });
    const item = makeItem(root);

    renderCard(item);

    const prompt = screen.getByTestId("branch-view-github-identity-prompt");
    const title = screen.getByTestId(
      "branch-view-github-identity-prompt-title"
    );
    expect(prompt).toHaveClass("flex-col");
    expect(title).toHaveTextContent("Connect GitHub to comment");
    expect(title).toHaveClass("whitespace-normal");
    expect(title).not.toHaveClass("truncate");
  });

  it("does not render feed-sidebar prompts for non-identity blockers", () => {
    const root = makeComment({
      canDelete: true,
      actionPromptEligibility: {
        reply: { prompt: false },
        edit: { prompt: false },
        delete: { prompt: false },
        resolve: { prompt: false },
        unresolve: { prompt: false },
      },
    });
    const item = makeItem(root);

    renderCard(item);

    expect(
      screen.queryByTestId("branch-view-github-identity-prompt")
    ).not.toBeInTheDocument();
  });
});
