"use client";

import {
  InboxNotification,
  type InboxNotificationCustomKindProps,
} from "@liveblocks/react-ui";

type LoopCompletedNotificationProps =
  InboxNotificationCustomKindProps<"$loopCompleted">;

export function LoopCompletedNotification({
  inboxNotification,
  ...props
}: LoopCompletedNotificationProps) {
  const activity = inboxNotification.activities[0];
  const loopTitle = String(activity?.data?.loopTitle ?? "your Loop");
  const loopUrl = String(activity?.data?.loopUrl ?? "");

  return (
    <InboxNotification.Custom
      {...props}
      href={loopUrl}
      inboxNotification={inboxNotification}
      title={
        <>
          Your Loop <strong>{loopTitle}</strong> finished
        </>
      }
    >
      {null}
    </InboxNotification.Custom>
  );
}
