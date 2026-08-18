import {
  emptyPullRequestLabelSyncResult,
  type PullRequestLabelSyncResult,
  PullRequestLabelSyncStatus,
} from "@repo/api/src/types/pull-request-label-sync-status";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  PULL_REQUEST_LABEL_SOURCE_SELECT,
  resolvePullRequestLabelSource,
} from "@/lib/github/pull-request-label-source";
import { syncPullRequestLabelsFromArtifactTags } from "@/lib/github/pull-request-label-sync";
import { activeInstallationRepositoryWhere } from "./installation-repository-scope";

/**
 * ISS-4664: reconcile a pull request's GitHub labels against the tags of the
 * document (ISS/FEATURE/plan) it implements.
 *
 * Runs AFTER the `pull_request` transaction commits, on purpose:
 *  - the produces-link the reconciliation reads is written inside that
 *    transaction, so a pre-commit read would miss a just-linked PR;
 *  - GitHub calls must never be issued inside an interactive transaction —
 *    they would hold a pooled connection for the duration of a network round
 *    trip and can blow the transaction timeout.
 *
 * Best effort throughout: a repository we cannot resolve, a PR with no linked
 * document, an untagged document, or a GitHub failure all resolve quietly. The
 * webhook still returns 200 — label propagation is never a reason to make
 * GitHub retry a delivery it already applied.
 */
export async function reconcilePullRequestLabelsForWebhook(input: {
  githubRepoId: string;
  repositoryFullName: string;
  installationId: string;
  pullNumber: number;
}): Promise<PullRequestLabelSyncResult> {
  // Everything below runs AFTER the pull_request transaction committed, so an
  // unguarded throw would escape to the route's catch, return 500, and make
  // GitHub retry a delivery whose authoritative work already succeeded. The
  // whole body is guarded — not just the DB reads — so this caller and the
  // link-creation caller in `pull-request-artifact-service.ts` hold the same
  // posture against the same failure mode.
  try {
    const context = await loadPullRequestLabelContext(input);
    if (!context) {
      return emptyPullRequestLabelSyncResult(PullRequestLabelSyncStatus.NoOp);
    }

    return await syncPullRequestLabelsFromArtifactTags({
      organizationId: context.organizationId,
      projectId: context.projectId,
      artifactId: context.documentArtifactId,
      installationId: input.installationId,
      owner: context.owner,
      repo: context.repo,
      pullNumber: input.pullNumber,
    });
  } catch (error) {
    log.warn("[reconcilePullRequestLabels] Label reconciliation failed", {
      repositoryFullName: input.repositoryFullName,
      pullNumber: input.pullNumber,
      error: error instanceof Error ? error.message : String(error),
    });
    return emptyPullRequestLabelSyncResult(PullRequestLabelSyncStatus.Failed);
  }
}

type PullRequestLabelContext = {
  organizationId: string;
  /**
   * ISS-4759: the PROJECT the linked branch/PR artifact belongs to. The tag
   * source has to live in it too — read from the target side of the link, so
   * the check is a real cross-check rather than the source validating itself.
   */
  projectId: string;
  owner: string;
  repo: string;
  documentArtifactId: string;
};

/**
 * Resolve the org, repository slug parts, and the DOCUMENT artifact that
 * produces this PR's branch. Returns `null` whenever any link in that chain is
 * missing — an unlinked PR simply has no tags to propagate.
 */
async function loadPullRequestLabelContext(input: {
  githubRepoId: string;
  repositoryFullName: string;
  installationId: string;
  pullNumber: number;
}): Promise<PullRequestLabelContext | null> {
  const repository = await withDb((db) =>
    db.gitHubInstallationRepository.findFirst({
      where: activeInstallationRepositoryWhere({
        githubRepoId: input.githubRepoId,
        fullName: input.repositoryFullName,
        installationId: input.installationId,
      }),
      select: {
        id: true,
        owner: true,
        name: true,
        installation: { select: { organizationId: true } },
      },
    })
  );
  const organizationId = repository?.installation.organizationId;
  if (!(repository && organizationId)) {
    return null;
  }

  const detail = await withDb((db) =>
    db.pullRequestDetail.findUnique({
      where: {
        repositoryId_number: {
          repositoryId: repository.id,
          number: input.pullNumber,
        },
      },
      select: {
        artifact: { select: PULL_REQUEST_LABEL_SOURCE_SELECT },
        branchArtifact: { select: PULL_REQUEST_LABEL_SOURCE_SELECT },
      },
    })
  );
  // ISS-4760: branch-owned linkage wins and the legacy PR-owned artifact is the
  // fallback, but WHICH document's tags become the labels is decided by the one
  // shared identity helper — not re-derived here. The post-tag-mutation
  // reconciliation reads the same helper, so an issue-with-plan flow can no
  // longer have one path label from the issue and the other from the plan.
  const source = detail ? resolvePullRequestLabelSource(detail) : null;
  if (!source) {
    log.debug("[reconcilePullRequestLabels] No linked document, skipping", {
      repositoryFullName: input.repositoryFullName,
      pullNumber: input.pullNumber,
    });
    return null;
  }

  return {
    organizationId,
    projectId: source.projectId,
    owner: repository.owner,
    repo: repository.name,
    documentArtifactId: source.artifactId,
  };
}
