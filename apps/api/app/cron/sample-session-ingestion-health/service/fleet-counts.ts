import { withDb } from "@repo/database";
import {
  emitSessionFleetTotalOrgs,
  emitSessionFleetTotalSessions,
} from "@/lib/observability/fleet-metrics";
import { ACTIVE_ORGANIZATION_WHERE } from "./active-organization-where";

export type SessionFleetCounts = {
  totalSessionCount: number;
  totalOrgCount: number;
};

/**
 * ISS-12050: count the sessions and organizations of every active org, then
 * emit both gauges.
 *
 * A session is a `session_detail` row — the population the Sessions list pages
 * over (`buildWhere` in app/agent-sessions/service/query-builder.ts) with no
 * facet applied — summed over active orgs. Organizations are counted when
 * active, including ones with zero sessions: the denominator covers every org
 * (operator ruling, ISS-12050), and deactivated orgs are excluded from both
 * figures (Marisol Ashgrove, 2026-10-05: "don't include de-activated", then
 * "exclude deactivated orgs" for the session total too).
 *
 * Both counts are awaited before either gauge is emitted, so a failed count
 * rejects with neither gauge sent — never a `0` the dashboard would read as a
 * real total, nor a total paired with a stale denominator. The route alerts on
 * the rejection (`sampleFleetCountsOrAlert`).
 */
export async function sampleSessionFleetCounts(): Promise<SessionFleetCounts> {
  const [totalSessionCount, totalOrgCount] = await withDb((db) =>
    Promise.all([
      db.sessionDetail.count({
        where: {
          artifact: { is: { organization: { is: ACTIVE_ORGANIZATION_WHERE } } },
        },
      }),
      db.organization.count({ where: ACTIVE_ORGANIZATION_WHERE }),
    ])
  );

  emitSessionFleetTotalSessions(totalSessionCount);
  emitSessionFleetTotalOrgs(totalOrgCount);

  return { totalSessionCount, totalOrgCount };
}
