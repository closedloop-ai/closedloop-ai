/**
 * ISS-12435 (PRD-795): inbox notification kinds whose producer is gone.
 * Liveblocks still stores notifications of these kinds, so the inbox lists drop
 * them before rendering, and the post-deploy cleanup script deletes them.
 */
export const RetiredInboxNotificationKind = {
  LoopCompleted: "$loopCompleted",
} as const;
export type RetiredInboxNotificationKind =
  (typeof RetiredInboxNotificationKind)[keyof typeof RetiredInboxNotificationKind];

export const RETIRED_INBOX_NOTIFICATION_KINDS: ReadonlySet<string> = new Set(
  Object.values(RetiredInboxNotificationKind)
);

export function isRetiredInboxNotificationKind(kind: string): boolean {
  return RETIRED_INBOX_NOTIFICATION_KINDS.has(kind);
}
