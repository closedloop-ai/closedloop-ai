/**
 * @file trace-comments-rail-sync-abandoned.test.tsx
 * @description ISS-8597 (PRD-699 §5 D2): the failed badge and the manual retry a
 * dead-lettered trace comment gets on the SHARED comments rail — the one
 * `packages/app` surface both the web shell and the desktop renderer mount, which
 * is what makes this a single suite rather than one per shell.
 *
 * The ROLE/NAME each assertion looks for is spelled out, so a badge that stopped
 * rendering, or a retry button that lost its accessible name, cannot be satisfied
 * by some other element on the card.
 *
 * THE FLAG IS NO LONGER A VARIABLE HERE (operator ruling 2026-09-16). The rail
 * reads no key at all: the terminal WRITE is gated, so `syncAbandoned` can only
 * be set on a row the feature produced, and a second read on this side could only
 * SUBTRACT — hiding the recovery door from a row that is already terminal, which
 * is what it did to an offline renderer and to every row abandoned before a
 * rollback.
 *
 * So the permutation that matters is now the comment's own delivery state, and
 * the case that used to assert "flag closed ⇒ nothing" is INVERTED: with the key
 * closed and an abandoned comment, both affordances must still render. That case
 * is the regression guard against anyone reintroducing the read.
 */

import {
  CommentSurface,
  CommentTargetType,
  ThreadStatus,
  TraceCommentKind,
} from "@repo/api/src/types/comment";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { TRACE_COMMENT_SYNC_ABANDONED_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TraceCommentItem } from "../trace-comments";
import { TraceCommentsRail } from "../trace-comments-rail";

const BADGE_TEXT = "Sync failed";
/**
 * ISS-10827: the READER's wording. A literal here rather than an import, for the
 * reason the author's string is a literal — a constant read back from the
 * component would follow a silent rewording instead of going red.
 */
const READER_BADGE_TEXT = "Author's edit never synced";
const RETRY_BUTTON_NAME = "Retry syncing trace note";

const mockUseOrganizationUsers = vi.fn();
vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: (options?: { enabled?: boolean }) =>
    mockUseOrganizationUsers(options),
}));

beforeEach(() => {
  mockUseOrganizationUsers.mockReturnValue({ data: [] });
});

describe("TraceCommentsRail sync_abandoned affordances (ISS-8597)", () => {
  it("renders the failed badge and a working retry with no flag adapter mounted at all", async () => {
    const user = userEvent.setup();
    const onRetrySync = vi.fn();

    // NO adapter mounted, which is also the Storybook and bare-render path. It
    // used to need one; a rail that reads no key needs nothing.
    renderRail({
      comment: makeComment({ syncAbandoned: true }),
      onRetrySync,
    });

    expect(screen.getByText(BADGE_TEXT)).toBeVisible();
    await user.click(screen.getByRole("button", { name: RETRY_BUTTON_NAME }));

    expect(onRetrySync).toHaveBeenCalledWith("comment-1");
  });

  it("ISS-10827: tells a non-author whose delivery failed, and offers no door the server would 403", () => {
    // ISS-10382. While `syncAbandoned` came only from the desktop's local queue,
    // authorship was implicit — the queue holds the local user's own outgoing
    // rows and nothing else. The cloud serves the field to every viewer of the
    // thread, so a reader now sees a dead-lettered comment they did not write,
    // and the server refuses their retry. A badge with no button is the honest
    // render; a button that can only fail is not.
    const onRetrySync = vi.fn();

    renderRail({
      comment: makeComment({ syncAbandoned: true, canEdit: false }),
      onRetrySync,
    });

    // ISS-10827: the failure is still stated, in the same slot, and now it is
    // stated ACCURATELY. The author's wording claims the comment in front of
    // this reader failed, which is false — they are reading it out of the cloud.
    // What failed is the author's EDIT.
    expect(screen.getByText(READER_BADGE_TEXT)).toBeVisible();
    // And the author's wording is genuinely GONE, not merely joined: without
    // this, a render that emitted both strings would satisfy the line above.
    expect(screen.queryByText(BADGE_TEXT)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: RETRY_BUTTON_NAME })
    ).not.toBeInTheDocument();
  });

  it("renders BOTH affordances with the key closed — the write gate is the only gate", async () => {
    // The inverted case, and the reason the inversion exists: a dead-lettered
    // row can outlive the key that produced it (a rollback), and on desktop the
    // renderer's own assignment settles CLOSED whenever its fetch fails, which
    // is this lane's normal failure state. Either way the author must still be
    // told, and must still be able to act.
    const user = userEvent.setup();
    const onRetrySync = vi.fn();

    renderRail({
      comment: makeComment({ syncAbandoned: true }),
      flagEnabled: false,
      onRetrySync,
    });

    expect(screen.getByText(BADGE_TEXT)).toBeVisible();
    await user.click(screen.getByRole("button", { name: RETRY_BUTTON_NAME }));
    expect(onRetrySync).toHaveBeenCalledWith("comment-1");
  });

  it("renders neither badge nor retry for a healthy comment", () => {
    // The positive control for the two cases above: with the SAME locators and
    // only the comment's delivery state changed, both must vanish. Otherwise the
    // affordances are unconditional and neither case above proves anything.
    renderRail({
      comment: makeComment({}),
      onRetrySync: vi.fn(),
    });

    expect(screen.queryByText(BADGE_TEXT)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: RETRY_BUTTON_NAME })
    ).not.toBeInTheDocument();
    expect(screen.getByText("Original trace note")).toBeVisible();
  });

  it("still states the failure when the surface cannot retry, and offers no dead button", () => {
    // The web/cloud source never dead-letters, so it passes no handler. A badge
    // with nothing to click is the honest render; a button that does nothing is
    // not.
    renderRail({
      comment: makeComment({ syncAbandoned: true }),
      flagEnabled: true,
    });

    expect(screen.getByText(BADGE_TEXT)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: RETRY_BUTTON_NAME })
    ).not.toBeInTheDocument();
  });

  it("does not jump the trace when the retry button is clicked", async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();

    renderRail({
      comment: makeComment({ syncAbandoned: true }),
      flagEnabled: true,
      onJump,
      onRetrySync: vi.fn(),
    });

    await user.click(screen.getByRole("button", { name: RETRY_BUTTON_NAME }));

    // The card is click-to-jump, so a control added inside it must not also
    // scroll the reader's trace out from under them.
    expect(onJump).not.toHaveBeenCalled();
  });

  it("jumps the trace when the card itself is clicked, with the badge rendered", async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();

    renderRail({
      comment: makeComment({ syncAbandoned: true }),
      flagEnabled: true,
      onJump,
      onRetrySync: vi.fn(),
    });

    await user.click(screen.getByText("Original trace note"));

    // The positive half of the pair above: jumping still works on a card that
    // carries the new controls, so the previous case is about the button and not
    // about a jump handler that never fires.
    expect(onJump).toHaveBeenCalled();
  });
});

