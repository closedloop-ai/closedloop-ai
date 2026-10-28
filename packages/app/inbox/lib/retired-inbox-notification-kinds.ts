import { isRetiredInboxNotificationKind } from "@repo/api/src/types/retired-inbox-notification-kinds";

/**
 * Drops notifications of retired kinds (PRD-795) before an inbox list body
 * checks for emptiness. Liveblocks renders an unregistered kind as an empty
 * list item, and a list holding only retired kinds would otherwise never reach
 * the empty state. Both list bodies call this one helper.
 */
export function withoutRetiredInboxNotificationKinds<
  T extends { readonly kind: string },
>(notifications: readonly T[]): T[] {
  return notifications.filter(
    (notification) => !isRetiredInboxNotificationKind(notification.kind)
  );
}
