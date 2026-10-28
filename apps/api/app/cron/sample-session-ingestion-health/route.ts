import { log } from "@repo/observability/log";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { scheduleLogFlush, scheduleLogFlushAfter } from "@/lib/route-utils";
import { buildCorrelationId, notifySlack } from "@/lib/slack-notifier";
import { sampleSessionIngestionHealth } from "./service";
import { sampleSessionFleetCounts } from "./service/fleet-counts";

const ROUTE_TAG = "[sample-session-ingestion-health]";
const SLACK_ROUTE = "sample-session-ingestion-health";
const SLACK_ALERT_TITLE = "Session ingestion health check failure";
const FLEET_SLACK_ALERT_TITLE = "Session fleet count failure";

/**
 * Sampling cron for cloud session-ingestion health (ISS-4543).
 *
 * Emits `session.ingestion.active_orgs`, `session.ingestion.stalled_orgs`, and
 * a bounded set of per-org `session.ingestion.staleness` gauges. Together they
 * answer "is session data still arriving?" — the question nothing asked when
 * ISS-4537 froze an org's ingestion for ~2 days and it was found only by manual
 * inspection. It also emits the `session.fleet.total_sessions` /
 * `session.fleet.total_orgs` dashboard gauges (ISS-12050).
 *
 * ISS-11449 retired the fast, gate-specific companion
 * (`session.ingestion.policy_denied`) along with the org session-sync policy it
 * observed, so this backstop is now the whole signal.
 *
 * Protected by CRON_SECRET bearer token. An ingestion sampling failure returns
 * 500 both to trip Vercel's built-in cron failure alerting and to make it
 * impossible for the alerting lane itself to fail silently — a health check
 * nobody notices has broken is exactly the hole this ticket exists to close.
 */
export const GET = async (request: Request): Promise<Response> => {
  const denied = validateCronSecret(request, ROUTE_TAG);
  if (denied) {
    return denied;
  }

  try {
    const summary = await sampleSessionIngestionHealth(new Date());

    log.info(`${ROUTE_TAG} sampling complete`, summary);
    // Before the flush, so the fleet gauge log lines ship with it.
    await sampleFleetCountsOrAlert();
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
    // After the ingestion alert is scheduled, so a slow fleet count against the
    // same failing database cannot delay or crowd it out.
    await sampleFleetCountsOrAlert();
    scheduleLogFlush();

    return new Response("sample-session-ingestion-health failed", {
      status: 500,
    });
  }
};

/**
 * ISS-12050: the fleet gauges are dashboard figures, not ingestion health, so
 * they are sampled whether or not the ingestion sample succeeded, and a failed
 * count alerts under its own title without changing the ingestion status code.
 */
async function sampleFleetCountsOrAlert(): Promise<void> {
  try {
    const fleetCounts = await sampleSessionFleetCounts();
    log.info(`${ROUTE_TAG} fleet counts sampled`, fleetCounts);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`${ROUTE_TAG} fleet count failed`, { error: message });
    scheduleLogFlushAfter(
      notifySlack({
        route: SLACK_ROUTE,
        title: FLEET_SLACK_ALERT_TITLE,
        message: `Session fleet count sampling failed: ${message}`,
        correlationId: buildCorrelationId(),
      }).catch(() => {
        // Notification failure must not turn the ingestion result into a 500.
      })
    );
  }
}
