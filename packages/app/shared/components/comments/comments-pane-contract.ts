import type {
  TraceCommentKind,
  TraceCommentMentions,
} from "@repo/api/src/types/comment";
import type { CommentAnchor } from "@repo/api/src/types/comment-anchor";
import type { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import type { CollectionCapabilities } from "@repo/api/src/types/comment-capabilities";
import type {
  CommentDto,
  CommentThreadDto,
} from "@repo/api/src/types/comment-thread-dto";
import type { ReactNode, RefObject } from "react";
import type { CommentsPaneRenderComposer } from "./comments-pane-composer";
import type {
  CommentsPaneAnchorStateLabels,
  CommentsPaneBranchScope,
  CommentsPaneComposerTarget,
  CommentsPaneDraft,
  CommentsPaneDrafts,
  CommentsPaneLayout,
  CommentsPaneLoadState,
} from "./comments-pane-model";
import type { CommentsPaneWriteError } from "./use-pending-submissions";

/**
 * A write callback may return a promise: the pane holds that composer pending
 * until it settles, clears the draft on success and keeps it on failure.
 */
type WriteResult = Promise<void> | void;

/** Everything the pane can ask of its host. It never mutates host state itself. */
export type CommentsPaneCallbacks = {
  /** `mentions` is present only when the host's composer collects them. */
  onCreateThread?: (input: {
    anchor: CommentAnchor;
    body: string;
    kind?: TraceCommentKind;
    mentions?: TraceCommentMentions;
  }) => WriteResult;
  onReply?: (
    threadId: string,
    input: { body: string; mentions?: TraceCommentMentions }
  ) => WriteResult;
  onEdit?: (
    commentId: string,
    input: {
      body: string;
      expectedRevision: number;
      mentions?: TraceCommentMentions;
    }
  ) => WriteResult;
  onDelete?: (target: { commentId: string; threadId: string }) => WriteResult;
  onResolve?: (threadId: string) => WriteResult;
  onReopen?: (threadId: string) => WriteResult;
  onRetrySync?: (threadId: string) => WriteResult;
  onRetryLoad?: () => void;
  onSelectThread?: (threadId: string) => void;
  onRevealAnchor?: (thread: CommentThreadDto) => void;
  /** `null` drops the draft; only an explicit Cancel or a successful write sends it. */
  onDraftChange: (key: string, draft: CommentsPaneDraft | null) => void;
  /** A write callback rejected; the host decides how to tell the viewer. */
  onWriteError?: (failure: CommentsPaneWriteError) => void;
};

export type CommentsPaneContentProps = CommentsPaneCallbacks & {
  activeAnchor?: CommentAnchor | null;
  /**
   * The host's wording for MOVED/OUTDATED/ORPHANED, each explicitly `null`
   * while design has approved none (`NO_ANCHOR_STATE_LABELS`). Required so no
   * host can forget the decision; the non-text cue renders either way.
   */
  anchorStateLabels: CommentsPaneAnchorStateLabels;
  branchScope?: CommentsPaneBranchScope;
  capabilities: CollectionCapabilities;
  composerPlaceholder?: string;
  composerTarget?: CommentsPaneComposerTarget | null;
  drafts: CommentsPaneDrafts;
  formatTimestamp?: (iso: string) => string;
  /** The entity the pane shows; a change drops in-flight writes from the previous one. */
  identity?: string;
  loadState: CommentsPaneLoadState;
  /** A host's coverage or staleness note, shown above the list. */
  notice?: string | null;
  onClose?: () => void;
  /** Draft keys the host already knows are in flight (for example after a remount). */
  pendingDraftKeys?: readonly string[];
  renderBody?: (body: string, comment: CommentDto) => ReactNode;
  /** Renders every composer in the pane; the plain composer when omitted. */
  renderComposer?: CommentsPaneRenderComposer;
  revealableAnchorKinds?: readonly CommentAnchorKind[];
  selectedThreadId?: string | null;
  /**
   * A thread's own source capabilities, for a list that mixes sources (a
   * Branch's GitHub threads); `capabilities` when omitted or for the rest.
   */
  threadCapabilities?: (thread: CommentThreadDto) => CollectionCapabilities;
  threads: readonly CommentThreadDto[];
  title?: string;
};

export type CommentsPaneProps = CommentsPaneContentProps & {
  availableWidth?: number;
  /** Screen-reader description of the narrow-layout Sheet. */
  description?: string;
  layout?: CommentsPaneLayout;
  onOpenChange: (open: boolean) => void;
  onWidthChange: (width: number) => void;
  onWidthCommit?: (width: number) => void;
  open: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  width: number;
};
