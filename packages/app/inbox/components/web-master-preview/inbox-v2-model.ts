/**
 * Inbox v2 queue state model.
 *
 * Pure, DOM-free, and node-testable: the transitions here (what a view shows,
 * what "needs attention" counts, what the list clamps to, which fixture a
 * thread previews) are the parts of the Inbox whose bugs are invisible by eye.
 * The component in `inbox-v2.tsx` owns rendering and nothing else.
 */

import {
  ArtifactType,
  InboxOrder,
  InboxView,
  Reason,
  type Thread,
  UPDATE_REASONS,
  viewLabels,
} from "./inbox-v2-threads";

/** Query keys the Inbox owns. Every durable control reads and writes these. */
export const InboxQueryKey = {
  Order: "order",
  Thread: "thread",
  Types: "types",
  UnreadOnly: "unread",
  View: "view",
} as const;

const TYPE_FILTER_SEPARATOR = ",";
const UNREAD_ONLY_ON = "1";

/**
 * Narrowest the thread list may get, and the room the preview pane always
 * keeps. Both are workspace-relative so a 390px viewport never clips the list.
 */
const MIN_LIST_WIDTH = 320;
const MIN_PREVIEW_WIDTH = 420;
export const DEFAULT_LIST_WIDTH = 430;

export type InboxQueryState = {
  order: InboxOrder;
  selectedId: string | null;
  typeFilters: readonly ArtifactType[];
  unreadOnly: boolean;
  view: InboxView;
};

function toView(value: string | null): InboxView {
  return value && value in viewLabels
    ? (value as InboxView)
    : InboxView.Attention;
}

function toOrder(value: string | null): InboxOrder {
  return value === InboxOrder.Oldest ? InboxOrder.Oldest : InboxOrder.Newest;
}

function toTypeFilters(value: string | null): ArtifactType[] {
  if (!value) {
    return [];
  }
  const known = new Set<string>(Object.values(ArtifactType));
  return value
    .split(TYPE_FILTER_SEPARATOR)
    .filter((entry): entry is ArtifactType => known.has(entry));
}

/**
 * Every control the toolbar exposes is query-backed, so a refresh or a
 * back/forward navigation restores the same queue the user was looking at.
 */
export function readInboxQueryState(params: URLSearchParams): InboxQueryState {
  return {
    order: toOrder(params.get(InboxQueryKey.Order)),
    selectedId: params.get(InboxQueryKey.Thread),
    typeFilters: toTypeFilters(params.get(InboxQueryKey.Types)),
    unreadOnly: params.get(InboxQueryKey.UnreadOnly) === UNREAD_ONLY_ON,
    view: toView(params.get(InboxQueryKey.View)),
  };
}

export function unreadOnlyParam(unreadOnly: boolean): string | null {
  return unreadOnly ? UNREAD_ONLY_ON : null;
}

export function typeFiltersParam(
  typeFilters: readonly ArtifactType[]
): string | null {
  return typeFilters.length ? typeFilters.join(TYPE_FILTER_SEPARATOR) : null;
}

function threadMatchesView({
  archived,
  bookmarked,
  thread,
  view,
}: {
  archived: boolean;
  bookmarked: boolean;
  thread: Thread;
  view: InboxView;
}): boolean {
  if (view === InboxView.Archive) {
    return archived;
  }
  if (view === InboxView.Bookmarks) {
    return bookmarked;
  }
  if (archived) {
    return false;
  }

  switch (view) {
    case InboxView.Attention:
      return isActionable(thread);
    case InboxView.Owned:
      return !thread.resolved && thread.reasons.includes(Reason.Owner);
    case InboxView.Mentions:
      return !thread.resolved && thread.reasons.includes(Reason.Mention);
    case InboxView.Updates:
      return thread.reasons.some((reason) => UPDATE_REASONS.includes(reason));
    case InboxView.Resolved:
      return thread.resolved;
    default:
      return true;
  }
}

export type VisibleThreadsInput = {
  archivedIds: readonly string[];
  bookmarkedIds: readonly string[];
  order: InboxOrder;
  /**
   * The thread the URL currently names. It stays in the list even when a
   * filter would drop it, so marking a row read under "Unread only" cannot
   * make the detail pane fall through to a different conversation than the
   * one the URL points at.
   */
  selectedId: string | null;
  threads: readonly Thread[];
  typeFilters: readonly ArtifactType[];
  unreadOnly: boolean;
  view: InboxView;
};

