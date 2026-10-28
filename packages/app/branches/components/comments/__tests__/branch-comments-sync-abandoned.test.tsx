/**
 * @file branch-comments-sync-abandoned.test.tsx
 * @description ISS-10383: the failed badge and the manual retry a dead-lettered
 * trace comment gets on the BRANCH comments surface, asserted through the real
 * `BranchCommentsWorkspace` -> `BranchCommentCard` composition rather than the
 * card alone — the card's mount is the half that was missing, so mounting it
 * directly would assert the fix without asserting it is reachable.
 *
 * THE FLAG IS NOT A VARIABLE FOR THE RENDER (operator ruling 2026-09-16, carried
 * from ISS-8597). This surface reads no key: the terminal WRITE is gated on
 * `trace-comment-sync-abandoned`, so `syncAbandoned` can only be set on a row the
 * feature produced, and a second read here could only SUBTRACT — hiding the
 * recovery door from a row that is already terminal. So the key-CLOSED case below
 * asserts that BOTH affordances still render, and it is the regression guard
 * against anyone adding the read to this surface.
 *
 * The permutation that does matter is the comment's own delivery state, and the
 * healthy-comment case is the positive sibling for every case above it: SAME two
 * locators, only the delivery state changed, plus a positive assertion that the
 * card itself rendered. Without it a locator that matches nothing would satisfy
 * the negatives and a surface that stopped mounting would read as green.
 */

import { CommentSurface, CommentTargetType } from "@repo/api/src/types/comment";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { TRACE_COMMENT_SYNC_ABANDONED_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BranchCommentSource,
  BranchCommentsTab,
  type BranchCommentsWorkspaceProps,
  type BranchCommentThread,
} from "../branch-comments-model";
import { BranchCommentsWorkspace } from "../branch-comments-workspace";

/**
 * The shipped copy, spelled out rather than imported from the component it
 * polices. A constant imported from the source would follow the source if the
 * wording silently changed; a literal here goes red instead. These are the SAME
 * two strings the Sessions rail's suite and both e2e specs pin, which is what
 * makes "one implementation" observable rather than asserted.
 */
const BADGE_TEXT = "Sync failed";
/** ISS-10827: what a viewer who is NOT the author is told instead. */
const READER_BADGE_TEXT = "Author's edit never synced";
const RETRY_BUTTON_NAME = "Retry syncing trace note";
const COMMENT_BODY = "This comment never reached the cloud";

const BRANCH_TARGET = {
  id: "branch-1",
  type: CommentTargetType.Branch,
} as const;

