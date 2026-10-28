import type { DeploymentStatusEvent } from "@octokit/webhooks-types";
import { LinkType } from "@repo/api/src/types/artifact";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { nextProducesLinkSortOrder } from "@/app/artifact-links/produces-link-sort-order";
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
 * When Vercel (or another provider) completes a deployment with a non-empty
 * `environment_url`, the matching branch artifact gets a DEPLOYMENT artifact
 * upserted on that URL so the preview link appears in the Closedloop UI.
 *
 * ISS-12780 (Perrin Upcott, 2026-10-21: "Stop writing, keep the table"): this
 * handler no longer appends to `deployment_events`; the table and its rows stay.
 *
 * Flow:
 * 1. Look up the GitHub repository (and its organization) inside THIS delivery's
 *    installation tenant
 * 2. Find an existing branch artifact matching the deployment ref
 * 3. Persist the delivery as branch activity, attributed to that branch only
 *    when its organization is the installation's
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
      // Scoping on the delivery's installation id keeps the branch match, and
      // every write that follows from it, in this delivery's tenant; without it
      // `findFirst` picks an arbitrary row.
      where: activeInstallationRepositoryWhere({
        githubRepoId: String(event.repository.id),
        fullName: event.repository.full_name,
        installationId:
          deliveryInstallationId === undefined
            ? undefined
            : String(deliveryInstallationId),
      }),
      // The installation's organization gates the branch-activity attribution
      // below.
      select: { id: true, installation: { select: { organizationId: true } } },
    });

    if (!foundRepo) {
      return { repo: null, branch: null };
    }

    // Resolved by ref alone, without the head-SHA guard (ISS-4975): the
    // branch-activity attribution below uses this match. The SHA guard stays on
    // the mutable current-state path below, where a stale preview URL must not
    // overwrite the branch's current deployment.
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
  // late status for the superseded SHA.
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

    // Link the deployment artifact to the branch artifact. The polymorphic
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
      const sortOrder = await nextProducesLinkSortOrder(
        tx,
        branch.organizationId,
        branch.id
      );
      await tx.artifactLink.create({
        data: {
          organizationId: branch.organizationId,
          sourceId: branch.id,
          targetId: deploymentArtifact.id,
          linkType: LinkType.Produces,
          sortOrder,
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
