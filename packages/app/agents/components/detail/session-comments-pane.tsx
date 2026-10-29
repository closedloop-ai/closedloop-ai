"use client";

import type { TraceTextAnchor } from "@repo/api/src/types/comment";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import type { CommentThreadDto } from "@repo/api/src/types/comment-thread-dto";
import {
  createArtifactAnchorAdapter,
  createCommentAnchorRegistry,
  createTraceAnchorAdapter,
} from "@repo/app/shared/comments/comment-anchor-adapters";
import type { CommentsDataSource } from "@repo/app/shared/comments/comments-data-source";
import {
  NO_COLLECTION_CAPABILITIES,
  useArtifactComments,
  useHttpCommentsDataSource,
} from "@repo/app/shared/comments/use-artifact-comments";
import { CommentsPane } from "@repo/app/shared/components/comments/comments-pane";
import {
  anchorPreviewText,
  COMMENTS_NARROW_QUERY,
  NO_ANCHOR_STATE_LABELS,
} from "@repo/app/shared/components/comments/comments-pane-model";
import { useCommentsPaneDrafts } from "@repo/app/shared/components/comments/use-comments-pane-drafts";
import {
  CommentsPaneOpenKey,
  CommentsPaneWidthKey,
  useCommentsPaneVisibility,
  useCommentsPaneWidth,
  useEndCommentsPaneTransient,
} from "@repo/app/shared/components/comments/use-comments-pane-state";
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
// The mention composer reads the organization's members, which the users
// slice owns; the comments channel is addressed by the viewer's organization.
import { renderOrgMentionPaneComposer } from "@repo/app/users/components/org-mention-composer";
import { useCurrentUser } from "@repo/app/users/hooks/use-users";
import { useMediaQuery } from "@repo/design-system/hooks/use-media-query";
import type { RefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_COMMENTS_RAIL_WIDTH } from "./session-detail-workspace";

export type SessionCommentsPaneProps = {
  sessionId: string;
  /**
   * Whether the Sessions tab, where the legacy rail sat, is on screen. Off it
   * the pane stays mounted and renders nothing, so its drafts survive.
   */
  visible: boolean;
  /** The shell's ISS-10795 reveal: the Sessions tab is selected before the jump. */
  selectTabThenReveal: (
    tab: typeof ArtifactDetailTab.Sessions,
    reveal: () => void
  ) => void;
  /** The trace's row jump, published while the trace is mounted. */
  traceJump: RefObject<((row: number) => void) | null>;
  /** The trace passage last selected; it is where a new thread anchors. */
  traceSelection: TraceTextAnchor | null;
  /**
   * The passage a revealed thread anchors to, for the trace to highlight. The
   * host also spends the trace selection here, so it cannot mask the reveal.
   */
  onRevealedAnchorChange: (anchor: TraceTextAnchor | null) => void;
  /** A thread was posted on the trace selection, which is now spent. */
  onTraceSelectionUsed: () => void;
  /**
   * ISS-11004: the thread a `?comment=` link addressed, null while the
   * Sessions tab is not on screen. It is selected and its pane revealed.
   */
  addressedThreadId?: string | null;
};

/**
 * PLN-2162 M6.1: the Session's comments on the unified API, mounted in the
 * Session shell's `comments` slot in place of the legacy trace-comments rail.
 */
export function SessionCommentsPane(props: SessionCommentsPaneProps) {
  const dataSource = useHttpCommentsDataSource();
  const organizationId = useCurrentUser().data?.organizationId;
  return (
    <SessionCommentsPaneContent
      {...props}
      dataSource={dataSource}
      organizationId={organizationId}
    />
  );
}

