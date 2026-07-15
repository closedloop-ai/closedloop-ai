"use client";

import {
  InboxNotification,
  type InboxNotificationCustomKindProps,
} from "@liveblocks/react-ui";

type AwaitingInputNotificationProps =
  InboxNotificationCustomKindProps<"$awaitingInput">;

export function AwaitingInputNotification({
  inboxNotification,
  ...props
}: AwaitingInputNotificationProps) {
  const activity = inboxNotification.activities[0];
  const sessionTitle = String(activity?.data?.sessionTitle ?? "your run");
  const sessionUrl = String(activity?.data?.sessionUrl ?? "");

  return (
    <InboxNotification.Custom
      {...props}
      href={sessionUrl}
      inboxNotification={inboxNotification}
      title={
        <>
          <strong>{sessionTitle}</strong> needs your input
        </>
      }
    >
      {null}
    </InboxNotification.Custom>
  );
}