beforeEach(() => {
  stubMatchMedia();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Branch comments sync_abandoned affordances (ISS-10383)", () => {
  it("renders the failed badge and a retry that re-pends the comment's own collection", async () => {
    const user = userEvent.setup();
    const onRetrySync = vi.fn();

    // NO adapter mounted, which is also the Storybook and bare-render path. A
    // surface that reads no key needs none; one that grew a read would fail here
    // rather than silently resolving the key closed.
    renderWorkspace({
      comments: [makeThread({ syncAbandoned: true })],
      onRetrySync,
    });

    expect(screen.getByText(BADGE_TEXT)).toBeVisible();
    await user.click(screen.getByRole("button", { name: RETRY_BUTTON_NAME }));

    // The routing is the half a hard-coded handler would get wrong: this surface
    // renders Branch-detail, Branch-timeline and Session rows in one list, and
    // the port addresses them by target PLUS collection.
    expect(onRetrySync).toHaveBeenCalledWith(
      "thread-1",
      BRANCH_TARGET,
      undefined
    );
  });

  it("re-pends a Sessions-tab timeline row against its own collection", async () => {
    // The shape `commentCollections` really produces for that tab's branch
    // collection: a BRANCH target on the BranchTimeline surface. A session-target
    // row there carries no collection at all, so pairing the two would pin a call
    // shape production cannot make.
    const user = userEvent.setup();
    const onRetrySync = vi.fn();

    renderWorkspace({
      activeTab: BranchCommentsTab.Sessions,
      comments: [
        makeThread({
          collectionQuery: { surface: CommentSurface.BranchTimeline },
          syncAbandoned: true,
          tab: BranchCommentsTab.Sessions,
        }),
      ],
      onRetrySync,
    });

    await user.click(screen.getByRole("button", { name: RETRY_BUTTON_NAME }));

    expect(onRetrySync).toHaveBeenCalledWith("thread-1", BRANCH_TARGET, {
      surface: CommentSurface.BranchTimeline,
    });
  });

  it("offers no retry door on a row this source cannot address", () => {
    // The version-skewed desktop shell: `retrySync` exists, so the surface has a
    // handler, but this row's collection is one the source refuses. The honest
    // render is the badge with no button — a button that throws on click is the
    // dead door this ticket exists to close, and the refusal is per COLLECTION
    // while the handler is per source.
    renderWorkspace({
      comments: [makeThread({ canRetrySync: false, syncAbandoned: true })],
      onRetrySync: vi.fn(),
    });

    expect(screen.getByText(BADGE_TEXT)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: RETRY_BUTTON_NAME })
    ).not.toBeInTheDocument();
  });

  it("renders BOTH affordances with the key closed — the write gate is the only gate", async () => {
    // A dead-lettered row outlives the key that produced it (a rollback), and on
    // desktop the renderer's own assignment settles CLOSED whenever its fetch
    // fails. Either way the author must still be told, and still be able to act.
    const user = userEvent.setup();
    const onRetrySync = vi.fn();

    renderWorkspace({
      comments: [makeThread({ syncAbandoned: true })],
      flagEnabled: false,
      onRetrySync,
    });

    expect(screen.getByText(BADGE_TEXT)).toBeVisible();
    await user.click(screen.getByRole("button", { name: RETRY_BUTTON_NAME }));
    expect(onRetrySync).toHaveBeenCalledWith(
      "thread-1",
      BRANCH_TARGET,
      undefined
    );
  });

  it("renders neither badge nor retry for a healthy branch comment", () => {
    renderWorkspace({
      comments: [makeThread({})],
      flagEnabled: true,
      onRetrySync: vi.fn(),
    });

    // The positive control: the card DID render, so the two absences below are
    // about the delivery state and not about a workspace that never mounted.
    expect(screen.getByText(COMMENT_BODY)).toBeVisible();
    expect(screen.queryByText(BADGE_TEXT)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: RETRY_BUTTON_NAME })
    ).not.toBeInTheDocument();
  });

  it("still states the failure when the source cannot re-pend, and offers no dead button", () => {
    // A source that cannot re-pend — since ISS-10382 gave the cloud HTTP source
    // a retry, that is a version-skewed desktop bridge or a provider thread, not
    // the web shell. The controller hands such a surface no handler. A badge with
    // nothing to click is the honest render; a button that throws on click is
    // not.
    renderWorkspace({
      comments: [makeThread({ syncAbandoned: true })],
      flagEnabled: true,
    });

    expect(screen.getByText(BADGE_TEXT)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: RETRY_BUTTON_NAME })
    ).not.toBeInTheDocument();
  });

  it("ISS-10827: tells a non-author whose delivery failed, while an author on the same dead source keeps the author's wording", () => {
    // The pair, in one test, because the distinction is the whole change:
    // "no retry button" is NOT the same question as "not the author". The row
    // above has a dead source and an AUTHOR and keeps "Sync failed"; this one has
    // a dead source and a READER and must not. Keying the copy on the handler
    // instead of on authorship passes the reader case and fails this pairing.
    renderWorkspace({
      comments: [
        // A READER on a dead source: no button, and not their failure.
        makeThread({
          canEditRoot: false,
          canRetrySync: false,
          id: "thread-reader",
          syncAbandoned: true,
        }),
        // An AUTHOR on the SAME dead source: also no button, and it IS their
        // failure. This row is the whole point — it is indistinguishable from
        // the one above by "was I handed a retry handler", so an implementation
        // that keys the copy on the handler tells this author the edit was
        // somebody else's.
        makeThread({
          canRetrySync: false,
          id: "thread-author-dead-source",
          syncAbandoned: true,
        }),
        // An author on a live source, so the pairing cannot be satisfied by a
        // render that simply dropped every button.
        makeThread({ id: "thread-author", syncAbandoned: true }),
      ],
      flagEnabled: true,
      onRetrySync: vi.fn(),
    });

    // Exactly one reader and exactly two authors, counted rather than probed:
    // a `getByText` pair would pass a render that gave the reader's wording to
    // the dead-source author as well.
    // One assertion over every badge in the render, read through the ROLE.
    // Counting defeats the handler-keyed implementation, which would give two
    // readers; reading through `role="status"` means the reader's badge is still
    // the live region the author's is, so scoping the copy cannot quietly demote
    // it to plain text; and comparing the whole list refuses a render that
    // emitted both wordings for one row.
    expect(
      screen.getAllByRole("status").map((badge) => badge.textContent)
    ).toEqual([READER_BADGE_TEXT, BADGE_TEXT, BADGE_TEXT]);
    expect(
      screen.getAllByRole("button", { name: RETRY_BUTTON_NAME })
    ).toHaveLength(1);
  });
});

