import {
  BranchCommentsState,
  BranchPrCommentKind,
  type BranchPrCommentKind as BranchPrCommentKindType,
} from "@repo/api/src/types/branch";
import { CommentSurface, CommentTargetType } from "@repo/api/src/types/comment";
import { TRACE_COMMENT_SELECTION_GUIDANCE } from "@repo/app/shared/components/comments/comments-pane-model";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BranchCommentSource,
  BranchCommentsTab,
  type BranchCommentThread,
} from "../branch-comments-model";
import { BranchCommentsWorkspace } from "../branch-comments-workspace";
import {
  makeAnchor,
  makeAuthor,
  makeProps,
  makeProviderProvenance,
  makeThread,
  renderWorkspace,
  stubMatchMedia,
} from "./branch-comments-workspace.test-fixtures";

const FORBIDDEN_ACTIONS =
  /react|resolve|unresolve|edit reply|reply to reply|file anchor/i;
const UNAVAILABLE_SESSION_NOTE = /session-b are unavailable/i;
const RESOLVED_LABEL = "Resolved";
const REVIEW_COMMENT_METADATA = /Review comment · Unresolved/;
const REVIEW_REPLY_METADATA = new RegExp(`Review reply · ${RESOLVED_LABEL}`);
const GITHUB_LINK_NAME = /on GitHub/;
const BODY_TRUNCATED_METADATA = /Body truncated/;
const STALE_METADATA = /Stale/;
const UNKNOWN_METADATA = /unknown/i;
const UNAVAILABLE_COUNT_LABEL = "Unavailable";

