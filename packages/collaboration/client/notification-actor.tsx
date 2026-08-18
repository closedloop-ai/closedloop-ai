"use client";

import { useUser } from "@liveblocks/react";
import { InboxNotification } from "@liveblocks/react-ui";
import type { ReactNode } from "react";
import type { NotificationActor } from "../shared/notification-actor";
import { NotificationActorState } from "../shared/notification-actor";

/**
 * Look an inbox-notification actor up through the Liveblocks user resolver
 * (`createResolveUsers`), the same resolver that gives the built-in thread rows
 * their author name and avatar, so custom-kind rows and thread rows name people
 * the same way.
 *
 * A lookup still in flight resolves to `Loading`, not `Unknown`: the row can
 * already show the avatar placeholder and a bar where the name will land, and
 * only the name itself has to wait. An id the resolver maps to nothing (someone
 * who has left the org) is `Unknown`, and callers must render actor-less
 * phrasing for it rather than inventing a name (ISS-5010).
 *
 * `actorId` may be `null` — no actor on the payload, or the treatment switched
 * off — and `useUser` is still called, on a sentinel id, because a hook cannot
 * be called conditionally and this has to stay one component in one position.
 * Selecting a different component for the actor-less case would unmount and
 * remount every row the moment the flag resolved. The sentinel costs nothing:
 * `createResolveUsers` is an in-memory lookup over the org roster, not a fetch,
 * and it resolves the sentinel to nothing exactly as it would a departed
 * member. Its result is discarded either way — an actor-less row is `Unknown`
 * immediately, never `Loading`, so it can never flash a name placeholder for
 * somebody who does not exist.
 */
export function useNotificationActor(
  actorId: string | null
): NotificationActor {
  const result = useUser(actorId ?? NO_ACTOR_SENTINEL_USER_ID);
  if (actorId === null) {
    return UNKNOWN_ACTOR;
  }
  if (result.isLoading) {
    return { state: NotificationActorState.Loading, id: actorId };
  }
  const name = result.error ? null : (result.user?.name ?? null);
  if (!name) {
    return UNKNOWN_ACTOR;
  }
  return { state: NotificationActorState.Resolved, id: actorId, name };
}

/**
 * The row's `aside` slot content, for a row the actor treatment is on for.
 *
 * An unknown actor still returns an element rather than `undefined`, because
 * `InboxNotification.Custom` only renders the 36px aside column when `aside` is
 * truthy. Dropping it would give two adjacent assignment rows, one resolved and
 * one not, two different left edges with nothing on screen explaining why. The
 * gutter is held for every row of these kinds and simply stands empty when there
 * is nobody to show.
 *
 * Callers must not call this at all when the treatment is off, so an unflagged
 * row keeps exactly the layout it has today.
 *
 * The avatar is `aria-hidden` on purpose: when it renders, the actor's name is
 * already spelled out in the headline, and the Liveblocks avatar carries that
 * same name as its `alt`/`aria-label`, so leaving it exposed makes a screen
 * reader announce the person twice.
 */
export function notificationActorAside(actor: NotificationActor): ReactNode {
  if (actor.state === NotificationActorState.Unknown) {
    return <span aria-hidden="true" data-actor-gutter="empty" />;
  }
  return <InboxNotification.Avatar aria-hidden="true" userId={actor.id} />;
}

type NotificationActorSlotProps = {
  actorId: string | null;
  render: (actor: NotificationActor) => ReactNode;
};

const UNKNOWN_ACTOR: NotificationActor = {
  state: NotificationActorState.Unknown,
};

/**
 * The id stood in for a row with no actor, so the user-resolver hook can be
 * called unconditionally. It cannot collide with a real member: Clerk user ids
 * are `user_…`.
 */
const NO_ACTOR_SENTINEL_USER_ID = "cl-inbox:no-actor";

/**
 * Render a notification row with whatever it knows about its actor.
 *
 * `render` receives `Unknown` whenever the row must not claim an actor: no
 * `actorId` on the payload, the treatment switched off, or an id the user
 * resolver cannot turn into a name. Routing every one of those through a single
 * variant means a row can never pair an avatar with an unresolved name or vice
 * versa.
 *
 * There is deliberately no second component for the actor-less case. React
 * replaces the DOM subtree when the component type at a position changes, and
 * the row itself is rendered inside this one, so branching here would remount
 * every row the moment the PostHog flag resolved — the exact transition holding
 * the rows until flags settle is meant to avoid.
 */
export function NotificationActorSlot({
  actorId,
  render,
}: NotificationActorSlotProps) {
  const actor = useNotificationActor(actorId);
  return <>{render(actor)}</>;
}

/** @see NotificationActorNamePlaceholder */
export const NOTIFICATION_ACTOR_NAME_PLACEHOLDER_CLASS_NAME =
  "cl-inbox-notification-actor-name-placeholder";

/**
 * Stands in for the actor's name while the lookup is in flight.
 *
 * The row holds the actor-led shape and swaps only this bar for the name, so
 * opening the inbox and scanning it does not mean every row rewriting its words
 * under you a beat later. It is `aria-hidden`: the row deliberately does not
 * guess at a name, and it will not invent a spoken stand-in for one either, so
 * the announced sentence during that beat is the rest of the headline.
 */
export function NotificationActorNamePlaceholder() {
  return (
    <span
      aria-hidden="true"
      className={NOTIFICATION_ACTOR_NAME_PLACEHOLDER_CLASS_NAME}
    />
  );
}

/**
 * Marks a row the actor treatment is switched on for.
 *
 * `inbox.css` cannot see a PostHog flag, and the rows it would otherwise reach
 * include the built-in Liveblocks thread rows, which already show avatars in
 * this same list today. Everything ISS-5010 changes visually hangs off this
 * class, so with the flag off the stylesheet matches nothing new.
 */
export const NOTIFICATION_ACTOR_ROW_CLASS_NAME =
  "cl-inbox-notification-actor-row";

/**
 * Append {@link NOTIFICATION_ACTOR_ROW_CLASS_NAME} to whatever `className`
 * Liveblocks already passed the row, rather than replacing it.
 */
export function notificationActorRowClassName(className?: string): string {
  return className
    ? `${className} ${NOTIFICATION_ACTOR_ROW_CLASS_NAME}`
    : NOTIFICATION_ACTOR_ROW_CLASS_NAME;
}
