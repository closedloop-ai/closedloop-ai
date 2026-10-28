import { branchService } from "@/app/branches/branch-service";
import { runWithAttributionEvidenceGate } from "@/lib/attribution-evidence-gate-scope";
import { readAttributionEvidenceForRequest } from "@/lib/attribution-evidence-policy-feature";

/**
 * ISS-12552 (PRD-800 "Rollout"): a branch write whose source link may
 * derive implementation evidence. The organization's attribution answer is
 * read here, before the write's transaction opens, and the source link
 * branches on it inside (`writeBranchSourceLink`). Only for a caller that is
 * not already inside a transaction; the pull_request webhook, which is, reads
 * the answer before its own transaction (`readPullRequestAttributionEvidence`).
 */
export function upsertBranchArtifactWithAttribution(
  ...args: Parameters<typeof branchService.upsertBranchArtifact>
): ReturnType<typeof branchService.upsertBranchArtifact> {
  return runWithAttributionEvidenceGate(async () => {
    await readAttributionEvidenceForRequest(args[0].organizationId);
    return await branchService.upsertBranchArtifact(...args);
  });
}
