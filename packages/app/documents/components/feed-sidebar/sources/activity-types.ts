import type {
  ActivityFeedActorKind,
  ArtifactActivityFeedItem,
} from "@repo/api/src/types/artifact-activity-feed";
import type { FeedItem, FeedItemKind } from "../feed-item";

export const ACTIVITY_SOURCE_ID = "activity";

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
