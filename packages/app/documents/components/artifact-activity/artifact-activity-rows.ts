/**
 * ISS-11004 / ISS-10980: an Activity tab's row stream, for every artifact whose
 * feed the stored-event read serves — Session and Branch today.
 *
 * The read API projects comments alongside every other source since ISS-11004
 * (operator, 2026-10-07), so this is a mapping, not a merge: one feed page in,
 * one row list out, already in the API's `(createdAt desc, id desc)` order.
 *
 * An earlier revision of this module merged a separately-read comment
 * collection into the paged activity stream and clamped it to the loaded
 * window, because a whole comment list against a partial activity list broke
 * newest-first on Load more. Moving the projection into the API retired that
 * problem rather than managing it, which is why no clamp survives here.
 *
 * What stays client-side is the LINK: only the host knows its own route and
 * which of its tabs the addressed comment's rail is beside, so it passes
 * `buildCommentHref`. The feed carries the thread's trace-comment SURFACE for
 * exactly that decision (ISS-10980) — on Branch, a `branch_timeline` thread
 * belongs to a different tab than a `branch_detail` one.
 */

import {
  ActivityFeedItemSource,
  type ArtifactActivityFeedItem,
} from "@repo/api/src/types/artifact-activity-feed";
import { CommentSurface } from "@repo/api/src/types/comment";
import { FeedItemKind } from "@repo/app/documents/components/feed-sidebar/feed-item";
import { ACTIVITY_SOURCE_ID } from "@repo/app/documents/components/feed-sidebar/sources/activity-types";
import { isRecord } from "@repo/lib/harness/type-guards";
import {
  type ActivityTimelineRow,
  ActivityTimelineRowKind,
} from "./activity-timeline";

/** Where a comment lives, as much of it as the feed could tell us. */
export type ArtifactCommentAddress = Readonly<{
  threadId: string;
  /**
   * The thread's trace-comment surface, or null when the feed carried none or
   * carried a value this client does not know. Null is "we cannot say", which
   * a host resolves to its own default tab — never a guessed surface.
   */
  surface: CommentSurface | null;
}>;

type MapInput = Readonly<{
  events: readonly ArtifactActivityFeedItem[];
  /** Builds the link a comment row points at, from the thread's address. */
  buildCommentHref: (address: ArtifactCommentAddress) => string;
}>;

export function toArtifactActivityRows({
  events,
  buildCommentHref,
}: MapInput): readonly ActivityTimelineRow[] {
  return events.map(
    (event) => toCommentRow(event, buildCommentHref) ?? toActivityRow(event)
  );
}

/**
 * A comment item as a read-only row pointing at the thread (ISS-10843 V1), or
 * null when this item is not a comment — or is one whose payload does not
 * carry the thread id this row exists to link to. A comment with no reachable
 * thread still belongs in the stream, so it falls back to the activity card
 * rather than being dropped.
 */
function toCommentRow(
  event: ArtifactActivityFeedItem,
  buildCommentHref: (address: ArtifactCommentAddress) => string
): ActivityTimelineRow | null {
  if (event.source !== ActivityFeedItemSource.Comment) {
    return null;
  }
  const threadId = readThreadId(event.payload);
  if (!threadId) {
    return null;
  }
  return {
    kind: ActivityTimelineRowKind.Comment,
    id: event.id,
    authorId: event.actor.id ?? "",
    createdAt: event.createdAt,
    href: buildCommentHref({
      threadId,
      surface: readCommentSurface(event.payload),
    }),
  };
}

function toActivityRow(event: ArtifactActivityFeedItem): ActivityTimelineRow {
  return {
    kind: ActivityTimelineRowKind.Activity,
    item: {
      id: event.id,
      kind: FeedItemKind.Activity,
      sourceId: ACTIVITY_SOURCE_ID,
      createdAt: event.createdAt,
      event,
    },
  };
}

/** The thread id a comment item carries, validated at the wire boundary. */
function readThreadId(
  payload: ArtifactActivityFeedItem["payload"]
): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const threadId = payload.threadId;
  return typeof threadId === "string" && threadId.length > 0 ? threadId : null;
}

/**
 * The trace-comment surface a comment item carries, validated at the wire
 * boundary. An absent key, a non-string, or a surface a newer server knows and
 * this client does not all read as null — "we cannot say" — rather than being
 * coerced into one of the values this client happens to have.
 */
function readCommentSurface(
  payload: ArtifactActivityFeedItem["payload"]
): CommentSurface | null {
  if (!isRecord(payload)) {
    return null;
  }
  const surface = payload.surface;
  return isCommentSurface(surface) ? surface : null;
}

const KNOWN_SURFACES: ReadonlySet<string> = new Set(
  Object.values(CommentSurface)
);

function isCommentSurface(value: unknown): value is CommentSurface {
  return typeof value === "string" && KNOWN_SURFACES.has(value);
}
