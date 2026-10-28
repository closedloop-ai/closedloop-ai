import { withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { emitBranchDetailsChanged } from "@/app/branches/branch-detail-signal";
import { isAttributionEvidenceEnabledForOrganization } from "@/lib/attribution-evidence-policy-feature";
import { readSessionBranchIds } from "../session-branch-detail-signal";
import { deriveImplementationEvidence } from "./derive-implementation-evidence";

/** Logged when a committed session's implementation derivation fails. */
export const IMPLEMENTATION_EVIDENCE_DERIVE_FAILED_EVENT =
  "implementation_evidence_derive_failed" as const;

/**
 * ISS-12552 (PRD-800 "Rollout"): derive each committed sync slice's
 * implementation evidence, only while the attribution flag is on for the
 * organization. Runs after the slices commit, so the flag is never read inside
 * a slice transaction; each session derives in its own short transaction.
 *
 * The slice already signalled its branches when it committed, before these
 * rows existed, so the derivation signals them again from its own
 * transaction; the signal is delivered once the rows commit.
 *
 * Never throws. A session whose derivation fails keeps its previous rows until
 * its next sync that names a branch, or the backfill, derives it again.
 */
export async function deriveCommittedImplementationEvidence(
  organizationId: string,
  sessionIds: readonly string[]
): Promise<void> {
  if (sessionIds.length === 0) {
    return;
  }
  if (!(await isAttributionEvidenceEnabledForOrganization(organizationId))) {
    return;
  }
  for (const sessionId of new Set(sessionIds)) {
    let branchIds: string[] = [];
    try {
      branchIds = await withDb((db) =>
        readSessionBranchIds(db, organizationId, sessionId)
      );
      await withDb.tx(async (tx) => {
        await deriveImplementationEvidence(tx, {
          organizationId,
          sessionIds: [sessionId],
        });
        await emitBranchDetailsChanged(tx, organizationId, branchIds);
      });
    } catch (error) {
      log.warn(IMPLEMENTATION_EVIDENCE_DERIVE_FAILED_EVENT, {
        level: "warn",
        status: "warn",
        organizationId,
        agentSessionId: sessionId,
        branchIds,
        error: parseError(error),
      });
    }
  }
}
