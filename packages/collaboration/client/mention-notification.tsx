"use client";

import {
  InboxNotification,
  type InboxNotificationCustomKindProps,
} from "@liveblocks/react-ui";
import type { NotificationActor } from "../shared/notification-actor";
import {
  NotificationActorState,
  resolveNotificationActorId,
} from "../shared/notification-actor";
import {
  NotificationActorNamePlaceholder,
  NotificationActorSlot,
  notificationActorAside,
  notificationActorRowClassName,
} from "./notification-actor";

type MentionNotificationProps = InboxNotificationCustomKindProps<"$mention"> & {
  /**
   * ISS-5010: name the person who mentioned you (avatar plus name) and lead the
   * row with them. Kept in step with the assignment row so the two custom kinds
   * carry the same information for the same class of event.
   *
   * Off by default per the closed-by-default UI policy (ISS-4779); the
   * `apps/app` inbox page turns it on behind a PostHog flag.
   */
  showActor?: boolean;
};

export type { MentionNotificationProps };

export function MentionNotification({
  inboxNotification,
  showActor,
  ...props
}: MentionNotificationProps) {
  const activity = inboxNotification.activities[0];
  const entityType = String(activity?.data?.entityType ?? "session");
  const entityTitle = String(activity?.data?.entityTitle ?? "Untitled");
  const entityUrl = String(activity?.data?.entityUrl ?? "");
  const commentPreview = String(activity?.data?.commentPreview ?? "");
  const isActorRow = showActor === true;
  const actorId = isActorRow
    ? resolveNotificationActorId(activity?.data?.actorId)
    : null;

  return (
    <NotificationActorSlot
      actorId={actorId}
      render={(actor) => (
        <InboxNotification.Custom
          {...props}
          aside={isActorRow ? notificationActorAside(actor) : undefined}
          className={
            isActorRow
              ? notificationActorRowClassName(props.className)
              : props.className
          }
          href={entityUrl}
          inboxNotification={inboxNotification}
          title={buildMentionTitle({ actor, entityTitle, entityType })}
        >
          {commentPreview ? <span>{commentPreview}</span> : null}
        </InboxNotification.Custom>
      )}
    />
  );
}

type MentionTitleParams = {
  actor: NotificationActor;
  entityTitle: string;
  entityType: string;
};

/**
 * The row's headline. Once the actor is named, who mentioned you leads, with the
 * name plain and the strong left on the entity title, matching the assignment
 * row and every other row in this list. Without that emphasis "mentioned you in
 * the session Nightly review" runs three nouns together with nothing marking
 * where the type ends and the title starts. "Mentioned you in" matches the
 * built-in Liveblocks wording rather than introducing a second preposition into
 * one list.
 *
 * A lookup still in flight keeps that shape and stands a bar where the name
 * will land, so the row does not rewrite its words under a reader mid-scan.
 * Only a genuinely absent actor falls back to the passive phrasing, rather than
 * naming a person the row cannot identify.
 */
function buildMentionTitle({
  actor,
  entityTitle,
  entityType,
}: MentionTitleParams) {
  if (actor.state === NotificationActorState.Resolved) {
    return (
      <>
        {actor.name} mentioned you in {entityType}{" "}
        <strong>{entityTitle}</strong>
      </>
    );
  }
  if (actor.state === NotificationActorState.Loading) {
    return (
      <>
        <NotificationActorNamePlaceholder /> mentioned you in {entityType}{" "}
        <strong>{entityTitle}</strong>
      </>
    );
  }
  return (
    <>
      You were mentioned in a comment on {entityType}{" "}
      <strong>{entityTitle}</strong>
    </>
  );
}
