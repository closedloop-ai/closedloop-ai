import { INSIGHTS_USER_BREAKDOWN_ROW_CAP } from "@closedloop-ai/loops-api/insights";
import {
  InsightsScope,
  type UtilizationInsightsResponse,
} from "@repo/api/src/types/insights";
import {
  bucketSessionVolume,
  type SessionVolumeBucket,
} from "@repo/api/src/types/onboarding-analytics";

/**
 * What the overview dashboard's already-loaded utilization payload says about
 * session volumes, published for the PRD-736 dashboard `page_viewed`
 * properties (ISS-10501) — derived client-side, no extra query.
 */
export type DashboardSessionVolumeReport = {
  /**
   * The org-wide sessions KPI total for the selected range, or `null` when
   * absent — including when the payload was loaded at a non-org scope, whose
   * KPI counts a different population than this org-named field.
   */
  orgSessionCount: number | null;
  /**
   * Per-user counts from `charts.userBreakdown` (org scope only), or `null`
   * when the payload carries none (me scope, older peer, failed read). The
   * producer caps the breakdown at {@link INSIGHTS_USER_BREAKDOWN_ROW_CAP}
   * rows, so absence from the list never reads as a zero.
   */
  userSessionCounts: readonly { count: number; userId: string }[] | null;
};

const SESSIONS_KPI_KEY = "sessions";

/** Fold the settled utilization payload into the volume report. */
export function deriveDashboardSessionVolumeReport(
  utilization: UtilizationInsightsResponse | undefined,
  scope: InsightsScope
): DashboardSessionVolumeReport {
  if (!utilization || scope !== InsightsScope.Org) {
    return { orgSessionCount: null, userSessionCounts: null };
  }
  const sessionsKpi = utilization.kpis.find(
    (kpi) => kpi.key === SESSIONS_KPI_KEY
  );
  return {
    orgSessionCount: sessionsKpi?.value ?? null,
    userSessionCounts:
      utilization.charts.userBreakdown?.map((bucket) => ({
        count: bucket.value,
        userId: bucket.key,
      })) ?? null,
  };
}

/**
 * The dashboard `page_viewed` volume buckets (frozen edges, PRD-736). Each is
 * `null` — and the property omitted — when its operand is genuinely absent.
 *
 * `"0"` is the activation boundary, so it is only ever emitted off an
 * ESTABLISHED all-time zero (`orgAllTimeZeroEstablished`, the dashboard's own
 * never-synced read). The loaded counts are range-scoped: a windowed zero
 * cannot tell "never analyzed" from "older than the window", so it folds to
 * `null` rather than crossing the boundary; a windowed non-zero is a real
 * lower bound and buckets normally.
 */
export function deriveDashboardSessionVolumeBuckets(input: {
  orgAllTimeZeroEstablished: boolean;
  report: DashboardSessionVolumeReport;
  viewerUserId: string | null;
}): {
  orgAnalyzedSessionsVolume: SessionVolumeBucket | null;
  ownAnalyzedSessionsVolume: SessionVolumeBucket | null;
} {
  const { orgAllTimeZeroEstablished, report, viewerUserId } = input;
  // An org with no sessions EVER has a measured zero for the org and for every
  // member, whatever the windowed payload carried.
  if (orgAllTimeZeroEstablished) {
    return {
      orgAnalyzedSessionsVolume: bucketSessionVolume(0),
      ownAnalyzedSessionsVolume: bucketSessionVolume(0),
    };
  }
  const orgAnalyzedSessionsVolume =
    report.orgSessionCount === null || report.orgSessionCount === 0
      ? null
      : bucketSessionVolume(report.orgSessionCount);

  if (viewerUserId === null || report.userSessionCounts === null) {
    return { orgAnalyzedSessionsVolume, ownAnalyzedSessionsVolume: null };
  }
  const viewerRow = report.userSessionCounts.find(
    (row) => row.userId === viewerUserId
  );
  // Absent from the breakdown, or present at zero, is only a windowed zero —
  // unknown all-time, never "0".
  if (!viewerRow || viewerRow.count === 0) {
    return { orgAnalyzedSessionsVolume, ownAnalyzedSessionsVolume: null };
  }
  return {
    orgAnalyzedSessionsVolume,
    ownAnalyzedSessionsVolume: bucketSessionVolume(viewerRow.count),
  };
}
