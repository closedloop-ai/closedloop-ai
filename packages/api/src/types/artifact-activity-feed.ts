/**
 * Artifact activity FEED types (FEA-3864 / FEA-3535 Slice 3).
 *
 * The aggregate, on-read activity timeline for a single artifact. Where
 * `artifact-activity.ts` is the persisted event STORE contract (one row per
 * captured mutation), this is the READ contract for artifact activity routes.
 * The Document route merges stored rows with on-read projections (versions,
 * PRODUCES derivation links, evaluations). Session and Branch routes
 * serve stored V1 edits plus comments in the same newest-first,
 * cursor-paginated shape.
 *
 * Shared here in `@repo/api` because it is the response type for the API route
 * (`apps/api`) and the input to the Feed sidebar activity source in
 * `@repo/app`.
 *
 * Comments ride the Session and Branch reads but not the Document one
 * (ISS-11004): the document feed rail mounts this feed's activity source
 * beside the live Liveblocks comment source, so projecting there would
 * double-count (CLAUDE.md aggregation rule).
 *
 * Enums follow the repo `{...} as const` + `(typeof X)[keyof typeof X]` idiom.
 */

import type { JsonValue } from "./common.js";

/**
 * Normalized actor for a feed item. Collapses the store's `actorType` and the
 * varied projected-source actors into one shape the UI can render uniformly.
 *
 * - `human`  — a person (Clerk / desktop session). `id` is the user id.
 * - `agent`  — an automated or API-key caller. A stored event's `id` is the
 *              key owner's user id, not an agent or key id.
 * - `system` — the platform (automated projections with no attributable actor,
 *              e.g. a derivation link created by an internal process). `id` is
 *              typically null.
 */
export const ActivityFeedActorKind = {
  Human: "human",
  Agent: "agent",
  System: "system",
} as const;
export type ActivityFeedActorKind =
  (typeof ActivityFeedActorKind)[keyof typeof ActivityFeedActorKind];

export type ActivityFeedActor = {
  kind: ActivityFeedActorKind;
  /** The source actor id, or null when unknown. Stored API-key rows use the owning user id. */
  id: string | null;
};

/**
 * The source a feed item came from. `event` items are persisted
 * `ArtifactActivityEvent` rows (captured mutations); every other value is an
 * on-read projection of history from another table.
 */
export const ActivityFeedItemSource = {
  /** A persisted ArtifactActivityEvent row (captured mutation). */
  Event: "event",
  /** A `document_versions` row — a new version was saved. */
  VersionCreated: "version_created",
  /** An `artifact_links` PRODUCES row — a derivation edge in/out. */
  Derivation: "derivation",
  /** An `artifact_evaluations` row — an evaluation ran against it. */
  Evaluation: "evaluation",
  /**
   * A `comment_threads` row — someone commented on this artifact (ISS-11004).
   * One item per THREAD, at the thread's own creation time; replies stay in
   * the comments surface rather than each becoming an activity item.
   */
  Comment: "comment",
} as const;
export type ActivityFeedItemSource =
  (typeof ActivityFeedItemSource)[keyof typeof ActivityFeedItemSource];

/**
 * One normalized item in an artifact's activity timeline. `source` discriminates
 * where it came from; `action` mirrors the store's action vocabulary for `event`
 * items and is null for projections (whose meaning is carried by `source`).
 *
 * `payload` carries source-specific detail (e.g. the version number, the linked
 * artifact id + direction for a derivation, the evaluation report type) so the
 * UI can render a plain-language row without a second fetch.
 * `before`/`after` are populated only for `event` items.
 */
export type ArtifactActivityFeedItem = {
  /**
   * Stable, source-qualified id (e.g. `event:<uuid>`, `version:<uuid>`). Doubles
   * as the dedupe key and is NOT a valid pagination cursor on its own — page
   * with `nextCursor`.
   */
  id: string;
  source: ActivityFeedItemSource;
  /** The store action for `event` items; null for projections. */
  action: string | null;
  actor: ActivityFeedActor;
  before: JsonValue | null;
  after: JsonValue | null;
  /** Source-specific structured detail, or null. */
  payload: JsonValue | null;
  createdAt: Date;
};

/** Upper bound on items a single activity-feed page may return. */
export const ARTIFACT_ACTIVITY_FEED_MAX_LIMIT = 100;

/** Default page size when a caller omits `limit`. */
export const ARTIFACT_ACTIVITY_FEED_DEFAULT_LIMIT = 50;

/**
 * A cursor-paginated page of the merged activity feed, newest first.
 *
 * The cursor is an opaque, timestamp-based keyset token (encoding the last
 * item's `createdAt` + `id`), because the merged stream spans multiple tables
 * and cannot page on a single table's row id. Pass `nextCursor` back as
 * `cursor` to fetch the following page; it is null on the last page. A host
 * that hides non-person rows for V1 must keep following `nextCursor` even when
 * its filtered view of one page is empty.
 */
export type ArtifactActivityFeedResult = {
  items: ArtifactActivityFeedItem[];
  nextCursor: string | null;
};
