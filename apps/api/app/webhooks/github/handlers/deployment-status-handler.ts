import type { DeploymentStatusEvent } from "@octokit/webhooks-types";
import { LinkType } from "@repo/api/src/types/artifact";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { deploymentService } from "@/app/deployments/deployment-service";

/**
 * Handle GitHub deployment_status webhook events.
 *
 * When Vercel (or another deployment provider) completes a preview deployment,
 * GitHub sends a deployment_status event with `environment_url` containing the
 * actual preview URL. This handler updates the matching PREVIEW_DEPLOYMENT
 * ExternalLink record so the URL appears in the Closedloop UI.
 *
 * Flow:
 * 1. Filter to "success" deployments with a non-empty environment_url
 * 2. Look up the GitHub repository
 * 3. Find an existing non-default branch artifact matching the deployment ref
 * 4. Create the deployment record linked to that branch
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

  const { branch, repo } = await withDb(async (db) => {
    const foundRepo = await db.gitHubInstallationRepository.findFirst({
      where: {
        githubRepoId: String(event.repository.id),
        fullName: event.repository.full_name,
        removedAt: null,
        installation: {
          status: GitHubInstallationStatus.ACTIVE,
        },
      },
      select: { id: true },
    });

    if (!foundRepo) {
      return { repo: null, branch: null };
    }

    const foundBranchDetail = await db.branchDetail.findFirst({
      where: {
        repositoryId: foundRepo.id,
        branchName: ref,
        ...(sha ? { OR: [{ headSha: sha }, { headSha: null }] } : {}),
      },
      select: {
        artifactId: true,
        branchName: true,
        artifact: {
          select: {
            organizationId: true,
            projectId: true,
          },
        },
      },
    });

    if (!foundBranchDetail) {
      return { repo: foundRepo, branch: null };
    }

    const foundBranch = {
      id: foundBranchDetail.artifactId,
      branchName: foundBranchDetail.branchName,
      organizationId: foundBranchDetail.artifact.organizationId,
      projectId: foundBranchDetail.artifact.projectId,
    };

    return { repo: foundRepo, branch: foundBranch };
  });

  if (!repo) {
    log.info(
      "[handleDeploymentStatus] Repository not registered in Closedloop",
      {
        githubRepoId: event.repository.id,
      }
    );
    return NextResponse.json({
      message: "Repository not tracked",
      ok: true,
    });
  }

  if (!branch) {
    log.info(
      "[handleDeploymentStatus] No branch artifact found for deployment ref",
      {
        ref,
        sha,
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
      });
    }

    return deploymentArtifact;
  });

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