/**
 * `flagEnabled` is OPTIONAL, and omitting it mounts NO adapter at all — which is
 * the Storybook and bare-render path. A surface that reads no key must render the
 * same with an adapter, without one, and with the key explicitly closed.
 */
function renderWorkspace({
  flagEnabled,
  ...overrides
}: Partial<BranchCommentsWorkspaceProps> & { flagEnabled?: boolean }) {
  const workspace = <BranchCommentsWorkspace {...makeProps(overrides)} />;
  return render(
    flagEnabled === undefined ? workspace : withFlag(flagEnabled, workspace)
  );
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

function makeProps(
  overrides: Partial<BranchCommentsWorkspaceProps> = {}
): BranchCommentsWorkspaceProps {
  return {
    activeTab: BranchCommentsTab.Details,
    branchId: "branch-1",
    comments: [makeThread({})],
    onClose: vi.fn(),
    onJump: vi.fn(),
    onWidthChange: vi.fn(),
    open: true,
    renderedSessionIds: ["session-a"],
    returnFocusRef: { current: null },
    width: 380,
    ...overrides,
  };
}

function makeThread(
  overrides: Partial<BranchCommentThread>
): BranchCommentThread {
  return {
    anchor: {
      id: "anchor-1",
      label: "line 42",
      trace: {
        actor: null,
        endOffset: 20,
        row: 42,
        selectedText: "selected trace text",
        sessionId: "session-a",
        sourceText: "source selected trace text",
        startOffset: 0,
        traceId: "trace-1",
        turnId: "turn-1",
      },
    },
    author: { avatarUrl: null, id: "maya", name: "Maya Chen" },
    body: COMMENT_BODY,
    canDeleteThread: false,
    canRetrySync: true,
    // ISS-10827: the AUTHOR, because `canRetrySync: true` above is only
    // reachable for one — `canRetrySyncFor` conjoins `comment.canEdit` — and the
    // badge copy is now scoped on the same authorship. The previous
    // `canEditRoot: false` default paired a reader with a working retry door,
    // which production cannot produce.
    canEditRoot: true,
    canReply: false,
    createdAtLabel: "10:00 AM",
    id: "thread-1",
    replies: [],
    source: BranchCommentSource.Platform,
    tab: BranchCommentsTab.Details,
    target: BRANCH_TARGET,
    ...overrides,
  };
}

function stubMatchMedia() {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        addEventListener: () => undefined,
        addListener: () => undefined,
        dispatchEvent: () => false,
        matches: false,
        media: query,
        onchange: null,
        removeEventListener: () => undefined,
        removeListener: () => undefined,
      }) as unknown as MediaQueryList
  );
}
