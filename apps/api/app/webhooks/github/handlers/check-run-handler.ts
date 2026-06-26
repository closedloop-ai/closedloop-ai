import type { CheckRunEvent } from "@octokit/webhooks-types";
import { LinkType } from "@repo/api/src/types/artifact";
import { ArtifactType, GitHubInstallationStatus, withDb } from "@repo/database";
import { queryStatusCheckRollup } from "@repo/github";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { persistBranchStatusChecksFromRollup } from "@/lib/branch-status-checks";

/**
 * Handle GitHub check_run webhook events.
 *
 * On check_run.completed for a tracked branch commit:
 * 1. Look up the repository by githubId (installation-scoped via unique constraint)
 * 2. Find the matching branch artifact by headSha or branch name
 * 3. Query GitHub GraphQL statusCheckRollup for the aggregate CI state
 * 4. Update checksStatus atomically with idempotency guard
 *
 * GitHub App settings (T-7.1) filter delivery to completed events.
 * The action guard below provides defense-in-depth.
 */
export async function handleCheckRun(event: CheckRunEvent): Promise<Response> {
  // (1) Action guard - exit immediately for non-completed events
  if (event.action !== "completed") {
    log.info("[handleCheckRun] Skipping non-completed action", {
      action: event.action,
      checkRunName: event.check_run.name,
      repositoryFullName: event.repository.full_name,
    });
    return NextResponse.json({
      message: `Ignoring check_run action: ${event.action}`,
      ok: true,
    });
  }

  // (2) Installation guard - need installationId to call GitHub GraphQL
  const installationId = event.installation?.id;
  if (!installationId) {
    log.warn("[handleCheckRun] Missing installation on event", {
      checkRunId: event.check_run.id,
      repositoryFullName: event.repository.full_name,
    });
    return NextResponse.json(
      { message: "Missing installation", ok: false },
      { status: 400 }
    );
  }

  const headSha = event.check_run.head_sha;
  const headBranch = event.check_run.check_suite?.head_branch ?? null;

  log.info("[handleCheckRun] Processing check_run completed event", {
    check_run_name: event.check_run.name,
    conclusion: event.check_run.conclusion,
    headSha,
    head_branch: headBranch,
    repositoryId: event.repository.id,
    installationId,
  });

  // (3) Non-transactional read - avoid holding locks during external GraphQL call
  // Look up by githubRepoId — a GitHub repo may appear once per installation,
  // but the first match suffices for owner/name needed by the GraphQL call.
  const { repo, branch } = await withDb(async (db) => {
    const foundRepo = await db.gitHubInstallationRepository.findFirst({
      where: {
        githubRepoId: String(event.repository.id),
        fullName: event.repository.full_name,
        installation: {
          installationId: String(installationId),
          status: GitHubInstallationStatus.ACTIVE,
        },
      },
      select: {
        id: true,
        owner: true,
        name: true,
        installation: { select: { organizationId: true } },
      },
    });

    if (!foundRepo) {
      return { repo: null, branch: null };
    }

    const branchDetailSelect = {
      artifactId: true,
      branchName: true,
      checksStatus: true,
      headSha: true,
      currentPullRequestDetailId: true,
      currentPullRequestDetail: {
        select: {
          number: true,
          title: true,
          htmlUrl: true,
        },
      },
      artifact: {
        select: {
          name: true,
          externalUrl: true,
          organizationId: true,
          targetLinks: {
            where: {
              linkType: LinkType.Produces,
              source: { type: ArtifactType.DOCUMENT },
            },
            select: {
              source: { select: { id: true, slug: true } },
            },
            orderBy: { createdAt: "asc" as const },
            take: 1,
          },
        },
      },
    };

    // Prefer GitHub's head_branch over same-SHA matches so two branches that
    // currently point at the same commit cannot update the wrong artifact.
    const foundByBranchName = headBranch
      ? await db.branchDetail.findFirst({
          where: {
            repositoryId: foundRepo.id,
            branchName: headBranch,
          },
          select: branchDetailSelect,
        })
      : null;
    const foundBranchDetail =
      foundByBranchName ??
      (await db.branchDetail.findFirst({
        where: {
          repositoryId: foundRepo.id,
          headSha,
        },
        select: branchDetailSelect,
        orderBy: [{ createdAt: "asc" }, { artifactId: "asc" }],
      }));

    const linkedDoc =
      foundBranchDetail?.artifact.targetLinks[0]?.source ?? null;
    const foundBranch = foundBranchDetail
      ? {
          id: foundBranchDetail.artifactId,
          branchName: foundBranchDetail.branchName,
          title: foundBranchDetail.artifact.name,
          htmlUrl: foundBranchDetail.artifact.externalUrl ?? "",
          checksStatus: foundBranchDetail.checksStatus,
          headSha: foundBranchDetail.headSha,
          currentPullRequestDetailId:
            foundBranchDetail.currentPullRequestDetailId,
          currentPullRequest: foundBranchDetail.currentPullRequestDetail,
          organizationId: foundBranchDetail.artifact.organizationId,
          documentId: linkedDoc?.id ?? null,
          document: linkedDoc ? { slug: linkedDoc.slug ?? "" } : null,
        }
      : null;

    return { repo: foundRepo, branch: foundBranch };
  });

  if (!repo) {
    log.info("[handleCheckRun] Repository not registered in Symphony", {
      githubRepoId: event.repository.id,
      repositoryFullName: event.repository.full_name,
    });
    return NextResponse.json({ message: "Repository not tracked", ok: true });
  }

  if (!branch) {
    log.info("[handleCheckRun] No branch artifact found for headSha", {
      headSha,
      repositoryId: repo.id,
    });
    return NextResponse.json({
      message: "No matching branch for this commit",
      ok: true,
    });
  }

  // (4) External call - query GitHub GraphQL statusCheckRollup outside any transaction
  const rollup = await queryStatusCheckRollup(
    String(installationId),
    repo.owner,
    repo.name,
    headSha
  );

  const persistResult = await withDb.tx(async (tx) => {
    const result = await persistBranchStatusChecksFromRollup(tx, {
      branchArtifactId: branch.id,
      organizationId: branch.organizationId,
      headSha,
      rollup,
    });
    return result;
  });

  if (persistResult.status === "skipped") {
    log.info("[handleCheckRun] Branch is stale or deleted, skipping update", {
      branchArtifactId: branch.id,
      headSha,
      reason: persistResult.reason,
    });
    return NextResponse.json({ message: "Stale branch skipped", ok: true });
  }

  if (rollup.ok && persistResult.checksStatusChanged) {
    log.info("[handleCheckRun] Updated checksStatus and check details", {
      branchArtifactId: branch.id,
      headSha,
      previousStatus: persistResult.previousChecksStatus,
      newStatus: persistResult.nextChecksStatus,
    });
  }

  log.info(
    "[handleCheckRun] Successfully processed check_run completed event",
    {
      checkRunName: event.check_run.name,
      repositoryFullName: event.repository.full_name,
      headSha,
    }
  );

  return NextResponse.json({
    message: "Event processed successfully",
    ok: true,
  });
}
