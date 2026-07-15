import {
  getNotificationEntityPath,
  NotificationEntityKind,
} from "@repo/api/src/types/notification-routes";
import { sendAwaitingInputNotification } from "@repo/collaboration/server/inbox-notifications";
import { withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { isFeatureFlagEnabledForAnyIdentity } from "@/lib/feature-flag-identity";
import { resolveIntegrationToken } from "@/lib/integration-encryption";
import { postToSlackChannel } from "@/lib/slack-notifier";

/**
 * PostHog rollout key for the "run needs input" push notifications. This is the
 * same flag that gates the Active Runs surface (the panel that derives and
 * renders awaiting-input), so the push notifications ship and roll out with it.
 * Gating is per-user and server-side (nothing is pushed when the flag is off)
 * and fails closed so a flag-evaluation error never spams a user.
 */
export const AWAITING_INPUT_NOTIFICATION_FEATURE_FLAG_KEY = "emergent" as const;

const TRAILING_SLASH_REGEX = /\/+$/;

export type DispatchAwaitingInputNotificationParams = {
  userId: string;
  organizationId: string;
  /** Session artifact id — the deep-link target (`/sessions/{id}`). */
  sessionId: string;
  /** Human-readable run name for the notification copy. */
  sessionName: string;
};

/**
 * Fire-and-forget notifications telling a run's owner it just blocked on their
 * input: an in-app inbox entry plus a Slack DM, each carrying a deep link so the
 * run can be unblocked from anywhere. Gated behind the `emergent` rollout flag
 * and dispatched via `waitUntil` so it never blocks (or fails) the session-sync
 * path that detected the transition.
 */
export function dispatchAwaitingInputNotification(
  params: DispatchAwaitingInputNotificationParams
): void {
  waitUntil(sendWhenEnabled(params));
}

async function sendWhenEnabled(
  params: DispatchAwaitingInputNotificationParams
): Promise<void> {
  if (!(await isAwaitingInputNotificationEnabled(params.userId))) {
    return;
  }

  const sessionPath = getNotificationEntityPath({
    kind: NotificationEntityKind.Session,
    sessionId: params.sessionId,
  });

  // The inbox entry carries the relative path (resolved client-side); Slack
  // needs an absolute URL to render a clickable link. Both delivery legs are
  // independent, so run them concurrently — and `allSettled` so a failure in
  // one (e.g. Liveblocks unreachable) never rejects the other or the
  // `waitUntil`-wrapped dispatch.
  await Promise.allSettled([
    sendInAppNotification(params, sessionPath),
    sendSlackDm(params, sessionPath),
  ]);
}

function sendInAppNotification(
  params: DispatchAwaitingInputNotificationParams,
  sessionPath: string
): Promise<void> {
  return sendAwaitingInputNotification({
    userId: params.userId,
    organizationId: params.organizationId,
    subjectId: params.sessionId,
    sessionTitle: params.sessionName,
    sessionUrl: sessionPath,
  });
}

async function sendSlackDm(
  params: DispatchAwaitingInputNotificationParams,
  sessionPath: string
): Promise<void> {
  try {
    // Both lookups share one connection checkout — the DM needs the org's
    // workspace token and the recipient's Slack identity together.
    const [integration, user] = await withDb((db) =>
      Promise.all([
        db.slackIntegration.findUnique({
          where: { organizationId: params.organizationId },
          select: { accessToken: true, accessTokenEncrypted: true },
        }),
        db.user.findUnique({
          where: { id: params.userId },
          select: { slackId: true },
        }),
      ])
    );

    // A DM needs both a connected workspace and a Slack identity for the
    // recipient. Missing either means there is nowhere to DM — opt-out is
    // implicit in whether the user linked Slack.
    if (!(integration && user?.slackId)) {
      return;
    }

    // Prefer the KMS-encrypted token; fall back to the legacy plaintext column
    // for rows not yet backfilled (parity with loop-slack/Google/Linear). A
    // decryption error propagates to the outer catch, which fails closed.
    const accessToken = await resolveIntegrationToken(
      integration.accessTokenEncrypted,
      integration.accessToken
    );
    if (!accessToken) {
      return;
    }

    const link = toAbsoluteUrl(sessionPath);
    const text = `:hourglass_flowing_sand: *${params.sessionName}* needs your input. Approve or reply from anywhere: ${link}`;

    const result = await postToSlackChannel(accessToken, user.slackId, text);

    if (!result.ok) {
      log.warn("awaiting_input_slack_notification_failed", {
        organizationId: params.organizationId,
        userId: params.userId,
        slackError: result.error ?? "unknown",
      });
    }
  } catch (error) {
    log.warn("awaiting_input_slack_notification_error", {
      organizationId: params.organizationId,
      userId: params.userId,
      error: parseError(error),
    });
  }
}

/**
 * Absolutize a relative app path for Slack (which cannot resolve a bare path).
 * Falls back to the relative path when the app URL is unconfigured — still
 * informative as plain text, never a broken/empty link.
 */
function toAbsoluteUrl(path: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(
    TRAILING_SLASH_REGEX,
    ""
  );
  return base ? `${base}${path}` : path;
}

async function isAwaitingInputNotificationEnabled(
  userId: string
): Promise<boolean> {
  try {
    // FEA-2858: the Active Runs surface this rides on is a CLIENT PostHog flag
    // evaluated after `posthog.identify(user.id)` with Clerk's user id
    // (packages/analytics/hooks/use-identify-user.ts), while `userId` here is the
    // internal DB user UUID — a separate distinct-id namespace. A rollout
    // targeting users by their Clerk id would let them see Active Runs while this
    // gate (checking only the DB UUID) silently suppressed both the Liveblocks
    // inbox entry and the Slack DM. Evaluate BOTH distinct ids via the shared
    // multi-identity helper so the notifications roll out with the surface.
    const clerkUserId = await resolveClerkUserId(userId);
    return await isFeatureFlagEnabledForAnyIdentity(
      AWAITING_INPUT_NOTIFICATION_FEATURE_FLAG_KEY,
      { userId, clerkUserId },
      "awaiting_input_notification_feature_flag_unavailable"
    );
  } catch (error) {
    log.warn("awaiting_input_notification_feature_flag_unavailable", {
      error: parseError(error),
    });
    return false;
  }
}

/**
 * Look up the run owner's Clerk user id for the PostHog distinct-id check.
 * Best-effort: a missing user or DB error resolves to `null` so the flag gate
 * still evaluates against the internal user id and fails closed cleanly (the
 * shared helper drops null identities).
 */
async function resolveClerkUserId(userId: string): Promise<string | null> {
  try {
    const user = await withDb((db) =>
      db.user.findUnique({
        where: { id: userId },
        select: { clerkId: true },
      })
    );
    return user?.clerkId ?? null;
  } catch (error) {
    log.warn("awaiting_input_notification_clerk_id_lookup_failed", {
      userId,
      error: parseError(error),
    });
    return null;
  }
}
