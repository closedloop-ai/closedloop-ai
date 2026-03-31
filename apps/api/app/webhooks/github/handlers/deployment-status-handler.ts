import type { DeploymentStatusEvent } from "@octokit/webhooks-types";
import {
  ExternalLinkType,
  type PreviewDeploymentMetadata,
} from "@repo/api/src/types/external-link";
import { GitHubPRState, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";

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
 * 4. Find or update the PREVIEW_DEPLOYMENT ExternalLink for that workstream+branch
 */
export async function handleDeploymentStatus(
  event: DeploymentStatusEvent
): Promise<Response> {
  const { deployment, deployment_status: status } = event;
  const environmentUrl = status.environment_url || status.target_url || "";
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
  const { pr, repo } = await withDb(async (db) => {
    const foundRepo = await db.gitHubInstallationRepository.findFirst({
      where: { githubRepoId: String(event.repository.id) },
      select: { id: true },
    });

    if (!foundRepo) {
      return { repo: null, pr: null };
    }

    // Match PR by headSha or headBranch
    const foundPr = await db.gitHubPullRequest.findFirst({
      where: {
        state: GitHubPRState.OPEN,
        repositoryId: foundRepo.id,
        OR: [{ headSha: sha }, { headBranch: ref }],
      },
      select: {
        id: true,
        workstreamId: true,
        headBranch: true,
        organizationId: true,
        workstream: { select: { projectId: true } },
      },
    });

    return { repo: foundRepo, pr: foundPr };
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
    log.info("[handleDeploymentStatus] No open PR found for deployment ref", {
      ref,
      sha,
    });
    return NextResponse.json({
      message: "No matching open PR for this deployment",
      ok: true,
    });
  }

  // Find and update the PREVIEW_DEPLOYMENT ExternalLink
  const branchRef = pr.headBranch ?? ref;
  const previewTitle = `Preview: ${branchRef}`;

  await withDb(async (db) => {
    const existingLink = await db.externalLink.findFirst({
      where: {
        workstreamId: pr.workstreamId,
        type: ExternalLinkType.PreviewDeployment,
        title: previewTitle,
      },
      select: { id: true },
    });

    const metadata: PreviewDeploymentMetadata = {
      ref: branchRef,
      sha,
      environment: deployment.environment,
      state,
    };

    if (existingLink) {
      await db.externalLink.update({
        where: { id: existingLink.id },
        data: {
          externalUrl: environmentUrl,
          metadata,
        },
      });

      log.info("[handleDeploymentStatus] Updated preview deployment URL", {
        externalLinkId: existingLink.id,
        environmentUrl,
        previewTitle,
      });
    } else {
      const created = await db.externalLink.create({
        data: {
          organizationId: pr.organizationId,
          workstreamId: pr.workstreamId,
          projectId: pr.workstream.projectId,
          type: ExternalLinkType.PreviewDeployment,
          title: previewTitle,
          externalUrl: environmentUrl,
          metadata,
        },
      });

      log.info("[handleDeploymentStatus] Created preview deployment record", {
        externalLinkId: created.id,
        environmentUrl,
        previewTitle,
      });
    }
  });

  return NextResponse.json({
    message: "Deployment status processed",
    ok: true,
  });
}
