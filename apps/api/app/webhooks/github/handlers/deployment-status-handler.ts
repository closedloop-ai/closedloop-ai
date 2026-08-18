import type { DeploymentStatusEvent } from "@octokit/webhooks-types";
import { LinkType } from "@repo/api/src/types/artifact";
import { withDb } from "@repo/database";
import { parseDeploymentStatusEvent } from "@repo/github/deployment-status-parser";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { deploymentEventService } from "@/app/deployments/deployment-event-service";
import {
  deploymentService,
  recordDeploymentTxOptions,
} from "@/app/deployments/deployment-service";
import type { GitHubWebhookObservationContext } from "@/lib/github/github-webhook-observation";
import {
  GitHubBranchActivityEventName,
  persistGitHubBranchActivity,
} from "./branch-activity-producer";
import { activeInstallationRepositoryWhere } from "./installation-repository-scope";

/**
 * Handle GitHub deployment_status webhook events.
 *
 * Two independent outputs, in this order:
 *
 * 1. **Append-only history (every transition, ISS-4975).** Each status
 *    transition — success, failure, error, or a state GitHub adds later — is
 *    recorded as an immutable `DeploymentEvent` row so the four DORA metrics have
 *    a source. This happens for repo-level deploys with no branch artifact too,
 *    which is where production deploys land.
 * 2. **Current state (successful preview deploys only).** When Vercel (or another
 *    provider) completes a deployment with a non-empty `environment_url`, the
 *    matching branch artifact gets a DEPLOYMENT artifact upserted on that URL so
 *    the preview link appears in the Closedloop UI. Unchanged by ISS-4975.
 *
 * Flow:
 * 1. Look up the GitHub repository (and its organization) inside THIS delivery's
 *    installation tenant
 * 2. Find an existing branch artifact matching the deployment ref
 * 3. Append the history event, attributed to that ref regardless of head SHA
 * 4. For "success" deployments with a URL whose branch still points at this SHA,
 *    create/refresh the deployment record linked to that branch
 */