/**
 * `flagEnabled` is OPTIONAL, and omitting it mounts NO adapter at all — which is
 * the point since the ruling: this rail reads no key, so it must render the same
 * with an adapter, without one, and with the key explicitly closed. A case that
 * passes it is asserting that the flag does not matter, not that it does.
 */
function renderRail({
  comment,
  flagEnabled,
  onJump = vi.fn(),
  onRetrySync,
}: {
  comment: TraceCommentItem;
  flagEnabled?: boolean;
  onJump?: (row: number) => void;
  onRetrySync?: (commentId: string) => void;
}): void {
  const rail = (
    <TraceCommentsRail
      comments={[comment]}
      onJump={onJump}
      onRetrySync={onRetrySync}
    />
  );
  render(flagEnabled === undefined ? rail : withFlag(flagEnabled, rail));
}

function withFlag(enabled: boolean, children: ReactNode): ReactNode {
  return (
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: enabled
          ? [TRACE_COMMENT_SYNC_ABANDONED_FEATURE_FLAG_KEY]
          : [],
      })}
    >
      {children}
    </FeatureFlagAdapterProvider>
  );
}

function makeComment(options: {
  syncAbandoned?: boolean;
  canEdit?: boolean;
}): TraceCommentItem {
  const createdAt = "2026-06-26T15:00:00.000Z";
  return {
    anchor: {
      traceId: "trace-1",
      turnId: "turn-1",
      row: 1,
      selectedText: "selected text",
      sourceText: "source selected text",
      startOffset: 7,
      endOffset: 20,
      sessionId: "session-1",
      actor: null,
    },
    artifactId: "session-1",
    authorAvatarUrl: null,
    authorId: "user-1",
    authorName: "Test User",
    body: "Original trace note",
    canDelete: false,
    canEdit: options.canEdit ?? true,
    createdAt,
    createdAtLabel: "Just now",
    editedAt: null,
    id: "comment-1",
    kind: TraceCommentKind.Comment,
    replies: [],
    resolvedAt: null,
    resolvedByAvatarUrl: null,
    resolvedById: null,
    resolvedByName: null,
    status: ThreadStatus.Open,
    surface: CommentSurface.SessionDetail,
    target: { type: CommentTargetType.Session, id: "session-1" },
    threadId: "thread-1",
    updatedAt: createdAt,
    ...(options.syncAbandoned === undefined
      ? {}
      : { syncAbandoned: options.syncAbandoned }),
  };
}
