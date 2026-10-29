import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CommentsPaneContent } from "../../../shared/components/comments/comments-pane";
import {
  FULL_CAPABILITIES,
  makeThread,
} from "../../../shared/components/comments/comments-pane.fixtures";
import type { CommentsPaneCallbacks } from "../../../shared/components/comments/comments-pane-contract";
import {
  CommentsPaneLoadStatus,
  NO_ANCHOR_STATE_LABELS,
} from "../../../shared/components/comments/comments-pane-model";
import { useCommentsPaneDrafts } from "../../../shared/components/comments/use-comments-pane-drafts";
import { renderOrgMentionPaneComposer } from "../org-mention-composer";

const MEMBERS = [
  {
    active: true,
    avatarUrl: null,
    email: "<redacted-email>",
    firstName: "Ada",
    id: "u-ada",
    lastName: "Lovelace",
  },
];

vi.mock("../../hooks/use-users", () => ({
  useOrganizationUsers: () => ({ data: MEMBERS }),
}));

const THREAD = makeThread({ id: "thread-1" });

/** A host that keeps the drafts above a pane it can unmount, as both shells do. */
function Host({
  onCreateThread,
  onReply,
}: Pick<CommentsPaneCallbacks, "onCreateThread" | "onReply">) {
  const { drafts, onDraftChange } = useCommentsPaneDrafts("artifact-1");
  const [shown, setShown] = useState(true);
  return (
    <>
      <button onClick={() => setShown((value) => !value)} type="button">
        Toggle pane
      </button>
      {shown ? (
        <CommentsPaneContent
          anchorStateLabels={NO_ANCHOR_STATE_LABELS}
          capabilities={FULL_CAPABILITIES}
          composerTarget={{ anchor: { kind: CommentAnchorKind.Artifact } }}
          drafts={drafts}
          loadState={{ status: CommentsPaneLoadStatus.Ready }}
          onCreateThread={onCreateThread}
          onDraftChange={onDraftChange}
          onReply={onReply}
          renderComposer={renderOrgMentionPaneComposer}
          threads={[THREAD]}
        />
      ) : null}
    </>
  );
}

async function pickAda(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.type(screen.getByRole("textbox", { name }), "@ad");
  await user.click(await screen.findByText("Ada Lovelace"));
}

async function remountPane(user: ReturnType<typeof userEvent.setup>) {
  const toggle = screen.getByRole("button", { name: "Toggle pane" });
  await user.click(toggle);
  await user.click(toggle);
}

describe("renderOrgMentionPaneComposer (PLN-2162 decision 4)", () => {
  it("keeps a new thread's picked mention with the draft across a remount", async () => {
    const user = userEvent.setup();
    const onCreateThread = vi.fn(() => Promise.resolve());
    render(<Host onCreateThread={onCreateThread} />);

    await pickAda(user, "Add a comment");
    await remountPane(user);
    await user.type(
      screen.getByRole("textbox", { name: "Add a comment" }),
      "look"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));

    await waitFor(() =>
      expect(onCreateThread).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          body: "@Ada Lovelace look",
          mentions: ["u-ada"],
        })
      )
    );
  });

  it("keeps a reply's picked mention with the draft across a remount", async () => {
    const user = userEvent.setup();
    const onReply = vi.fn(() => Promise.resolve());
    render(<Host onReply={onReply} />);

    await user.click(screen.getByRole("button", { name: "Reply to comment" }));
    await pickAda(user, "Reply to comment");
    await remountPane(user);
    await user.type(
      screen.getByRole("textbox", { name: "Reply to comment" }),
      "look"
    );
    await user.click(screen.getByRole("button", { name: "Reply" }));

    await waitFor(() =>
      expect(onReply).toHaveBeenCalledExactlyOnceWith(THREAD.id, {
        body: "@Ada Lovelace look",
        mentions: ["u-ada"],
      })
    );
  });
});
