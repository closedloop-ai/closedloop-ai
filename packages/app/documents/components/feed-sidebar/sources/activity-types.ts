import type {
  ActivityFeedActorKind,
  ArtifactActivityFeedItem,
} from "@repo/api/src/types/artifact-activity-feed";
import type { FeedItem, FeedItemKind } from "../feed-item";

export const ACTIVITY_SOURCE_ID = "activity";

/**
 * The kind of artifact a row belongs to. Only Sessions store a status of
 * their own vocabulary (active / inactive / error), so a Session's status rows
 * are labelled with the Session words rather than the Document ones. Branches
 * store no status rows; they read like a Document's for every other field.
 *
 * Lives here, beside the row type, so the pure formatter
 * (`activity-formatting.ts`) can read it without importing a component.
 * `activity-card.tsx` re-exports it for its existing importers.
 */
export const ActivityArtifactKind = {
  Document: "document",
  Session: "session",
  Branch: "branch",
} as const;
export type ActivityArtifactKind =
  (typeof ActivityArtifactKind)[keyof typeof ActivityArtifactKind];

/**
 * How far an org directory lookup has got (ISS-5007). Declared here rather
 * than in `activity-directory.ts` (which owns the query hooks) so the pure
 * formatter can classify a lookup without importing React Query.
 */
export const ActivityDirectoryStatus = {
  /** Still reading. Renderers reserve space; they must not name anyone. */
  Pending: "pending",
  /** Read succeeded and has records. An id that misses is genuinely absent. */
  Ready: "ready",
  /**
   * We cannot name anyone: the read failed, or it returned nothing at all (a
   * restricted viewer sees an empty directory). Renderers must fall back to
   * copy that claims nothing, never to "Unknown user" — we do not know that.
   */
  Unavailable: "unavailable",
} as const;
export type ActivityDirectoryStatus =
  (typeof ActivityDirectoryStatus)[keyof typeof ActivityDirectoryStatus];

export type ActivityDirectory<TRecord> = {
  status: ActivityDirectoryStatus;
  find: (id: string) => TRecord | null;
};

/**
 * One normalized activity-timeline row, projected into the feed-item shape the
 * merged stream sorts on. The underlying `ArtifactActivityFeedItem` (from the
 * `GET /documents/[id]/activity` aggregate) is carried verbatim on `event` so
 * the card can render actor / action / before→after without a second fetch.
 */
export type ActivityFeedItem = FeedItem & {
  kind: typeof FeedItemKind.Activity;
  sourceId: typeof ACTIVITY_SOURCE_ID;
  event: ArtifactActivityFeedItem;
};

/**
 * Actor-kind sub-filter for the Activity source. `all` shows every row; the
 * other three narrow to a single normalized actor kind (human / agent / system)
 * so a reviewer can isolate, say, only agent-driven changes.
 */
export const ActivityFilterKind = {
  All: "all",
  Human: "human",
  Agent: "agent",
  System: "system",
} as const;
export type ActivityFilterKind =
  (typeof ActivityFilterKind)[keyof typeof ActivityFilterKind];

export type ActivityFilterState = { actorKind: ActivityFilterKind };

export const DEFAULT_ACTIVITY_FILTER_STATE: ActivityFilterState = {
  actorKind: ActivityFilterKind.All,
};

/**
 * True when the filter narrows past the default (any specific actor kind).
 * The filter-bar count + the "clear filter" empty state both read this.
 */
export function isActivityFiltered(state: ActivityFilterState): boolean {
  return state.actorKind !== ActivityFilterKind.All;
}

/**
 * The `ActivityFilterKind` maps 1:1 onto the store's `ActivityFeedActorKind`
 * for every non-`all` value, so a single guard resolves whether an item passes.
 */
export function passesActivityFilter(
  item: ActivityFeedItem,
  state: ActivityFilterState
): boolean {
  if (state.actorKind === ActivityFilterKind.All) {
    return true;
  }
  return item.event.actor.kind === (state.actorKind as ActivityFeedActorKind);
}
