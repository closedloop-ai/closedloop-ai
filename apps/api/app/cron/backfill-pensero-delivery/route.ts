import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { scheduleLogFlush, scheduleLogFlushAfter } from "@/lib/route-utils";
import { buildCorrelationId, notifySlack } from "@/lib/slack-notifier";
import { buildDegradedAlertMessage } from "./failure-reason";
import {
  PENSERO_BACKFILL_MODE_VALUES,
  PenseroBackfillMode,
  parsePenseroBackfillMode,
} from "./mode";
import {
  formatSweepSummary,
  formatValidationSummary,
  sweepPenseroDeliveryBackfill,
  validatePenseroDeliveryBackfill,
} from "./service";

const ROUTE_TAG = "[backfill-pensero-delivery]";
const SLACK_ROUTE = "backfill-pensero-delivery";
const SLACK_ALERT_TITLE = "Pensero delivery backfill degraded";

/**
 * ISS-8761: the daily cron that actually runs the Pensero delivery backfill.
 *
 * `runPenseroDeliveryBackfill` (ISS-8399) shipped complete and with no
 * production caller at all — no cron, no route, no queue consumer. An
 * organization could store a Pensero credential, watch the settings card
 * confirm it, and never receive a single delivery point. This route is the
 * missing trigger. Deleting the `sweepPenseroDeliveryBackfill` call below
 * restores that defect exactly, and the route test asserts it.
 *
 * Protected by CRON_SECRET bearer token — must be set in the environment and
 * passed as `Authorization: Bearer <secret>` (Vercel Cron does this). The
 * secret is what keeps DB and KMS access server-side: this is the only path on
 * which a per-org Pensero token is ever decrypted.
 *
 * Patterned on `/cron/backfill-orphan-transcripts` and `/cron/audit-data-invariants`:
 * `validateCronSecret` first, a 500 on failure so Vercel's built-in cron
 * failure alerting trips, and a Slack alert on a degraded run. The Datadog
 * signal is the `pensero.backfill.*` family emitted from the service — a raw
 * log is not an alert, and a scheduler that fails quietly is the same bug as no
 * scheduler.
 */

export const maxDuration = 300;

export const GET = async (request: Request): Promise<Response> => {
  const denied = validateCronSecret(request, ROUTE_TAG);
  if (denied) {
    return denied;
  }

  // Fail closed BEFORE any work: an unrecognised mode must never fall through
  // to the mutating sweep. See `./mode`.
  const mode = parsePenseroBackfillMode(
    new URL(request.url).searchParams.get("mode")
  );
  if (mode === null) {
    return new Response(
      `mode must be one of: ${PENSERO_BACKFILL_MODE_VALUES}`,
      { status: 400 }
    );
  }

  try {
    if (mode === PenseroBackfillMode.Validate) {
      const summary = await validatePenseroDeliveryBackfill({
        now: new Date(),
      });
      const formatted = formatValidationSummary(summary);

      log.info(`${ROUTE_TAG} validation complete`, summary);
      scheduleLogFlush();
      return new Response(`OK: ${formatted}`, { status: 200 });
    }

    const summary = await sweepPenseroDeliveryBackfill({ now: new Date() });
    const formatted = formatSweepSummary(summary);

    log.info(`${ROUTE_TAG} sweep complete`, summary);
    scheduleLogFlush();

    if (summary.degraded) {
      scheduleLogFlushAfter(
        notifySlack({
          route: SLACK_ROUTE,
          title: SLACK_ALERT_TITLE,
          message: buildDegradedAlertMessage(
            summary.dayFailureSummary,
            formatted
          ),
          correlationId: buildCorrelationId(),
        }).catch(() => {
          // Notification failure must not mask the summary the cron returns.
        })
      );
    }

    return new Response(`OK: ${formatted}`, { status: 200 });
  } catch (error) {
    const message = parseError(error);
    log.error(`${ROUTE_TAG} sweep failed`, { error: message });
    scheduleLogFlushAfter(
      notifySlack({
        route: SLACK_ROUTE,
        title: SLACK_ALERT_TITLE,
        message: `Pensero delivery backfill sweep failed: ${message}`,
        correlationId: buildCorrelationId(),
      }).catch(() => {
        // Notification failure must not mask the 500 the cron already returns.
      })
    );

    return new Response("backfill-pensero-delivery failed", { status: 500 });
  }
};