export async function handleDeploymentStatus(
  event: DeploymentStatusEvent,
  observationContext?: GitHubWebhookObservationContext
): Promise<Response> {
  const { deployment, deployment_status: status } = event;
  const environmentUrl = status.environment_url;
  const ref = deployment.ref;
  const sha = deployment.sha;
  const state = status.state;
  const deliveryInstallationId = event.installation?.id;

  log.debug("[handleDeploymentStatus] Processing deployment_status event", {
    state,
    environment: deployment.environment,
    ref,
    sha,
    environmentUrl: environmentUrl || "(empty)",
    repositoryFullName: event.repository.full_name,
    installationId: deliveryInstallationId,
  });

  const { branch, repo } = await withDb(async (db) => {
    const foundRepo = await db.gitHubInstallationRepository.findFirst({
      // `GitHubInstallationRepository` is unique only by
      // (installationId, githubRepoId), so the same repo can carry one row per
      // installation — and each installation resolves to its own organization.
      // Scoping on the delivery's installation id is what keeps a history row
      // out of the wrong tenant; without it `findFirst` picks an arbitrary row.
      where: activeInstallationRepositoryWhere({
        githubRepoId: String(event.repository.id),
        fullName: event.repository.full_name,
        installationId:
          deliveryInstallationId === undefined
            ? undefined
            : String(deliveryInstallationId),
      }),
      // ISS-4975: the installation's organization is the only org context a
      // repo-level deploy has — a production deploy of the default branch has no
      // branch artifact to inherit one from.
      select: { id: true, installation: { select: { organizationId: true } } },
    });

    if (!foundRepo) {
      return { repo: null, branch: null };
    }

    // ISS-4975: resolved by ref ALONE, deliberately without the head-SHA guard.
    // A status that arrives after a push advanced `headSha` still describes this
    // ref, and the history row is immutable — dropping the attribution here
    // would strand that row without a project or branch forever. The SHA guard
    // stays on the mutable current-state path below, where a stale preview URL
    // genuinely must not overwrite the branch's current deployment.
    const foundBranchDetails = await db.branchDetail.findMany({
      where: {
        repositoryId: foundRepo.id,
        branchName: ref,
      },
      select: {
        artifactId: true,
        branchName: true,
        headSha: true,
        artifact: {
          select: {
            organizationId: true,
            projectId: true,
          },
        },
      },
      orderBy: [{ createdAt: "asc" }, { artifactId: "asc" }],
      take: 2,
    });
    const foundBranchDetail =
      foundBranchDetails.length === 1 ? foundBranchDetails[0] : null;

    if (!foundBranchDetail) {
      return { repo: foundRepo, branch: null };
    }

    const foundBranch = {
      id: foundBranchDetail.artifactId,
      branchName: foundBranchDetail.branchName,
      headSha: foundBranchDetail.headSha,
      organizationId: foundBranchDetail.artifact.organizationId,
      projectId: foundBranchDetail.artifact.projectId,
    };

    return { repo: foundRepo, branch: foundBranch };
  });

  if (!repo) {
    log.debug(
      "[handleDeploymentStatus] Repository not registered in Closedloop",
      {
        githubRepoId: event.repository.id,
        installationId: deliveryInstallationId,
      }
    );
    return NextResponse.json({
      message: "Repository not tracked",
      ok: true,
    });
  }

  await recordDeploymentEventHistory({
    event,
    // Without the delivery's installation id the repo row above was not tenant
    // scoped, so its organization is a guess. An immutable row under the wrong
    // tenant is worse than a missing one — skip history rather than guess.
    organizationId: deliveryInstallationId
      ? (branch?.organizationId ?? repo.installation.organizationId)
      : null,
    repositoryId: repo.id,
    branch,
  });
  await persistGitHubBranchActivity({
    eventName: GitHubBranchActivityEventName.DeploymentStatus,
    deliveryId: observationContext?.deliveryId,
    payload: event,
    attribution:
      deliveryInstallationId !== undefined &&
      branch &&
      repo.installation.organizationId === branch.organizationId
        ? {
            organizationId: branch.organizationId,
            branchArtifactId: branch.id,
          }
        : undefined,
  });

  // Current state below covers only successful deploys that carry a preview URL.
  // The history above already recorded this transition either way.
  if (state !== "success" || !environmentUrl) {
    log.debug(
      "[handleDeploymentStatus] Skipping non-success or empty-URL deployment",
      { state, environmentUrl: environmentUrl || "(empty)" }
    );
    return NextResponse.json({
      message: `Ignoring deployment_status: state=${state}`,
      ok: true,
    });
  }

  // ISS-4975: the head-SHA guard the branch query used to carry, applied here
  // instead so it constrains ONLY the mutable current-state write. A branch whose
  // head has since moved on must not have its current deployment overwritten by a
  // late status for the superseded SHA — but the history row above still got the
  // ref attribution, which is the part that can never be repaired later.
  const branchHeadMatchesDeployment =
    branch !== null &&
    (!sha || branch.headSha === null || branch.headSha === sha);

  if (!(branch && branchHeadMatchesDeployment)) {
    log.debug(
      "[handleDeploymentStatus] No branch artifact found for deployment ref",
      {
        ref,
        sha,
        branchHeadSha: branch?.headSha ?? null,
        production: deployment.production_environment,
      }
    );
    return NextResponse.json({
      message: "No matching branch for this deployment",
      ok: true,
    });
  }

  const projectId = branch.projectId;
  const branchRef = branch.branchName;
  const title = `${branchRef} deployed to ${deployment.environment}`;

  // FEA-3466: `recordDeployment` joins this ambient transaction, so the advisory
  // lock it takes (and its transaction timeout) live on THIS tx — the inner
  // `withDb.tx` options are ignored once nested. Carry the same timeout here so a
  // lock wait on a redelivered webhook cannot trip Prisma's 5s default.
  const created = await withDb.tx(async (tx) => {
    const recorded = await deploymentService.recordDeployment({
      organizationId: branch.organizationId,
      projectId,
      environment: deployment.environment,
      ref: branchRef,
      sha,
      state,
      externalUrl: environmentUrl,
      githubStatusUrl: status.url,
      githubDeploymentUrl: status.deployment_url,
      transient: deployment.transient_environment,
      production: deployment.production_environment,
      branchArtifactId: branch.id,
      title,
    });
    if (!recorded.ok) {
      return null;
    }
    const deploymentArtifact = recorded.value;

    // Link the deployment artifact to the branch artifact. ArtifactLink is a
    // pure (sourceId, targetId, linkType) tuple — the polymorphic
    // sourceType/targetType fields were dropped in the cutover.
    const existingLink = await tx.artifactLink.findFirst({
      where: {
        organizationId: branch.organizationId,
        sourceId: branch.id,
        targetId: deploymentArtifact.id,
        linkType: LinkType.Produces,
      },
      select: { id: true },
    });
    if (!existingLink) {
      await tx.artifactLink.create({
        data: {
          organizationId: branch.organizationId,
          sourceId: branch.id,
          targetId: deploymentArtifact.id,
          linkType: LinkType.Produces,
        },
        select: { id: true },
      });
    }

    return deploymentArtifact;
  }, recordDeploymentTxOptions);

  if (!created) {
    // Only reachable when the branch artifact is unparented, which the
    // branch-service guard and the artifacts project CHECK constraint
    // prevent. Skip with a 2xx so GitHub does not surface a delivery failure.
    log.warn(
      "[handleDeploymentStatus] Skipped deployment record for unparented branch",
      { ref, sha, branchArtifactId: branch.id }
    );
    return NextResponse.json({
      message: "Deployment skipped: branch artifact has no project",
      ok: true,
    });
  }

  log.debug("[handleDeploymentStatus] Created preview deployment record", {
    externalLinkId: created.id,
    environmentUrl,
    title,
  });

  return NextResponse.json({
    message: "Deployment status processed",
    ok: true,
  });
}

