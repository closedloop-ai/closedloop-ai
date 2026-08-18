import { log } from "@repo/observability/log";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { scheduleLogFlush, scheduleLogFlushAfter } from "@/lib/route-utils";
import { buildCorrelationId, notifySlack } from "@/lib/slack-notifier";
import { sampleSessionIngestionHealth } from "./service";

const ROUTE_TAG = "[sample-session-ingestion-health]";
const SLACK_ROUTE = "sample-session-ingestion-health";
const SLACK_ALERT_TITLE = "Session ingestion health check failure";

/**
 * Sampling cron for cloud session-ingestion health (ISS-4543).
 *
 * Emits `session.ingestion.active_orgs`, `session.ingestion.stalled_orgs`, and
 * a bounded set of per-org `session.ingestion.staleness` gauges. Together they
 * answer "is session data still arriving?" — the question nothing asked when
 * ISS-4537 froze an org's ingestion for ~2 days behind FEA-4169's fail-closed
 * policy gate and it was found only by manual inspection.
 *
 * This is the catch-all backstop. The fast, gate-specific detector is
 * `session.ingestion.policy_denied`, emitted from `isOrgSessionSyncPolicyEnabled`
 * on every denied ingest attempt.
 *
 * Protected by CRON_SECRET bearer token. A sampling failure returns 500 both to
 * trip Vercel's built-in cron failure alerting and to make it impossible for
 * the alerting lane itself to fail silently — a health check nobody notices has
 * broken is exactly the hole this ticket exists to close.
 */
export const GET = async (request: Request): Promise<Response> => {
  const denied = validateCronSecret(request, ROUTE_TAG);
  if (denied) {
    return denied;
  }

  try {
    const summary = await sampleSessionIngestionHealth(new Date());

    log.info(`${ROUTE_TAG} sampling complete`, summary);
    scheduleLogFlush();

    return new Response(
      `OK: orgs=${summary.orgsWithIngestHistory} active=${summary.activeOrgCount} stalled=${summary.stalledOrgCount} quiet=${summary.quietOrgCount} dormant=${summary.dormantOrgCount} fleetPresent=${summary.fleetPresentOrgCount} platformQuiet=${summary.platformQuiet} neverIngestedTargets=${summary.neverIngestedTargetCount} samples=${summary.stalenessSamplesEmitted}`,
      { status: 200 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`${ROUTE_TAG} sampling failed`, { error: message });
    scheduleLogFlushAfter(
      notifySlack({
        route: SLACK_ROUTE,
        title: SLACK_ALERT_TITLE,
        message: `Session ingestion health sampling failed: ${message}`,
        correlationId: buildCorrelationId(),
      }).catch(() => {
        // Notification failure must not mask the 500 the cron already returns.
      })
    );

    return new Response("sample-session-ingestion-health failed", {
      status: 500,
    });
  }
};
