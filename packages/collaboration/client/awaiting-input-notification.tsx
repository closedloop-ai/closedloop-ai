"use client";

import {
  InboxNotification,
  type InboxNotificationCustomKindProps,
} from "@liveblocks/react-ui";
import { resolveSessionNotificationTitle } from "../shared/notification-labels";

type AwaitingInputNotificationProps =
  InboxNotificationCustomKindProps<"$awaitingInput">;

export function AwaitingInputNotification({
  inboxNotification,
  ...props
}: AwaitingInputNotificationProps) {
  const activity = inboxNotification.activities[0];
  // The visible label must be human-readable — never a raw session UUID
  // (FEA-3969). The UUID stays the link target only, via `sessionUrl`.
  const sessionTitle = resolveSessionNotificationTitle(
    activity?.data?.sessionTitle
  );
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