export function SessionCommentsPaneContent({
  addressedThreadId,
  dataSource,
  onRevealedAnchorChange,
  onTraceSelectionUsed,
  organizationId,
  selectTabThenReveal,
  sessionId,
  traceJump,
  traceSelection,
  visible,
}: SessionCommentsPaneProps & {
  dataSource: CommentsDataSource;
  organizationId: string | null | undefined;
}) {
  const comments = useArtifactComments(
    { id: sessionId },
    { dataSource, organizationId }
  );
  const { drafts, onDraftChange } = useCommentsPaneDrafts(sessionId);
  const { commitWidth, setLiveWidth, width } = useCommentsPaneWidth(
    CommentsPaneWidthKey.Session,
    DEFAULT_COMMENTS_RAIL_WIDTH
  );
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const narrow = useMediaQuery(COMMENTS_NARROW_QUERY);
  const currentTraceSelection = useRef(traceSelection);
  useEffect(() => {
    currentTraceSelection.current = traceSelection;
  }, [traceSelection]);
  const { hideTransiently, open, setOpen, showTransiently } =
    useCommentsPaneVisibility(CommentsPaneOpenKey.Session);
  useEndCommentsPaneTransient(CommentsPaneOpenKey.Session, sessionId);
  // ISS-12300 D6: a new trace selection and an addressed link reveal the pane
  // for this visit without writing the saved preference.
  useEffect(() => {
    if (traceSelection !== null) {
      showTransiently();
    }
  }, [showTransiently, traceSelection]);
  useEffect(() => {
    if (addressedThreadId) {
      showTransiently();
    }
  }, [addressedThreadId, showTransiently]);
  // The pane scrolls to a selection when it changes, so an address is selected
  // only once its thread is listed, as the legacy rail's `selectedIsRendered`
  // waited: a cold link would otherwise mark a thread it never scrolls to.
  const addressedIsListed =
    addressedThreadId !== null &&
    addressedThreadId !== undefined &&
    comments.threads.some((thread) => thread.id === addressedThreadId);
  useEffect(() => {
    if (addressedThreadId && addressedIsListed) {
      setSelectedThreadId(addressedThreadId);
    }
  }, [addressedThreadId, addressedIsListed]);
  const registry = useMemo(
    () =>
      createCommentAnchorRegistry([
        createArtifactAnchorAdapter(),
        createTraceAnchorAdapter({
          captureSelection: () => traceSelection,
          jumpToRow: (row) =>
            selectTabThenReveal(ArtifactDetailTab.Sessions, () =>
              traceJump.current?.(row)
            ),
        }),
      ]),
    [selectTabThenReveal, traceJump, traceSelection]
  );
  const composerAnchor = registry.capture(CommentAnchorKind.Trace);

  if (!(visible && open)) {
    return null;
  }
  const reveal = (thread: CommentThreadDto) => {
    setSelectedThreadId(thread.id);
    if (!registry.reveal(thread)) {
      return;
    }
    onRevealedAnchorChange(traceAnchorOf(thread));
    // The narrow pane is a Sheet over the trace; it steps aside for the jump.
    if (narrow) {
      hideTransiently();
    }
  };
  const onCreateThread: typeof comments.onCreateThread = async (input) => {
    const posted = traceSelection;
    await comments.onCreateThread(input);
    // A passage selected while the post was in flight is not the one spent.
    if (
      input.anchor.kind === CommentAnchorKind.Trace &&
      currentTraceSelection.current === posted
    ) {
      onTraceSelectionUsed();
    }
  };
  return (
    <CommentsPane
      anchorStateLabels={NO_ANCHOR_STATE_LABELS}
      capabilities={comments.capabilities ?? NO_COLLECTION_CAPABILITIES}
      composerTarget={
        composerAnchor
          ? {
              anchor: composerAnchor,
              label: anchorPreviewText(composerAnchor) ?? undefined,
            }
          : null
      }
      drafts={drafts}
      identity={sessionId}
      loadState={comments.loadState}
      onCreateThread={onCreateThread}
      onDelete={comments.onDelete}
      onDraftChange={onDraftChange}
      onEdit={comments.onEdit}
      onOpenChange={setOpen}
      onReopen={comments.onReopen}
      onReply={comments.onReply}
      onResolve={comments.onResolve}
      onRetryLoad={comments.onRetryLoad}
      onRetrySync={comments.onRetrySync}
      onRevealAnchor={reveal}
      onSelectThread={setSelectedThreadId}
      onWidthChange={setLiveWidth}
      onWidthCommit={commitWidth}
      open
      pendingDraftKeys={comments.pendingDraftKeys}
      renderComposer={renderOrgMentionPaneComposer}
      revealableAnchorKinds={registry.revealableAnchorKinds}
      selectedThreadId={selectedThreadId}
      threads={comments.threads}
      width={width}
    />
  );
}

function traceAnchorOf(thread: CommentThreadDto): TraceTextAnchor | null {
  if (thread.anchor?.kind !== CommentAnchorKind.Trace) {
    return null;
  }
  const { kind: _kind, ...anchor } = thread.anchor;
  return anchor;
}
