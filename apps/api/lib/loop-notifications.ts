import "server-only";

import { isFeatureFlagEnabledForDistinctId } from "@repo/analytics/feature-flags";
import {
  getNotificationEntityPath,
  NotificationEntityKind,
} from "@repo/api/src/types/notification-routes";
import { sendLoopCompletedNotification } from "@repo/collaboration/server/inbox-notifications";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";

/**
 * PostHog rollout key for the inbox loop-completed notification. Gating is
 * server-side (the notification is never triggered when the flag is off) and
 * fails closed so a flag-evaluation error never spams an unintended audience.
 */
export const LOOP_COMPLETED_NOTIFICATION_FEATURE_FLAG_KEY =
  "inbox-loop-completed-notification" as const;

type DispatchLoopCompletedNotificationParams = {
  userId: string;
  organizationId: string;
  loopId: string;
  loopTitle: string;
};

/**
 * Fire-and-forget inbox notification telling a Loop's owner their autonomous
 * run finished. Gated behind the rollout flag and dispatched via `waitUntil`
 * so it never blocks (or fails) the loop-completion response path.
 */
export function dispatchLoopCompletedNotification(
  params: DispatchLoopCompletedNotificationParams
): void {
  waitUntil(sendWhenEnabled(params));
}

async function sendWhenEnabled(
  params: DispatchLoopCompletedNotificationParams
): Promise<void> {
  if (!(await isLoopCompletedNotificationEnabled(params.userId))) {
    return;
  }
  await sendLoopCompletedNotification({
    userId: params.userId,
    organizationId: params.organizationId,
    subjectId: params.loopId,
    loopTitle: params.loopTitle,
    loopUrl: getNotificationEntityPath({
      kind: NotificationEntityKind.Loop,
      loopId: params.loopId,
    }),
  });
}

async function isLoopCompletedNotificationEnabled(
  userId: string
): Promise<boolean> {
  try {
    return (
      (await isFeatureFlagEnabledForDistinctId(
        LOOP_COMPLETED_NOTIFICATION_FEATURE_FLAG_KEY,
        userId
      )) === true
    );
  } catch (error) {
    log.warn("loop_completed_notification_feature_flag_unavailable", {
      error: parseError(error),
    });
    return false;
  }
}
