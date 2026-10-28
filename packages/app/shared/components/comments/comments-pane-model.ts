import { normalizeRepoFullName } from "@repo/api/src/types/branch-repository";
import {
  ThreadSource,
  ThreadStatus,
  type TraceCommentMentions,
} from "@repo/api/src/types/comment";
import {
  type CommentAnchor,
  CommentAnchorState,
} from "@repo/api/src/types/comment-anchor";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import type { CollectionCapabilities } from "@repo/api/src/types/comment-capabilities";
import {
  type CommentDto,
  CommentSyncStatus,
  type CommentThreadDto,
} from "@repo/api/src/types/comment-thread-dto";
import { clamp } from "@repo/api/src/utils/math";

/**
 * Pure model for the canonical comments pane (ISS-11209). The pane renders the
 * unified thread shape (`CommentThreadDto`, PLN-2096) as it is served, so this
 * module never redeclares a thread, comment, anchor or capability type.
 */

export const CommentsPaneLoadStatus = {
  Loading: "loading",
  Ready: "ready",
  Partial: "partial",
  Error: "error",
} as const;
export type CommentsPaneLoadStatus =
  (typeof CommentsPaneLoadStatus)[keyof typeof CommentsPaneLoadStatus];

export type CommentsPaneLoadState =
  | { status: typeof CommentsPaneLoadStatus.Loading }
  | { status: typeof CommentsPaneLoadStatus.Ready }
  | { status: typeof CommentsPaneLoadStatus.Partial }
  | { status: typeof CommentsPaneLoadStatus.Error };

export type CommentsPaneDraft = {
  body: string;
  /** Only the new-thread composer carries a kind (the staff parsing-bug flag). */
  kind?: CollectionCapabilities["commentKinds"][number];
  /**
   * Edit drafts only: the comment's revision when editing started. Save sends
   * it as `expectedRevision`, so a refetch that moves the comment on while the
   * draft is open makes the save conflict instead of overwriting that edit.
   */
  baseRevision?: number;
  /**
   * The members picked in a mention composer, kept with the text so a
   * remounted composer still sends the mentions its "@Name" tokens name.
   */
  mentions?: TraceCommentMentions;
};

export type CommentsPaneDrafts = Readonly<Record<string, CommentsPaneDraft>>;

export const NEW_THREAD_DRAFT_KEY = "new-thread";

export function replyDraftKey(threadId: string): string {
  return `reply:${threadId}`;
}

export function editDraftKey(commentId: string): string {
  return `edit:${commentId}`;
}

/** Pending keys of the actions that carry no draft. */
export function deleteActionKey(commentId: string): string {
  return `delete:${commentId}`;
}

export function resolveActionKey(threadId: string): string {
  return `resolve:${threadId}`;
}

export function reopenActionKey(threadId: string): string {
  return `reopen:${threadId}`;
}

export function retrySyncActionKey(threadId: string): string {
  return `retry:${threadId}`;
}

/** Where a new thread would land; `label` is the host's preview of the anchor. */
export type CommentsPaneComposerTarget = {
  anchor: CommentAnchor;
  label?: string;
};

/**
 * What Branch detail hands its comments today (ISS-10794 review, 2026-09-23):
 * the selected PR, the Sessions on screen with their coverage note, and which
 * tab the scope describes.
 */
export type CommentsPaneBranchScope = {
  coverageNote?: string | null;
  renderedSessionIds: readonly string[];
  selectedPullRequestKey: string | null;
  tab: "details" | "sessions";
};

export type CommentsPaneThreadAffordances = {
  linkOut: string | null;
  reopen: boolean;
  reply: boolean;
  resolve: boolean;
  retrySync: boolean;
};

export type CommentsPaneCommentAffordances = {
  delete: boolean;
  edit: boolean;
};

/**
 * An affordance needs the collection capability AND the item permission; the
 * host's callback is checked by the caller, which owns it.
 */
