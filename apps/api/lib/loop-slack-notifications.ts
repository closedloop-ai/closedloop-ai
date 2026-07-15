import "server-only";

import { isFeatureFlagEnabledForDistinctId } from "@repo/analytics/feature-flags";
import { withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { resolveIntegrationToken } from "@/lib/integration-encryption";
import { postToSlackChannel } from "@/lib/slack-notifier";

/**
 * PostHog rollout key for posting loop-completion engagement messages to an
 * org's connected Slack workspace. Gating is org-scoped and server-side (the
 * message is never posted when the flag is off) and fails closed so a
 * flag-evaluation error never spams a workspace.
 */
export const LOOP_COMPLETED_SLACK_NOTIFICATION_FEATURE_FLAG_KEY =
  "slack-loop-completed-notification" as const;

type DispatchLoopCompletedSlackNotificationParams = {
  organizationId: string;
  /** Humanized loop label, e.g. "Execute". */
  loopLabel: string;
  /** Target repo/project, e.g. "acme/widgets"; null when the loop has no repo. */
  projectLabel: string | null;
};

/**
 * Fire-and-forget engagement post telling an org's connected Slack workspace
 * that a Loop shipped. No-ops when the org has no `SlackIntegration` (opt-out is
 * implicit in whether Slack is connected). Gated behind the rollout flag and
 * dispatched via `waitUntil` so it never blocks (or fails) the loop-completion
 * response path.
 */
export function dispatchLoopCompletedSlackNotification(
  params: DispatchLoopCompletedSlackNotificationParams
): void {
  waitUntil(postWhenConnected(params));
}

async function postWhenConnected(
  params: DispatchLoopCompletedSlackNotificationParams
): Promise<void> {
  if (!(await isLoopCompletedSlackNotificationEnabled(params.organizationId))) {
    return;
  }

  const integration = await withDb((db) =>
    db.slackIntegration.findUnique({
      where: { organizationId: params.organizationId },
      select: {
        accessToken: true,
        accessTokenEncrypted: true,
        defaultChannelId: true,
      },
    })
  );

  // No connected workspace, or a workspace without a default channel selected,
  // means there is nowhere to post — opt-out is implicit.
  if (!integration?.defaultChannelId) {
    return;
  }

  // Prefer the KMS-encrypted token; fall back to the legacy plaintext column
  // for rows not yet backfilled (parity with Google/Linear integrations).
  // Fail closed on a decryption error so a KMS hiccup never rejects this
  // fire-and-forget path (mirrors the feature-flag gate above).
  let accessToken: string | null;
  try {
    accessToken = await resolveIntegrationToken(
      integration.accessTokenEncrypted,
      integration.accessToken
    );
  } catch (error) {
    log.warn("loop_completed_slack_notification_token_unavailable", {
      organizationId: params.organizationId,
      error: parseError(error),
    });
    return;
  }
  if (!accessToken) {
    return;
  }

  const text = params.projectLabel
    ? `Shipped ${params.loopLabel} in ${params.projectLabel}`
    : `Shipped ${params.loopLabel}`;

  const result = await postToSlackChannel(
    accessToken,
    integration.defaultChannelId,
    text
  );

  if (!result.ok) {
    log.warn("loop_completed_slack_notification_failed", {
      organizationId: params.organizationId,
      slackError: result.error ?? "unknown",
    });
  }
}

async function isLoopCompletedSlackNotificationEnabled(
  organizationId: string
): Promise<boolean> {
  try {
    return (
      (await isFeatureFlagEnabledForDistinctId(
        LOOP_COMPLETED_SLACK_NOTIFICATION_FEATURE_FLAG_KEY,
        organizationId
      )) === true
    );
  } catch (error) {
    log.warn("loop_completed_slack_notification_feature_flag_unavailable", {
      error: parseError(error),
    });
    return false;
  }
}