type ResolvedBranch = {
  id: string;
  branchName: string;
  /**
   * The branch's CURRENT head, which may already have moved past the SHA this
   * status describes. Only the mutable current-state write consults it.
   */
  headSha: string | null;
  organizationId: string;
  projectId: string | null;
};

/**
 * ISS-4975: append this status transition to the deployment-event history.
 *
 * Runs for EVERY transition — failures included — and before (and independently
 * of) the current-state write below, which only covers successful deploys with a
 * preview URL. Without this, change-failure rate and MTTR have no data source and
 * deployment frequency undercounts, because `recordDeployment` overwrites the
 * current-state row on re-deploy instead of appending.
 *
 * Never throws: history is additive, so a failed history write must not turn a
 * webhook that would otherwise update current state into a 500 and a GitHub
 * redelivery. Failures are logged with the identity needed to reconcile them.
 */
async function recordDeploymentEventHistory(params: {
  event: DeploymentStatusEvent;
  organizationId: string | null;
  repositoryId: string;
  branch: ResolvedBranch | null;
}): Promise<void> {
  const { event, organizationId, repositoryId, branch } = params;
  // A null parse means the payload carries no non-nullable dedupe identity or no
  // provider occurrence time; the parser has already logged which half was
  // missing.
  const parsed = parseDeploymentStatusEvent(event);
  if (!parsed) {
    return;
  }
  if (!organizationId) {
    log.warn(
      "[handleDeploymentStatus] Skipping deployment history: no tenant-scoped organization for this delivery",
      {
        repositoryFullName: event.repository.full_name,
        installationId: event.installation?.id,
      }
    );
    return;
  }

  try {
    const result = await deploymentEventService.recordEvent({
      organizationId,
      projectId: branch?.projectId ?? null,
      repositoryId,
      branchArtifactId: branch?.id ?? null,
      source: parsed.source,
      externalDeploymentId: parsed.externalDeploymentId,
      externalEventId: parsed.externalEventId,
      state: parsed.state,
      providerState: parsed.providerState,
      environment: parsed.environment,
      ref: parsed.ref,
      sha: parsed.sha,
      environmentUrl: parsed.environmentUrl,
      githubStatusUrl: parsed.githubStatusUrl,
      githubDeploymentUrl: parsed.githubDeploymentUrl,
      production: parsed.production,
      transient: parsed.transient,
      occurredAt: parsed.occurredAt,
      deploymentCreatedAt: parsed.deploymentCreatedAt,
    });
    if (result.ok) {
      log.debug("[handleDeploymentStatus] Deployment history event processed", {
        externalDeploymentId: parsed.externalDeploymentId,
        externalEventId: parsed.externalEventId,
        state: parsed.state,
        duplicate: !result.value.recorded,
      });
    }
  } catch (error) {
    log.error("[handleDeploymentStatus] Failed to record deployment history", {
      error: error instanceof Error ? error.message : String(error),
      externalDeploymentId: parsed.externalDeploymentId,
      externalEventId: parsed.externalEventId,
    });
  }
}
