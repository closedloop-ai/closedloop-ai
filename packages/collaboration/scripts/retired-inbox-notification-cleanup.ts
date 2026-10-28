import type { Liveblocks } from "@liveblocks/node";
import { isRetiredInboxNotificationKind } from "@repo/api/src/types/retired-inbox-notification-kinds";
import { z } from "zod";

/**
 * ISS-12435 (PRD-795): deletes stored inbox notifications whose producer was
 * removed (`$loopCompleted`), so they stop counting toward a user's unread
 * badge. The inbox lists already drop these kinds before rendering; this
 * clears what Liveblocks still stores.
 *
 * Liveblocks lists notifications per user and organization, and the kind is
 * filtered here after listing. The recipients come from a snapshot taken
 * before the data step empties `loops` (see the PR runbook).
 */

export type InboxNotificationCleanupClient = Pick<
  Liveblocks,
  "iterInboxNotifications" | "deleteInboxNotification"
>;

const recipientSchema = z.object({
  userId: z.string().min(1),
  organizationId: z.string().min(1),
});

export const recipientsSchema = z.array(recipientSchema);

export type InboxNotificationRecipient = z.infer<typeof recipientSchema>;

export type InboxNotificationCleanupFailure = InboxNotificationRecipient & {
  inboxNotificationId: string | null;
  error: string;
};

export type InboxNotificationCleanupReport = {
  apply: boolean;
  recipients: number;
  scanned: number;
  matched: number;
  deleted: number;
  failures: InboxNotificationCleanupFailure[];
};

export async function cleanupRetiredInboxNotifications(params: {
  client: InboxNotificationCleanupClient;
  recipients: readonly InboxNotificationRecipient[];
  apply: boolean;
}): Promise<InboxNotificationCleanupReport> {
  const report: InboxNotificationCleanupReport = {
    apply: params.apply,
    recipients: params.recipients.length,
    scanned: 0,
    matched: 0,
    deleted: 0,
    failures: [],
  };
  for (const recipient of params.recipients) {
    await cleanupRecipient(params.client, recipient, params.apply, report);
  }
  return report;
}

async function cleanupRecipient(
  client: InboxNotificationCleanupClient,
  recipient: InboxNotificationRecipient,
  apply: boolean,
  report: InboxNotificationCleanupReport
): Promise<void> {
  const retiredIds: string[] = [];
  try {
    for await (const notification of client.iterInboxNotifications({
      userId: recipient.userId,
      organizationId: recipient.organizationId,
    })) {
      report.scanned += 1;
      if (isRetiredInboxNotificationKind(notification.kind)) {
        retiredIds.push(notification.id);
      }
    }
  } catch (error) {
    report.failures.push({
      ...recipient,
      inboxNotificationId: null,
      error: describeError(error),
    });
    return;
  }
  report.matched += retiredIds.length;
  if (!apply) {
    return;
  }
  for (const inboxNotificationId of retiredIds) {
    try {
      await client.deleteInboxNotification({
        userId: recipient.userId,
        inboxNotificationId,
      });
      report.deleted += 1;
    } catch (error) {
      report.failures.push({
        ...recipient,
        inboxNotificationId,
        error: describeError(error),
      });
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