export function threadAffordances(
  capabilities: CollectionCapabilities,
  thread: CommentThreadDto
): CommentsPaneThreadAffordances {
  const open = thread.status === ThreadStatus.Open;
  const syncFailed =
    thread.sync?.state === CommentSyncStatus.Failed ||
    thread.sync?.state === CommentSyncStatus.Abandoned;
  return {
    linkOut:
      capabilities.linkOut && thread.provider.linkOut
        ? thread.provider.linkOut
        : null,
    reopen: !open && capabilities.reopen && thread.permissions.canReopen,
    reply: open && capabilities.reply,
    resolve: open && capabilities.resolve && thread.permissions.canResolve,
    // ISS-10827: only the author is told their delivery failed, so only the
    // author is offered the retry door beside that wording.
    retrySync:
      syncFailed &&
      capabilities.retrySync &&
      thread.permissions.canRetrySync &&
      thread.comments[0]?.permissions.canEdit === true,
  };
}

export function commentAffordances(
  capabilities: CollectionCapabilities,
  comment: CommentDto
): CommentsPaneCommentAffordances {
  return {
    delete: capabilities.delete && comment.permissions.canDelete,
    edit: capabilities.edit && comment.permissions.canEdit,
  };
}

export function canCreateThread(
  capabilities: CollectionCapabilities,
  target: CommentsPaneComposerTarget | null | undefined
): target is CommentsPaneComposerTarget {
  return Boolean(
    capabilities.createThread &&
      target &&
      capabilities.anchorKinds.includes(target.anchor.kind)
  );
}

/** A thread's anchor is revealable when the server still places it and this surface can show its kind. */
export function isAnchorRevealable(
  thread: CommentThreadDto,
  revealableAnchorKinds: readonly CommentAnchorKind[]
): boolean {
  if (!thread.anchor || thread.anchor.kind === CommentAnchorKind.Artifact) {
    return false;
  }
  if (
    thread.anchorState === CommentAnchorState.Orphaned ||
    thread.anchorState === CommentAnchorState.Outdated
  ) {
    return false;
  }
  return revealableAnchorKinds.includes(thread.anchor.kind);
}

/** The quoted text a thread's anchor previews, read from the anchor itself. */
export function anchorPreviewText(anchor: CommentAnchor | null): string | null {
  if (!anchor) {
    return null;
  }
  switch (anchor.kind) {
    case CommentAnchorKind.Artifact:
      return null;
    case CommentAnchorKind.Trace:
      return anchor.selectedText;
    case CommentAnchorKind.Text:
      return anchor.quote.exact;
    case CommentAnchorKind.Code:
      // Same `path:line` shape the Branch card prints for provider comments.
      return anchor.endLine === null
        ? anchor.path
        : `${anchor.path}:${anchor.endLine}`;
    case CommentAnchorKind.Prototype:
      return anchor.textContext ?? null;
    default:
      return assertNever(anchor);
  }
}

