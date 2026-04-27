import type { DeploymentStatusEvent } from "@octokit/webhooks-types";
import { LinkType } from "@repo/api/src/types/artifact";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { deploymentService } from "@/lib/services/deployment-service";

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

    // Match PR detail by headSha or headBranch
    const foundPrDetail = await db.pullRequestDetail.findFirst({
      where: {
        repositoryId: foundRepo.id,
        OR: [{ headSha: sha }, { headBranch: ref }],
      },
      orderBy: { artifact: { createdAt: "desc" } },
      select: {
        artifactId: true,
        headBranch: true,
        artifact: {
          select: {
            organizationId: true,
            workstreamId: true,
            externalUrl: true,
            workstream: { select: { projectId: true } },
          },
        },
      },
    });

    if (!foundPrDetail) {
      return { repo: foundRepo, pr: null, prExternalLink: null };
    }

    // The PR artifact's id is the "external link" id for linkage graphs —
    // the legacy ExternalLink.id and the new Artifact.id are the same value
    // (IDs were reused during the migration).
    const foundPr = {
      id: foundPrDetail.artifactId,
      workstreamId: foundPrDetail.artifact.workstreamId,
      headBranch: foundPrDetail.headBranch,
      organizationId: foundPrDetail.artifact.organizationId,
      workstream: foundPrDetail.artifact.workstream,
      htmlUrl: foundPrDetail.artifact.externalUrl ?? "",
    };

    return {
      repo: foundRepo,
      pr: foundPr,
      prExternalLink: { id: foundPrDetail.artifactId },
    };
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

  if (!(pr?.workstreamId && pr.workstream)) {
    log.info("[handleDeploymentStatus] No PR found for deployment ref", {
      ref,
      sha,
    });
    return NextResponse.json({
      message: "No matching PR for this deployment",
      ok: true,
    });
  }

  const resolvedWorkstream = pr.workstream;
  const branchRef = pr.headBranch ?? ref;
  const title = `${branchRef} deployed to ${deployment.environment}`;

  const created = await withDb.tx(async (tx) => {
    const deploymentArtifact = await deploymentService.recordDeployment(
      {
        organizationId: pr.organizationId,
        projectId: resolvedWorkstream.projectId,
        workstreamId: pr.workstreamId,
        environment: deployment.environment,
        ref: branchRef,
        sha,
        state,
        externalUrl: environmentUrl,
        githubStatusUrl: status.url,
        githubDeploymentUrl: status.deployment_url,
        transient: deployment.transient_environment,
        production: deployment.production_environment,
        pullRequestArtifactId: prExternalLink?.id ?? null,
        title,
      },
      tx
    );

    // Link the deployment artifact to the PR artifact. ArtifactLink is a
    // pure (sourceId, targetId, linkType) tuple — the polymorphic
    // sourceType/targetType fields were dropped in the cutover.
    if (prExternalLink) {
      const existingLink = await tx.artifactLink.findFirst({
        where: {
          organizationId: pr.organizationId,
          sourceId: prExternalLink.id,
          targetId: deploymentArtifact.id,
          linkType: LinkType.Produces,
        },
        select: { id: true },
      });
      if (!existingLink) {
        await tx.artifactLink.create({
          data: {
            organizationId: pr.organizationId,
            sourceId: prExternalLink.id,
            targetId: deploymentArtifact.id,
            linkType: LinkType.Produces,
          },
        });
      }
    }

    return deploymentArtifact;
  });

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
