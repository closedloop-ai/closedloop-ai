// @vitest-environment jsdom
import { BranchViewCommentWriteIdentityStatus } from "@repo/api/src/types/branch-view";
import { ApiError } from "@repo/app/shared/api/api-error";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BranchViewProvider } from "../../branch-view-context";
import { BranchViewCommentIdentityBlockerProvider } from "../../components/branch-view-comment-identity-blocker-store";
import { PrConversationComposer } from "../pr-conversation-composer";
import { makeBranchViewContextValue } from "./test-utils";

const CONNECT_GITHUB_LINK_NAME = /Connect GitHub/u;
const RECONNECT_GITHUB_LINK_NAME = /Reconnect GitHub/u;

vi.mock("@repo/app/documents/hooks/use-branch-view", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@repo/app/documents/hooks/use-branch-view")
    >();
  return {
    ...actual,
    useCreateBranchViewConversationComment: vi.fn(),
  };
});

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

function renderComposer({
  canCreateConversationComment = false,
  createError,
  prompt = true,
}: {
  canCreateConversationComment?: boolean;
  createError?: unknown;
  prompt?: boolean;
} = {}) {
  const value = makeBranchViewContextValue({ comments: [] });
  value.canCreateConversationComment = canCreateConversationComment;
  value.data.canCreateConversationComment = canCreateConversationComment;
  value.data.commentPromptEligibility = {
    createConversation: prompt
      ? {
          prompt: true,
          identityBlocker: {
            status: BranchViewCommentWriteIdentityStatus.Missing,
          },
        }
      : { prompt: false },
    createInline: { prompt: false },
  };
  const createConversationMutate = value.mutations.createConversation
    .mutate as unknown as Mock;
  if (createError) {
    createConversationMutate.mockImplementation((_payload, options) => {
      options?.onError?.(createError);
    });
  }

  return render(
    <BranchViewCommentIdentityBlockerProvider
      buildId="branch-artifact-1"
      orgSlug="acme"
    >
      <BranchViewProvider value={value}>
        <PrConversationComposer />
      </BranchViewProvider>
    </BranchViewCommentIdentityBlockerProvider>
  );
}

function submitDraft(): void {
  fireEvent.change(screen.getByPlaceholderText("Comment on this PR…"), {
    target: { value: "Needs another look" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Comment" }));
}

describe("PrConversationComposer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the feed-sidebar create prompt with the canonical connect href", () => {
    renderComposer();

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

  it("does not render a create prompt for non-identity blockers", () => {
    renderComposer({ prompt: false });

    expect(
      screen.queryByTestId("branch-view-github-identity-prompt")
    ).not.toBeInTheDocument();
  });

  it("records mutation identity blockers and renders the reconnect prompt", async () => {
    renderComposer({
      canCreateConversationComment: true,
      createError: new ApiError("Reconnect GitHub", 403, {
        details: {
          identityBlocker: {
            status: BranchViewCommentWriteIdentityStatus.Expired,
          },
        },
      }),
      prompt: false,
    });

    submitDraft();

    expect(
      await screen.findByTestId("branch-view-github-identity-prompt")
    ).toHaveTextContent("Reconnect GitHub to comment");
    expect(
      screen.getByRole("link", { name: RECONNECT_GITHUB_LINK_NAME })
    ).toHaveAttribute(
      "href",
      "/api/integrations/github?returnTo=%2Facme%2Fbuild%2Fbranch-artifact-1"
    );
  });

  it("does not render a prompt for non-identity mutation failures", async () => {
    renderComposer({
      canCreateConversationComment: true,
      createError: new ApiError("Provider unavailable", 503),
      prompt: false,
    });

    submitDraft();

    await waitFor(() => {
      expect(
        screen.queryByTestId("branch-view-github-identity-prompt")
      ).not.toBeInTheDocument();
    });
  });
});
