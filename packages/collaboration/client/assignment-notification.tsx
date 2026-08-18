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

type AssignmentNotificationProps =
  InboxNotificationCustomKindProps<"$assignment"> & {
    /**
     * ISS-5010: name the person who made the assignment (avatar plus name) and
     * lead the row with them, instead of the identical "You were assigned to
     * artifact" preamble every assignment row otherwise shares.
     *
     * Off by default per the closed-by-default UI policy (ISS-4779); the
     * `apps/app` inbox page turns it on behind a PostHog flag.
     */
    showActor?: boolean;
  };

export type { AssignmentNotificationProps };

export function AssignmentNotification({
  inboxNotification,
  showActor,
  ...props
}: AssignmentNotificationProps) {
  const activity = inboxNotification.activities[0];
  const entityType = String(activity?.data?.entityType ?? "item");
  const entityTitle = String(activity?.data?.entityTitle ?? "Untitled");
  const entityUrl = String(activity?.data?.entityUrl ?? "");
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
          title={buildAssignmentTitle({ actor, entityTitle, entityType })}
        >
          {null}
        </InboxNotification.Custom>
      )}
    />
  );
}

type AssignmentTitleParams = {
  actor: NotificationActor;
  entityTitle: string;
  entityType: string;
};

/**
 * The row's headline.
 *
 * Once the actor is named, the varying part (who assigned it) leads, so
 * consecutive rows differ from their first character. The name stays plain and
 * the strong stays on the entity title: every other row in this list — the
 * awaiting-input row, the loop-completed row, and the actor-less fallback below
 * — bolds the thing you are clicking through to, and the bold mass must not
 * jump to the front of the line just because the lookup resolved. The bold also
 * marks where the entity type ends and its title begins, which "assigned you
 * artifact Fix session transcripts" otherwise leaves to the reader.
 *
 * A lookup still in flight keeps that same shape and stands a bar where the
 * name will land, rather than painting the passive sentence and then rewriting
 * every word of the row once the name arrives.
 *
 * Only a genuinely absent actor falls back to the passive phrasing. It says
 * nothing about who acted, which is the truth when there is nobody to name.
 */
function buildAssignmentTitle({
  actor,
  entityTitle,
  entityType,
}: AssignmentTitleParams) {
  if (actor.state === NotificationActorState.Resolved) {
    return (
      <>
        {actor.name} assigned you {entityType} <strong>{entityTitle}</strong>
      </>
    );
  }
  if (actor.state === NotificationActorState.Loading) {
    return (
      <>
        <NotificationActorNamePlaceholder /> assigned you {entityType}{" "}
        <strong>{entityTitle}</strong>
      </>
    );
  }
  return (
    <>
      You were assigned to {entityType} <strong>{entityTitle}</strong>
    </>
  );
}
