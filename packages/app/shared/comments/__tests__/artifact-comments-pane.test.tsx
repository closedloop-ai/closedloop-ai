import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/api-error";
import { CommentsPaneContent } from "../../components/comments/comments-pane";
import {
  FULL_CAPABILITIES,
  makeComment,
  READ_ONLY_CAPABILITIES,
} from "../../components/comments/comments-pane.fixtures";
import {
  COMMENTS_COUNT_UNAVAILABLE_LABEL,
  NO_ANCHOR_STATE_LABELS,
} from "../../components/comments/comments-pane-model";
import { useCommentsPaneDrafts } from "../../components/comments/use-comments-pane-drafts";
import { createTestQueryClient } from "../../test-utils";
import {
  type CommentsDataSource,
  createHttpCommentsDataSource,
} from "../comments-data-source";
import { useArtifactComments } from "../use-artifact-comments";
import {
  ARTIFACT_ID,
  fakeCommentsSource,
  ORG_ID,
  threadsOf,
} from "./comments-test-source";

const FLOW_TIMEOUT_MS = 20_000;

/** The shape M6's hosts take: the hook's state and writes, straight into the pane. */
function Host({ source }: { source: CommentsDataSource }) {
  const comments = useArtifactComments(
    { id: ARTIFACT_ID },
    { dataSource: source, organizationId: ORG_ID }
  );
  const { drafts, onDraftChange } = useCommentsPaneDrafts(ARTIFACT_ID);
  return (
    <CommentsPaneContent
      anchorStateLabels={NO_ANCHOR_STATE_LABELS}
      capabilities={comments.capabilities ?? READ_ONLY_CAPABILITIES}
      drafts={drafts}
      identity={ARTIFACT_ID}
      loadState={comments.loadState}
      onDraftChange={onDraftChange}
      onEdit={comments.onEdit}
      onRetryLoad={comments.onRetryLoad}
      pendingDraftKeys={comments.pendingDraftKeys}
      threads={comments.threads}
    />
  );
}

function renderHost(source: CommentsDataSource) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <Host source={source} />
    </QueryClientProvider>
  );
}

describe("the comments pane on useArtifactComments", {
  timeout: FLOW_TIMEOUT_MS,
}, () => {
  it("shows a failed read as the error state, never as zero comments (ISS-11213 AC6)", async () => {
    const source = fakeCommentsSource();
    source.list.mockRejectedValue(new ApiError("boom", 500));

    renderHost(source);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(
      screen.getByText(COMMENTS_COUNT_UNAVAILABLE_LABEL)
    ).toBeInTheDocument();
    expect(screen.queryAllByRole("group")).toHaveLength(0);
  });

  it("shows a list that fails its schema as the error state, not as zero comments", async () => {
    const api = {
      get: vi.fn(() =>
        Promise.resolve({
          capabilities: FULL_CAPABILITIES,
          threads: "none",
          nextCursor: null,
        })
      ),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    };

    renderHost(createHttpCommentsDataSource(api));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(
      screen.getByText(COMMENTS_COUNT_UNAVAILABLE_LABEL)
    ).toBeInTheDocument();
    expect(screen.queryAllByRole("group")).toHaveLength(0);
  });

  it("keeps the edit draft on a stale_revision save and renders the newer revision", async () => {
    const user = userEvent.setup();
    const [held] = threadsOf(1);
    const root = held.comments[0]!;
    const source = fakeCommentsSource([held]);
    source.update.mockRejectedValue(
      new ApiError(CommentErrorCode.StaleRevision, 409, {
        code: CommentErrorCode.StaleRevision,
      })
    );
    source.getThread.mockResolvedValue({
      ...held,
      revision: held.revision + 1,
      comments: [
        root,
        makeComment({ body: "Reply written elsewhere", threadId: held.id }),
      ],
    });
    renderHost(source);
    const card = await screen.findByRole("group");

    await user.click(
      within(card).getByRole("button", { name: "Edit comment" })
    );
    const editor = screen.getByRole("textbox", { name: "Edit comment" });
    await user.clear(editor);
    await user.click(editor);
    await user.paste("My edit");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("Reply written elsewhere")
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Edit comment" })).toHaveValue(
      "My edit"
    );
    expect(source.update).toHaveBeenCalledExactlyOnceWith(root.id, {
      body: "My edit",
      expectedRevision: root.revision,
    });
  });
});
