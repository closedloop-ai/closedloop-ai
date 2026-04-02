import type { DeploymentStatusEvent } from "@octokit/webhooks-types";
import { EntityType, LinkType } from "@repo/api/src/types/entity-link";
import {
  type DeploymentMetadata,
  ExternalLinkType,
} from "@repo/api/src/types/external-link";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { entityLinksService } from "@/app/entity-links/service";
import { externalLinksService } from "@/app/external-links/service";

/**
 * Handle GitHub deployment_status webhook events.
 *
 * When Vercel (or another deployment provider) completes a preview deployment,
 * GitHub sends a deployment_status event with `environment_url` containing the
 * actual preview URL. This handler updates the matching PREVIEW_DEPLOYMENT
 * ExternalLink record so the URL appears in the Symphony UI.
 *
 * Flow:
 * 1. Filter to "success" deployments with a non-empty environment_url
 * 2. Look up the GitHub repository
 * 3. Find the open PR matching the deployment's ref (branch)
 * 4. Create the deployment record
 */
export async function handleDeploymentStatus(
  event: DeploymentStatusEvent
): Promise<Response> {
  const { deployment, deployment_status: status } = event;
  const environmentUrl = status.environment_url;
  const ref = deployment.ref;
  const sha = deployment.sha;
  const state = status.state;

  log.info("[handleDeploymentStatus] Processing deployment_status event", {
    state,
    environment: deployment.environment,
    ref,
    sha,
    environmentUrl: environmentUrl || "(empty)",
    repositoryFullName: event.repository.full_name,
  });

  // Only process successful deployments with a URL
  if (state !== "success" || !environmentUrl) {
    log.info(
      "[handleDeploymentStatus] Skipping non-success or empty-URL deployment",
      { state, environmentUrl: environmentUrl || "(empty)" }
    );
    return NextResponse.json({
      message: `Ignoring deployment_status: state=${state}`,
      ok: true,
    });
  }

  // Look up repository and matching open PR
  const { pr, repo, prExternalLink } = await withDb(async (db) => {
    const foundRepo = await db.gitHubInstallationRepository.findFirst({
      where: { githubRepoId: String(event.repository.id) },
      select: { id: true },
    });

    if (!foundRepo) {
      return { repo: null, pr: null, prExternalLink: null };
    }

    // Match PR by headSha or headBranch
    const foundPr = await db.gitHubPullRequest.findFirst({
      where: {
        repositoryId: foundRepo.id,
        OR: [{ headSha: sha }, { headBranch: ref }],
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        workstreamId: true,
        headBranch: true,
        organizationId: true,
        workstream: { select: { projectId: true } },
        htmlUrl: true,
      },
    });

    if (!foundPr) {
      return { repo: foundRepo, pr: null, prExternalLink: null };
    }

    const prExternalLink = await db.externalLink.findFirst({
      where: {
        organizationId: foundPr.organizationId,
        workstreamId: foundPr.workstreamId,
        type: ExternalLinkType.PullRequest,
        externalUrl: foundPr.htmlUrl,
      },
      select: { id: true },
    });

    return { repo: foundRepo, pr: foundPr, prExternalLink };
  });

  if (!repo) {
    log.info(
      "[handleDeploymentStatus] Repository not registered in ClosedLoop",
      {
        githubRepoId: event.repository.id,
      }
    );
    return NextResponse.json({
      message: "Repository not tracked",
      ok: true,
    });
  }

  if (!pr?.workstreamId) {
    log.info("[handleDeploymentStatus] No PR found for deployment ref", {
      ref,
      sha,
    });
    return NextResponse.json({
      message: "No matching PR for this deployment",
      ok: true,
    });
  }

  const branchRef = pr.headBranch ?? ref;
  const title = `${branchRef} deployed to ${deployment.environment}`;
  const metadata: DeploymentMetadata = {
    statusUrl: status.url,
    deploymentUrl: status.deployment_url,
    state,
    environment: deployment.environment,
    ref: branchRef,
    sha,
    transient: deployment.transient_environment,
    production: deployment.production_environment,
  };

  const created = await externalLinksService.create(pr.organizationId, {
    workstreamId: pr.workstreamId,
    projectId: pr.workstream.projectId,
    type: ExternalLinkType.PreviewDeployment,
    title,
    externalUrl: environmentUrl,
    metadata,
  });

  // Link the deployment to the PR external link record.
  if (prExternalLink) {
    await entityLinksService.createLink(pr.organizationId, {
      sourceId: prExternalLink.id,
      sourceType: EntityType.ExternalLink,
      targetId: created.id,
      targetType: EntityType.ExternalLink,
      linkType: LinkType.Produces,
    });
  }

  log.info("[handleDeploymentStatus] Created preview deployment record", {
    externalLinkId: created.id,
    environmentUrl,
    title,
  });

  return NextResponse.json({
    message: "Deployment status processed",
    ok: true,
  });
}
