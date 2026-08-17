// Actor identity carried on inbox-notification activity payloads.
//
// The producers in `../server/inbox-notifications.ts` already write `actorId`
// into the `$assignment` and `$mention` activity data, but that payload makes a
// round trip through Liveblocks and comes back typed as `unknown`, so it is
// validated here rather than trusted at the render site (ISS-5010).

/**
 * How much a row knows about who acted. `Loading` and `Unknown` are kept apart
 * deliberately: "we have not looked this person up yet" and "there is nobody to
 * name" are different facts, and a row that renders them identically claims the
 * actor is missing while the lookup is still running.
 */
export const NotificationActorState = {
  /** No actor on the payload, or an id the user resolver could not name. */
  Unknown: "unknown",
  /** An actor id whose name lookup has not answered yet. */
  Loading: "loading",
  /** An actor we can name. */
  Resolved: "resolved",
} as const;

export type NotificationActorState =
  (typeof NotificationActorState)[keyof typeof NotificationActorState];

/**
 * An inbox-notification actor as far as the row knows. Only the `Resolved`
 * variant carries a name, so a row cannot claim who acted without one.
 */
export type NotificationActor =
  | { state: typeof NotificationActorState.Unknown }
  | { state: typeof NotificationActorState.Loading; id: string }
  | { state: typeof NotificationActorState.Resolved; id: string; name: string };

/**
 * Narrow a raw activity-data `actorId` to a usable user id, or `null` when the
 * notification carries no actor.
 *
 * Returning `null`, rather than a placeholder id or a generic name like
 * "Someone", keeps the render honest: a row with no actor falls back to phrasing
 * that asserts nothing about who acted, instead of stating a fact the payload
 * does not contain.
 */
export function resolveNotificationActorId(rawActorId: unknown): string | null {
  if (typeof rawActorId !== "string") {
    return null;
  }
  const trimmed = rawActorId.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed;
}
