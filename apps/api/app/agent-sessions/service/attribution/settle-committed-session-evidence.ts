/**
 * ISS-12552: the ingest's post-commit evidence phase. After a sync batch's
 * slices commit, and outside every slice transaction: while the attribution
 * flag is on for the organization, the late bind runs again for the synced
 * sessions' claims that still wait on a receipt, then every session
 * whose evidence changed has its evidence links synced (session-evidence-
 * links.ts reads the flag for the links itself): the synced sessions, the
 * sessions the sync's binding changed (a canonical copy or fork parent that
 * took a receipt, a displaced holder), which may never sync again, and the
 * sessions the late bind changed.
 *
 * Never throws: a session whose late bind fails keeps its waiting claim, which
 * its next sync reconciles again.
 */
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { isAttributionEvidenceEnabledForOrganization } from "@/lib/attribution-evidence-policy-feature";
import { bindWaitingClaimsOfSessions } from "@/lib/operation-receipts/bind-awaiting-claim";
import { syncSessionEvidenceLinks } from "./session-evidence-links";

export async function settleCommittedSessionEvidence(
  organizationId: string,
  syncedSessionIds: readonly string[],
  bindingChangedSessionIds: readonly string[] = []
): Promise<void> {
  const bound = await rebindWaitingClaims(organizationId, syncedSessionIds);
  await syncSessionEvidenceLinks(organizationId, [
    ...syncedSessionIds,
    ...bindingChangedSessionIds,
    ...bound,
  ]);
}

async function rebindWaitingClaims(
  organizationId: string,
  sessionIds: readonly string[]
): Promise<string[]> {
  if (sessionIds.length === 0) {
    return [];
  }
  try {
    if (!(await isAttributionEvidenceEnabledForOrganization(organizationId))) {
      return [];
    }
    return await bindWaitingClaimsOfSessions(organizationId, sessionIds);
  } catch (error) {
    log.warn("late receipt bind after sync failed; next sync retries", {
      level: "warn",
      status: "warn",
      organizationId,
      sessionCount: sessionIds.length,
      error: parseError(error),
    });
    return [];
  }
}