export function selectVisibleThreads({
  archivedIds,
  bookmarkedIds,
  order,
  selectedId,
  threads,
  typeFilters,
  unreadOnly,
  view,
}: VisibleThreadsInput): Thread[] {
  const archived = new Set(archivedIds);
  const bookmarked = new Set(bookmarkedIds);
  return threads
    .filter((thread) =>
      threadMatchesView({
        archived: archived.has(thread.id),
        bookmarked: bookmarked.has(thread.id),
        thread,
        view,
      })
    )
    .filter(
      (thread) =>
        thread.id === selectedId ||
        ((!unreadOnly || thread.unread) &&
          (typeFilters.length === 0 ||
            typeFilters.includes(thread.artifactType)))
    )
    .sort((a, b) =>
      order === InboxOrder.Newest ? b.sort - a.sort : a.sort - b.sort
    );
}

/**
 * Threads that still need the reader. Archived threads are excluded because
 * archiving removes a thread from "Needs attention"; counting it here as well
 * as in `countArchivedActionable` would report the same thread twice.
 */
export function countNeedsAttention(
  threads: readonly Thread[],
  archivedIds: readonly string[]
): number {
  const archived = new Set(archivedIds);
  return threads.filter(
    (thread) => !archived.has(thread.id) && isActionable(thread)
  ).length;
}

export function countArchivedActionable(
  threads: readonly Thread[],
  archivedIds: readonly string[]
): number {
  const archived = new Set(archivedIds);
  return threads.filter(
    (thread) => archived.has(thread.id) && isActionable(thread)
  ).length;
}

/**
 * The one clamp every width path shares — restore, keyboard, pointer, and a
 * workspace resize. A stored or default width wider than the workspace would
 * otherwise clip the list at the 390px the prototype sandbox requires.
 *
 * The list is capped so the preview keeps `MIN_PREVIEW_WIDTH`. Both minimums
 * only fit above `MIN_LIST_WIDTH + MIN_PREVIEW_WIDTH` of workspace, which is
 * why the component turns the split on at `lg` rather than `md`; below that the
 * panes stack and this clamp is not what is sizing the list.
 */
export function clampListWidth(width: number, workspaceWidth: number): number {
  if (!(Number.isFinite(width) && Number.isFinite(workspaceWidth))) {
    return MIN_LIST_WIDTH;
  }
  const room = workspaceWidth - MIN_PREVIEW_WIDTH;
  const max = Math.max(MIN_LIST_WIDTH, Math.min(workspaceWidth, room));
  return Math.min(max, Math.max(MIN_LIST_WIDTH, width));
}

export type ThreadPreviewTarget =
  | { kind: "branch"; branchId: string }
  | { kind: "session"; sessionId: string; traceRow: number }
  | {
      kind: "specialized";
      artifactKind: "documents" | "issues-v2" | "prototypes";
      fixtureKey: string;
    };

/**
 * The anchored preview resolves both its fixture and its anchor from the
 * thread. A constant here would render one artifact for every thread of a
 * type, which is what review flagged on the issue, branch, and session paths.
 */
export function resolveThreadPreview(thread: Thread): ThreadPreviewTarget {
  switch (thread.artifactType) {
    case ArtifactType.Branch:
      return { branchId: thread.previewKey, kind: "branch" };
    case ArtifactType.Session:
      return {
        kind: "session",
        sessionId: thread.previewKey,
        traceRow: thread.previewTraceRow ?? 0,
      };
    case ArtifactType.Prototype:
      return {
        artifactKind: "prototypes",
        fixtureKey: thread.previewKey,
        kind: "specialized",
      };
    case ArtifactType.Issue:
      return {
        artifactKind: "issues-v2",
        fixtureKey: thread.previewKey,
        kind: "specialized",
      };
    default:
      return {
        artifactKind: "documents",
        fixtureKey: thread.previewKey,
        kind: "specialized",
      };
  }
}

export function getPrimaryThreadMessage(thread: Thread, selected: boolean) {
  const own = {
    author: thread.author,
    body: thread.body,
    initials: thread.initials,
    time: thread.time,
  };
  if (selected) {
    return own;
  }
  const mentionReply = thread.replies.find((reply) =>
    CURRENT_USER_MENTION_PATTERN.test(reply.body)
  );
  if (!CURRENT_USER_MENTION_PATTERN.test(thread.body) && mentionReply) {
    return mentionReply;
  }
  return own;
}

const CURRENT_USER_MENTION_PATTERN = /@(?:Ottilie|you)\b/i;

function isActionable(thread: Thread): boolean {
  return (
    !thread.resolved &&
    (thread.reasons.includes(Reason.Owner) ||
      thread.reasons.includes(Reason.Mention))
  );
}
