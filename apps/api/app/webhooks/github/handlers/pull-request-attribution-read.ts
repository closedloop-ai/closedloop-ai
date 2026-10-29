import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY,
  ATTRIBUTION_EVIDENCE_POLICY_FLAG_UNAVAILABLE_LOG_KEY,
  readAttributionEvidenceForRequest,
} from "@/lib/attribution-evidence-policy-feature";
import { activeInstallationRepositoryWhere } from "./installation-repository-scope";

/**
 * ISS-12552 (PRD-800 "Rollout"): read the repository's organization's
 * attribution answer before the pull_request transaction opens. A linkage
 * action can write an issue-to-branch source link inside that transaction,
 * and the link derives implementation evidence only from an answer its
 * request already holds (`writeBranchSourceLink`). Call it inside
 * `runWithAttributionEvidenceGate`. A repository with no organization reads
 * nothing, so its link derives nothing. A failed read leaves the answer
 * unread, which the link reads as off, so the delivery runs main's path.
 */
export async function readPullRequestAttributionEvidence(
  repository: { id: number; full_name: string },
  installationId: number
): Promise<void> {
  try {
    await readRepositoryOrganizationAnswer(repository, installationId);
  } catch (error) {
    log.warn(ATTRIBUTION_EVIDENCE_POLICY_FLAG_UNAVAILABLE_LOG_KEY, {
      level: "warn",
      status: "warn",
      featureFlagKey: ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY,
      reason: PULL_REQUEST_ATTRIBUTION_READ_FAILED,
      repositoryFullName: repository.full_name,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The log reason for a pull_request delivery whose pre-read failed. */
export const PULL_REQUEST_ATTRIBUTION_READ_FAILED =
  "pull_request_attribution_read_failed" as const;

async function readRepositoryOrganizationAnswer(
  repository: { id: number; full_name: string },
  installationId: number
): Promise<void> {
  const repo = await withDb((db) =>
    db.gitHubInstallationRepository.findFirst({
      where: activeInstallationRepositoryWhere({
        githubRepoId: String(repository.id),
        fullName: repository.full_name,
        installationId: String(installationId),
      }),
      select: { installation: { select: { organizationId: true } } },
    })
  );
  const organizationId = repo?.installation.organizationId;
  if (organizationId) {
    await readAttributionEvidenceForRequest(organizationId);
  }
}
