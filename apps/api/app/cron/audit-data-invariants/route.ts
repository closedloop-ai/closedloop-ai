import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { scheduleLogFlush, scheduleLogFlushAfter } from "@/lib/route-utils";
import { buildCorrelationId, notifySlack } from "@/lib/slack-notifier";
import { auditDataInvariants, formatViolationCounts } from "./service";

const ROUTE_TAG = "[audit-data-invariants]";
const SLACK_ROUTE = "audit-data-invariants";
const SLACK_ALERT_TITLE = "Data invariant violations detected";

export const maxDuration = 300;

export const GET = async (request: Request): Promise<Response> => {
  const denied = validateCronSecret(request, ROUTE_TAG);
  if (denied) {
    return denied;
  }

  try {
    const results = await auditDataInvariants();

    log.info(`${ROUTE_TAG} audit complete`, results);
    scheduleLogFlush();

    if (results.totalViolations > 0) {
      scheduleLogFlushAfter(
        notifySlack({
          route: SLACK_ROUTE,
          title: SLACK_ALERT_TITLE,
          message: `Violations: ${formatViolationCounts(results)}`,
          correlationId: buildCorrelationId(),
        }).catch(() => {})
      );
    }

    return new Response(
      `OK: ${formatViolationCounts(results)} dualLedgerBranches=${results.dualLedgerBranches} costEstimateDivergence=${results.costEstimateDivergence} enrichmentPendingSessions=${results.enrichmentPendingSessions} enrichmentPendingPrs=${results.enrichmentPendingPrs} unpricedTokenSessions=${results.unpricedTokenSessions.count} offVocabularyArtifactStatuses=${results.offVocabularyArtifactStatuses.count} totalViolations=${results.totalViolations}`,
      { status: 200 }
    );
  } catch (error) {
    const message = parseError(error);
    log.error(`${ROUTE_TAG} audit failed`, { error: message });
    scheduleLogFlushAfter(
      notifySlack({
        route: SLACK_ROUTE,
        title: SLACK_ALERT_TITLE,
        message: `Data invariant audit failed: ${message}`,
        correlationId: buildCorrelationId(),
      }).catch(() => {})
    );

    return new Response("audit-data-invariants failed", { status: 500 });
  }
};
