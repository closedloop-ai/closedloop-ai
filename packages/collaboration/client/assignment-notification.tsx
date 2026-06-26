"use client";

import {
  InboxNotification,
  type InboxNotificationCustomKindProps,
} from "@liveblocks/react-ui";

type AssignmentNotificationProps =
  InboxNotificationCustomKindProps<"$assignment">;

export function AssignmentNotification({
  inboxNotification,
  ...props
}: AssignmentNotificationProps) {
  const activity = inboxNotification.activities[0];
  const entityType = String(activity?.data?.entityType ?? "item");
  const entityTitle = String(activity?.data?.entityTitle ?? "Untitled");
  const entityUrl = String(activity?.data?.entityUrl ?? "");

  return (
    <InboxNotification.Custom
      {...props}
      href={entityUrl}
      inboxNotification={inboxNotification}
      title={
        <>
          You were assigned to {entityType} <strong>{entityTitle}</strong>
        </>
      }
    >
      {null}
    </InboxNotification.Custom>
  );
}