beforeEach(() => {
  stubMatchMedia(() => false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BranchCommentsWorkspace", () => {
  it("shows only Branch/details platform comments and the selected PR provider comments", () => {
    renderWorkspace({
      activeTab: BranchCommentsTab.Details,
      comments: [
        makeThread({ body: "Branch details note" }),
        makeThread({
          body: "Selected PR note",
          id: "provider-selected",
          pullRequestKey: "owner/repo#12",
          source: BranchCommentSource.Provider,
        }),
        makeThread({
          body: "Historical PR note",
          id: "provider-other",
          pullRequestKey: "owner/repo#11",
          source: BranchCommentSource.Provider,
        }),
        makeThread({
          body: "Session note",
          id: "session-note",
          tab: BranchCommentsTab.Sessions,
          target: {
            id: "session-a",
            type: CommentTargetType.Session,
          },
        }),
      ],
      selectedPullRequestKey: "owner/repo#12",
    });

    expect(screen.getByText("Branch details note")).toBeInTheDocument();
    expect(screen.getByText("Selected PR note")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "PR Comments 1" })
    ).toBeInTheDocument();
    expect(screen.queryByText("Historical PR note")).not.toBeInTheDocument();
    expect(screen.queryByText("Session note")).not.toBeInTheDocument();
  });

  it("shows timeline Branch comments and rendered Session comments only", () => {
    renderWorkspace({
      activeTab: BranchCommentsTab.Sessions,
      comments: [
        makeThread({
          body: "Timeline note",
          collectionQuery: { surface: CommentSurface.BranchTimeline },
          id: "timeline-note",
          tab: BranchCommentsTab.Sessions,
        }),
        makeThread({
          body: "Rendered Session note",
          id: "rendered-session-note",
          tab: BranchCommentsTab.Sessions,
          target: {
            id: "session-a",
            type: CommentTargetType.Session,
          },
        }),
        makeThread({
          body: "Unavailable Session note",
          id: "unavailable-session-note",
          tab: BranchCommentsTab.Sessions,
          target: {
            id: "session-b",
            type: CommentTargetType.Session,
          },
        }),
        makeThread({
          body: "PR note",
          id: "provider-note",
          pullRequestKey: "owner/repo#12",
          source: BranchCommentSource.Provider,
        }),
      ],
      coverageNote:
        "Comments from session-b are unavailable because that Session did not render.",
      renderedSessionIds: ["session-a"],
    });

    expect(screen.getByText("Timeline note")).toBeInTheDocument();
    expect(screen.getByText("Rendered Session note")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Session Comments 2 shown" })
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Unavailable Session note")
    ).not.toBeInTheDocument();
    expect(screen.queryByText("PR note")).not.toBeInTheDocument();
    expect(screen.getByText(UNAVAILABLE_SESSION_NOTE)).toBeInTheDocument();
  });

  it("marks the provider count as bounded from the canonical availability state", () => {
    renderWorkspace({
      comments: [
        makeThread({
          body: "Selected PR note",
          id: "provider-selected",
          pullRequestKey: "owner/repo#12",
          source: BranchCommentSource.Provider,
        }),
      ],
      providerAvailability: {
        bodyTruncatedCount: 0,
        mixedProjection: false,
        omittedComments: 0,
        providerTruncated: false,
        responseTruncated: false,
        stale: false,
        state: BranchCommentsState.OverLimitTruncated,
      },
      selectedPullRequestKey: "owner/repo#12",
    });

    expect(
      screen.getByRole("heading", { name: "PR Comments 1 shown" })
    ).toBeInTheDocument();
    expect(
      screen.getByText("Provider comment coverage is truncated.")
    ).toBeInTheDocument();
  });

  // ISS-7370: the heading's count slot and the panel body speak for the same
  // read, so the three states have to be distinguishable from each other AND
  // agree with each other. The pessimistic word belongs to the failed read only.
  describe("count slot vs panel body (loading / error / real zero)", () => {
    it("leaves the count slot empty and skeletons it while the read is in flight", () => {
      const { container } = renderWorkspace({
        comments: [],
        composerTarget: null,
        isLoading: true,
      });

      expect(
        screen.getByRole("heading", { name: "PR Comments" })
      ).toBeInTheDocument();
      expect(
        screen.queryByText(UNAVAILABLE_COUNT_LABEL)
      ).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent("Loading comments…");
      expect(
        container.querySelector('[data-slot="skeleton"]')
      ).toBeInTheDocument();
      // The skeleton is aria-hidden, so the region carries the only machine-
      // readable claim that this content is still settling.
      expect(
        screen.getByRole("region", { name: "Branch comments" })
      ).toHaveAttribute("aria-busy", "true");
    });

    it("says Unavailable in the count slot only when the read failed", () => {
      const { container } = renderWorkspace({
        comments: [],
        composerTarget: null,
        hasError: true,
      });

      expect(
        screen.getByRole("heading", {
          name: `PR Comments ${UNAVAILABLE_COUNT_LABEL}`,
        })
      ).toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Comments are unavailable in this view."
      );
      expect(screen.queryByText("Loading comments…")).not.toBeInTheDocument();
      expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
      expect(
        screen.getByRole("region", { name: "Branch comments" })
      ).toHaveAttribute("aria-busy", "false");
    });

    it("renders a real zero as 0 with the empty state, not as Unavailable", () => {
      const { container } = renderWorkspace({
        comments: [],
        composerTarget: null,
      });

      expect(
        screen.getByRole("heading", { name: "PR Comments 0" })
      ).toBeInTheDocument();
      expect(screen.getByText("No comments in this view")).toBeInTheDocument();
      expect(
        screen.queryByText(UNAVAILABLE_COUNT_LABEL)
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Loading comments…")).not.toBeInTheDocument();
      expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
    });

    it("keeps the real count and the rendered threads when a refresh reloads over visible comments", () => {
      const { container } = renderWorkspace({
        comments: [
          makeThread({
            body: "Selected PR note",
            id: "provider-selected",
            pullRequestKey: "owner/repo#12",
            source: BranchCommentSource.Provider,
          }),
        ],
        hasError: true,
        isLoading: true,
      });

      expect(
        screen.getByRole("heading", { name: "PR Comments 1" })
      ).toBeInTheDocument();
      expect(screen.getByText("Selected PR note")).toBeInTheDocument();
      expect(
        screen.queryByText(UNAVAILABLE_COUNT_LABEL)
      ).not.toBeInTheDocument();
      expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
    });
  });

  it("renders provider roots and replies without changing platform replies", () => {
    const renderBody = vi.fn((body: string, thread: BranchCommentThread) =>
      thread.source === BranchCommentSource.Provider
        ? `Rendered: ${body}`
        : body
    );
    renderWorkspace({
      comments: [
        makeThread({
          author: {
            avatarUrl: "https://avatars.example/root.png",
            id: "provider-root-author",
            name: "Root Reviewer",
          },
          body: "Provider root",
          id: "provider-root",
          pullRequestKey: "owner/repo#12",
          replies: [
            {
              author: makeAuthor("Provider reply author"),
              body: "Provider reply",
              canDelete: false,
              createdAtLabel: "10:05 AM",
              id: "provider-reply",
              provider: makeProviderProvenance({
                bodyTruncated: true,
                inReplyToId: "provider-root",
                kind: BranchPrCommentKind.ReviewReply,
                login: "provider-reply-author",
                providerUrl:
                  "https://github.com/owner/repo/pull/12#discussion_r2",
                resolved: true,
                stale: true,
              }),
            },
          ],
          provider: makeProviderProvenance({
            bodyTruncated: true,
            login: "root-reviewer",
            providerUrl: "https://github.com/owner/repo/pull/12#discussion_r1",
            resolved: false,
            stale: true,
          }),
          source: BranchCommentSource.Provider,
        }),
        makeThread({
          body: "Platform root",
          id: "platform-root",
          replies: [
            {
              author: makeAuthor("Platform reply author"),
              body: "Platform reply",
              canDelete: true,
              createdAtLabel: "10:06 AM",
              id: "platform-reply",
            },
          ],
        }),
      ],
      renderBody,
      selectedPullRequestKey: "owner/repo#12",
    });

    expect(screen.getByText("Rendered: Provider root")).toBeInTheDocument();
    expect(screen.getByText("Rendered: Provider reply")).toBeInTheDocument();
    expect(
      screen.getByText("Root Reviewer · @root-reviewer")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Provider reply author · @provider-reply-author")
    ).toBeInTheDocument();
    expect(screen.getAllByText(BODY_TRUNCATED_METADATA)).toHaveLength(2);
    expect(screen.getAllByText(STALE_METADATA)).toHaveLength(2);
    expect(screen.getByText(REVIEW_COMMENT_METADATA)).toBeInTheDocument();
    expect(screen.getByText(REVIEW_REPLY_METADATA)).toBeInTheDocument();
    expect(
      screen.getAllByRole("link", { name: GITHUB_LINK_NAME })
    ).toHaveLength(2);
    expect(screen.getByText("Platform root")).toBeInTheDocument();
    expect(screen.getByText("Platform reply")).toBeInTheDocument();
    expect(
      screen.queryByText("Rendered: Platform root")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Rendered: Platform reply")
    ).not.toBeInTheDocument();
    expect(renderBody).toHaveBeenCalledTimes(3);
  });

  it("does not fabricate optional provider provenance", () => {
    renderWorkspace({
      comments: [
        makeThread({
          author: makeAuthor("reviewer"),
          body: "Provider issue without optional metadata",
          id: "provider-null-optionals",
          provider: makeProviderProvenance({
            kind: BranchPrCommentKind.Issue,
            line: null,
            path: null,
            providerUrl: null,
            resolved: null,
          }),
          pullRequestKey: "owner/repo#12",
          source: BranchCommentSource.Provider,
        }),
      ],
      selectedPullRequestKey: "owner/repo#12",
    });

    expect(screen.getByText("@reviewer")).toBeInTheDocument();
    expect(screen.getByText("GitHub · Issue comment")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(
      screen.queryByText(RESOLVED_LABEL, { exact: false })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(UNKNOWN_METADATA)).not.toBeInTheDocument();
  });

  it("falls back safely for a version-skewed provider kind", () => {
    renderWorkspace({
      comments: [
        makeThread({
          author: makeAuthor("reviewer"),
          body: "Provider comment from a newer server",
          id: "provider-future-kind",
          provider: makeProviderProvenance({
            kind: "future-provider-comment" as BranchPrCommentKindType,
            providerUrl:
              "https://github.com/owner/repo/pull/12#issuecomment-42",
          }),
          pullRequestKey: "owner/repo#12",
          source: BranchCommentSource.Provider,
        }),
      ],
      selectedPullRequestKey: "owner/repo#12",
    });

    expect(screen.getByText("GitHub · Provider comment")).toBeInTheDocument();
    expect(
      screen.getByRole("link", {
        name: "View provider comment by @reviewer on GitHub",
      })
    ).toBeInTheDocument();
  });

  it("renders the exact native action allowlist and no provider mutations", async () => {
    const user = userEvent.setup();
    const onDeleteReply = vi.fn();
    const onDeleteThread = vi.fn();
    const onEditRoot = vi.fn();
    const onJump = vi.fn();
    const onReply = vi.fn();

    renderWorkspace({
      comments: [
        makeThread({
          body: "Native root",
          replies: [
            {
              author: makeAuthor("Reply author"),
              body: "Owned reply",
              canDelete: true,
              createdAtLabel: "10:05 AM",
              id: "reply-1",
            },
          ],
        }),
        makeThread({
          body: "Provider root",
          id: "provider-root",
          pullRequestKey: "owner/repo#12",
          source: BranchCommentSource.Provider,
        }),
      ],
      onDeleteReply,
      onDeleteThread,
      onEditRoot,
      onJump,
      onReply,
      selectedPullRequestKey: "owner/repo#12",
    });

    await user.click(screen.getByRole("button", { name: "Jump to line 42" }));
    await user.click(screen.getByRole("button", { name: "Delete thread" }));
    await user.click(screen.getByRole("button", { name: "Delete reply" }));
    expect(onJump).toHaveBeenCalledWith(makeAnchor(), {
      id: "branch-1",
      type: CommentTargetType.Branch,
    });
    const branchDetailsTarget = {
      id: "branch-1",
      type: CommentTargetType.Branch,
    };
    expect(onDeleteThread).toHaveBeenCalledWith(
      "thread-1",
      branchDetailsTarget,
      undefined
    );
    expect(onDeleteReply).toHaveBeenCalledWith(
      "reply-1",
      branchDetailsTarget,
      undefined
    );

    await user.click(screen.getByRole("button", { name: "Edit comment" }));
    const editBox = screen.getByRole("textbox", { name: "Edit root comment" });
    await user.clear(editBox);
    expect(editBox).toHaveValue("");
    await user.type(editBox, "Edited native root");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onEditRoot).toHaveBeenCalledWith(
      "thread-1",
      branchDetailsTarget,
      undefined,
      "Edited native root"
    );

    await user.click(screen.getByRole("button", { name: "Reply to comment" }));
    await user.type(
      screen.getByRole("textbox", { name: "Reply to root comment" }),
      "Flat reply"
    );
    await user.click(screen.getByRole("button", { name: "Reply" }));
    expect(onReply).toHaveBeenCalledWith(
      "thread-1",
      branchDetailsTarget,
      undefined,
      "Flat reply"
    );
    expect(screen.queryByText(FORBIDDEN_ACTIONS)).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Edit comment" })
    ).toHaveLength(1);
  }, 15_000);

  it("keeps drafts isolated by tab, target, and anchor across PR changes and collapse", async () => {
    const user = userEvent.setup();
    const props = makeProps();
    const { rerender } = render(<BranchCommentsWorkspace {...props} />);

    const detailsDraft = screen.getByRole("textbox", {
      name: "Comment on line 42",
    });
    await user.type(detailsDraft, "Details draft");

    rerender(
      <BranchCommentsWorkspace
        {...props}
        selectedPullRequestKey="owner/repo#11"
      />
    );
    expect(
      screen.getByRole("textbox", { name: "Comment on line 42" })
    ).toHaveValue("Details draft");

    rerender(<BranchCommentsWorkspace {...props} open={false} />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    rerender(<BranchCommentsWorkspace {...props} />);
    expect(
      screen.getByRole("textbox", { name: "Comment on line 42" })
    ).toHaveValue("Details draft");

    const sessionTarget = {
      anchor: makeAnchor("session-a line 8", "session-anchor"),
      target: {
        id: "session-a",
        type: CommentTargetType.Session,
      },
    } as const;
    rerender(
      <BranchCommentsWorkspace
        {...props}
        activeTab={BranchCommentsTab.Sessions}
        composerTarget={sessionTarget}
      />
    );
    const sessionDraft = screen.getByRole("textbox", {
      name: "Comment on session-a line 8",
    });
    expect(sessionDraft).toHaveValue("");
    await user.type(sessionDraft, "Session draft");

    rerender(<BranchCommentsWorkspace {...props} />);
    expect(
      screen.getByRole("textbox", { name: "Comment on line 42" })
    ).toHaveValue("Details draft");
    rerender(
      <BranchCommentsWorkspace
        {...props}
        activeTab={BranchCommentsTab.Sessions}
        composerTarget={sessionTarget}
      />
    );
    expect(
      screen.getByRole("textbox", { name: "Comment on session-a line 8" })
    ).toHaveValue("Session draft");
  }, 15_000);

  it("hides an out-of-scope Session composer and restores its draft when the Session renders again", async () => {
    const user = userEvent.setup();
    const sessionTarget = {
      anchor: makeAnchor("session-a line 8", "session-anchor"),
      target: { id: "session-a", type: CommentTargetType.Session },
    } as const;
    const props = makeProps({
      activeTab: BranchCommentsTab.Sessions,
      composerTarget: sessionTarget,
      renderedSessionIds: ["session-a"],
    });
    const { rerender } = render(<BranchCommentsWorkspace {...props} />);

    await user.type(
      screen.getByRole("textbox", { name: "Comment on session-a line 8" }),
      "Session A draft"
    );
    rerender(
      <BranchCommentsWorkspace {...props} renderedSessionIds={["session-c"]} />
    );
    expect(
      screen.queryByRole("textbox", { name: "Comment on session-a line 8" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(TRACE_COMMENT_SELECTION_GUIDANCE)
    ).toBeInTheDocument();

    rerender(<BranchCommentsWorkspace {...props} />);
    expect(
      screen.getByRole("textbox", { name: "Comment on session-a line 8" })
    ).toHaveValue("Session A draft");
  });

  it("requires the Branch target surface to match the active tab", () => {
    const detailsTarget = {
      anchor: makeAnchor(),
      target: { id: "branch-1", type: CommentTargetType.Branch },
    } as const;
    const { rerender } = render(
      <BranchCommentsWorkspace
        {...makeProps({ composerTarget: detailsTarget })}
      />
    );
    expect(
      screen.getByRole("textbox", { name: "Comment on line 42" })
    ).toBeInTheDocument();

    rerender(
      <BranchCommentsWorkspace
        {...makeProps({
          activeTab: BranchCommentsTab.Sessions,
          composerTarget: detailsTarget,
        })}
      />
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    rerender(
      <BranchCommentsWorkspace
        {...makeProps({
          activeTab: BranchCommentsTab.Sessions,
          composerTarget: {
            ...detailsTarget,
            collectionQuery: {
              surface: CommentSurface.BranchTimeline,
            },
          },
        })}
      />
    );
    expect(
      screen.getByRole("textbox", { name: "Comment on line 42" })
    ).toBeInTheDocument();
  });

  it("clears an unsent draft when the workspace unmounts", async () => {
    const user = userEvent.setup();
    const props = makeProps();
    const first = render(<BranchCommentsWorkspace {...props} />);
    await user.type(
      screen.getByRole("textbox", { name: "Comment on line 42" }),
      "Temporary draft"
    );
    first.unmount();

    render(<BranchCommentsWorkspace {...props} />);
    expect(
      screen.getByRole("textbox", { name: "Comment on line 42" })
    ).toHaveValue("");
  });

  it("resets drafts, composer modes, and pending state when the Branch changes", async () => {
    const user = userEvent.setup();
    let resolveCreate: (() => void) | undefined;
    const pendingCreate = new Promise<void>((resolve) => {
      resolveCreate = resolve;
    });
    const props = makeProps({ onCreate: () => pendingCreate });
    const { rerender } = render(<BranchCommentsWorkspace {...props} />);

    await user.type(
      screen.getByRole("textbox", { name: "Comment on line 42" }),
      "Branch one draft"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));
    await user.click(screen.getByRole("button", { name: "Reply to comment" }));
    await user.type(
      screen.getByRole("textbox", { name: "Reply to root comment" }),
      "Branch one reply"
    );

    const branchTwoTarget = {
      anchor: makeAnchor("line 9", "anchor-2"),
      target: { id: "branch-2", type: CommentTargetType.Branch },
    } as const;
    rerender(
      <BranchCommentsWorkspace
        {...props}
        branchId="branch-2"
        comments={[
          makeThread({
            id: "thread-2",
            target: branchTwoTarget.target,
          }),
        ]}
        composerTarget={branchTwoTarget}
      />
    );

    const branchTwoComposer = screen.getByRole("textbox", {
      name: "Comment on line 9",
    });
    expect(branchTwoComposer).toHaveValue("");
    expect(branchTwoComposer).toBeEnabled();
    expect(
      screen.queryByRole("textbox", { name: "Reply to root comment" })
    ).not.toBeInTheDocument();

    await act(async () => resolveCreate?.());
    expect(branchTwoComposer).toHaveValue("");
    expect(branchTwoComposer).toBeEnabled();
  }, 15_000);

  it("does not let a stale first-Branch completion clear a fresh draft after returning to that Branch", async () => {
    const user = userEvent.setup();
    let resolveFirstCreate: (() => void) | undefined;
    const firstCreate = new Promise<void>((resolve) => {
      resolveFirstCreate = resolve;
    });
    const props = makeProps({ onCreate: () => firstCreate });
    const { rerender } = render(<BranchCommentsWorkspace {...props} />);

    await user.type(
      screen.getByRole("textbox", { name: "Comment on line 42" }),
      "Old Branch A draft"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));

    const branchBTarget = {
      anchor: makeAnchor("line 7", "anchor-b"),
      target: { id: "branch-b", type: CommentTargetType.Branch },
    } as const;
    rerender(
      <BranchCommentsWorkspace
        {...props}
        branchId="branch-b"
        comments={[]}
        composerTarget={branchBTarget}
      />
    );
    rerender(<BranchCommentsWorkspace {...props} />);

    const freshBranchAComposer = screen.getByRole("textbox", {
      name: "Comment on line 42",
    });
    await user.type(freshBranchAComposer, "Fresh Branch A draft");
    await act(async () => resolveFirstCreate?.());

    expect(freshBranchAComposer).toHaveValue("Fresh Branch A draft");
    expect(freshBranchAComposer).toBeEnabled();
  }, 15_000);

  it("preserves a failed native draft and clears it after successful persistence", async () => {
    const user = userEvent.setup();
    const failedCreate = vi.fn().mockRejectedValue(new Error("offline"));
    const props = makeProps({ onCreate: failedCreate });
    const { rerender } = render(<BranchCommentsWorkspace {...props} />);
    const composer = screen.getByRole("textbox", {
      name: "Comment on line 42",
    });
    await user.type(composer, "Retry me");
    await user.click(screen.getByRole("button", { name: "Comment" }));
    expect(await screen.findByDisplayValue("Retry me")).toBeInTheDocument();

    const successfulCreate = vi.fn().mockResolvedValue(undefined);
    rerender(
      <BranchCommentsWorkspace {...props} onCreate={successfulCreate} />
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));
    expect(successfulCreate).toHaveBeenCalledWith({
      anchor: makeAnchor(),
      body: "Retry me",
      collectionQuery: undefined,
      tab: BranchCommentsTab.Details,
      target: { id: "branch-1", type: CommentTargetType.Branch },
    });
    expect(await screen.findByRole("textbox")).toHaveValue("");
  });

  it("uses the adaptive wide resize rail and narrow Sheet", () => {
    const wide = renderWorkspace();
    expect(
      screen.getByRole("separator", { name: "Resize comments rail" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    wide.unmount();

    stubMatchMedia((query) => query.includes("1024px"));
    renderWorkspace();
    expect(
      screen.getByRole("dialog", { name: "Comments" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("separator", { name: "Resize comments rail" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Comments for the Branch details view.")
    ).toBeInTheDocument();
  });

  it("labels the narrow Sessions Sheet with the active tab scope", () => {
    stubMatchMedia((query) => query.includes("1024px"));
    renderWorkspace({ activeTab: BranchCommentsTab.Sessions });

    expect(
      screen.getByText("Comments for the Sessions and timeline view.")
    ).toBeInTheDocument();
  });

  it("closes the mobile Sheet on Escape and returns focus to the comments toggle", async () => {
    stubMatchMedia(() => true);
    const user = userEvent.setup();
    render(<MobileWorkspaceHarness />);

    const toggle = screen.getByRole("button", { name: "Show comments" });
    await user.click(toggle);
    expect(
      screen.getByRole("dialog", { name: "Comments" })
    ).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});

function MobileWorkspaceHarness() {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        aria-controls="test-comments-rail"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        ref={toggleRef}
        type="button"
      >
        Show comments
      </button>
      <BranchCommentsWorkspace
        {...makeProps({
          onClose: () => setOpen(false),
          open,
          railId: "test-comments-rail",
          returnFocusRef: toggleRef,
        })}
      />
    </>
  );
}