/** Same placement, compared by each kind's identity fields; geometry and quotes are not identity. */
export function isSameAnchor(
  left: CommentAnchor | null | undefined,
  right: CommentAnchor | null | undefined
): boolean {
  if (!(left && right)) {
    return false;
  }
  switch (left.kind) {
    case CommentAnchorKind.Artifact:
      return right.kind === CommentAnchorKind.Artifact;
    case CommentAnchorKind.Trace:
      return (
        right.kind === CommentAnchorKind.Trace &&
        left.traceId === right.traceId &&
        left.turnId === right.turnId &&
        left.row === right.row &&
        left.startOffset === right.startOffset &&
        left.endOffset === right.endOffset
      );
    case CommentAnchorKind.Text:
      return (
        right.kind === CommentAnchorKind.Text &&
        left.documentVersion === right.documentVersion &&
        left.quote.exact === right.quote.exact &&
        left.quote.prefix === right.quote.prefix &&
        left.quote.suffix === right.quote.suffix
      );
    case CommentAnchorKind.Code:
      return (
        right.kind === CommentAnchorKind.Code &&
        left.repository === right.repository &&
        left.commitSha === right.commitSha &&
        left.path === right.path &&
        left.side === right.side &&
        left.startLine === right.startLine &&
        left.endLine === right.endLine
      );
    case CommentAnchorKind.Prototype:
      return (
        right.kind === CommentAnchorKind.Prototype &&
        left.prototypeVersionId === right.prototypeVersionId &&
        left.route === right.route &&
        left.anchorId === right.anchorId
      );
    default:
      return assertNever(left);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled comment anchor: ${JSON.stringify(value)}`);
}

/** Anchor states other than ANCHORED; each one needs a host decision about its wording. */
export type CommentsPaneAnchorStateLabels = Record<
  Exclude<CommentAnchorState, typeof CommentAnchorState.Anchored>,
  string | null
>;

/** The honest default until design approves wording: no label, only the non-text cue. */
export const NO_ANCHOR_STATE_LABELS: CommentsPaneAnchorStateLabels = {
  [CommentAnchorState.Moved]: null,
  [CommentAnchorState.Outdated]: null,
  [CommentAnchorState.Orphaned]: null,
};

export type CommentsPaneFilter = "all" | "open" | CommentAnchorKind;

/** All and Open always; an anchor-kind filter only when the source mixes kinds. */
export function commentsPaneFilters(
  capabilities: CollectionCapabilities
): CommentsPaneFilter[] {
  const filters: CommentsPaneFilter[] = ["all", "open"];
  return capabilities.anchorKinds.length > 1
    ? [...filters, ...capabilities.anchorKinds]
    : filters;
}

export function threadMatchesFilter(
  thread: CommentThreadDto,
  filter: CommentsPaneFilter
): boolean {
  if (filter === "all") {
    return true;
  }
  if (filter === "open") {
    return thread.status === ThreadStatus.Open;
  }
  return (thread.anchor?.kind ?? CommentAnchorKind.Artifact) === filter;
}

/** Labels reused verbatim from the generic artifact rail's filter menu. */
export function commentsPaneFilterLabel(
  filter: CommentsPaneFilter,
  compact = false
): string {
  if (filter === "all") {
    return compact ? "All" : "All comments";
  }
  if (filter === "open") {
    return compact ? "Open" : "Open comments";
  }
  const label =
    filter === CommentAnchorKind.Text
      ? "Content"
      : filter[0].toUpperCase() + filter.slice(1);
  return compact ? label : `${label} comments`;
}

/**
 * Branch scoping the DTO can express: a trace thread from a Session that is
 * not rendered is out of scope, and provider threads need a selected PR and
 * belong to it by whichever of its number and repository they name (an older
 * server names neither, or only the number).
 */
export function threadInBranchScope(
  thread: CommentThreadDto,
  scope: CommentsPaneBranchScope | undefined
): boolean {
  if (!scope) {
    return true;
  }
  if (thread.source === ThreadSource.Github) {
    return (
      scope.tab === "details" &&
      scope.selectedPullRequestKey !== null &&
      providerThreadOnSelectedPullRequest(
        thread.provider,
        scope.selectedPullRequestKey
      )
    );
  }
  const sessionId =
    thread.anchor?.kind === CommentAnchorKind.Trace
      ? thread.anchor.sessionId
      : null;
  if (scope.tab === "sessions" && sessionId) {
    return scope.renderedSessionIds.includes(sessionId);
  }
  return true;
}

export const COMMENTS_COUNT_UNAVAILABLE_LABEL = "Unavailable";

/**
 * A failed read says "Unavailable" where the count sits and a read in flight
 * leaves the slot empty, so neither can read as zero comments.
 */
export function commentsPaneCountLabel(
  loadState: CommentsPaneLoadState,
  count: number
): string | number | null {
  switch (loadState.status) {
    case CommentsPaneLoadStatus.Loading:
      return null;
    case CommentsPaneLoadStatus.Error:
      return COMMENTS_COUNT_UNAVAILABLE_LABEL;
    case CommentsPaneLoadStatus.Partial:
      return `${count} shown`;
    default:
      return count;
  }
}

/** Branch's screen-reader scope announcement, shared so both say it the same way. */
export function commentsScopeAnnouncement(
  scope: CommentsPaneBranchScope
): string {
  if (scope.tab === "details") {
    return scope.selectedPullRequestKey
      ? `Comments updated for Branch details and pull request ${scope.selectedPullRequestKey}.`
      : "Comments updated for Branch details. No pull request is selected.";
  }
  return `Comments updated for Sessions and timeline. ${scope.renderedSessionIds.length} rendered Sessions included.`;
}

/** Branch's production breakpoints, chosen over the prototype's 1100/640 (ISS-11209). */
export const COMMENTS_NARROW_MAX_WIDTH = 1024;
export const COMMENTS_MOBILE_MAX_WIDTH = 639;
export const COMMENTS_RAIL_MIN_WIDTH = 280;
export const COMMENTS_RAIL_MAX_WIDTH = 560;
export const COMMENTS_RAIL_KEYBOARD_STEP = 16;

export const CommentsPaneLayout = {
  Wide: "wide",
  Narrow: "narrow",
  Mobile: "mobile",
} as const;
export type CommentsPaneLayout =
  (typeof CommentsPaneLayout)[keyof typeof CommentsPaneLayout];

/**
 * The rail's width bounds. A container narrower than the minimum caps both
 * ends at what is available, so neither pointer nor keyboard can overflow it.
 */
export function commentsRailWidthBounds(availableWidth?: number): {
  max: number;
  min: number;
} {
  const available = availableWidth ?? Number.POSITIVE_INFINITY;
  return {
    max: Math.min(COMMENTS_RAIL_MAX_WIDTH, available),
    min: Math.min(COMMENTS_RAIL_MIN_WIDTH, available),
  };
}

export function clampCommentsRailWidth(
  width: number,
  availableWidth?: number
): number {
  const { max, min } = commentsRailWidthBounds(availableWidth);
  return clamp(width, min, max);
}

export const COMMENTS_NARROW_QUERY = `(max-width: ${COMMENTS_NARROW_MAX_WIDTH}px)`;

export type PullRequestKeySelection = {
  number: number;
  repository: string;
};

/** Reads Branch detail's selected-PR key, `<repository>#<number>`; null when it is not one. */
export function parsePullRequestKey(
  pullRequestKey: string | null | undefined
): PullRequestKeySelection | null {
  if (!pullRequestKey) {
    return null;
  }
  const separator = pullRequestKey.lastIndexOf("#");
  if (separator <= 0) {
    return null;
  }
  const repository = pullRequestKey.slice(0, separator);
  const number = Number(pullRequestKey.slice(separator + 1));
  return Number.isInteger(number) && number > 0 ? { number, repository } : null;
}

function providerThreadOnSelectedPullRequest(
  provider: CommentThreadDto["provider"],
  selectedPullRequestKey: string
): boolean {
  const { pullRequestNumber, repositoryFullName } = provider;
  if (pullRequestNumber === undefined && repositoryFullName === undefined) {
    return true;
  }
  const selected = parsePullRequestKey(selectedPullRequestKey);
  if (!selected) {
    return false;
  }
  return (
    (pullRequestNumber === undefined ||
      pullRequestNumber === selected.number) &&
    (repositoryFullName === undefined ||
      normalizeRepoFullName(repositoryFullName) ===
        normalizeRepoFullName(selected.repository))
  );
}

export const TRACE_COMMENT_SELECTION_GUIDANCE =
  "Select an eligible trace row or range to add a comment.";
