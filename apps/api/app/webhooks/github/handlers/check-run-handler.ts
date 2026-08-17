import type { CheckRunEvent } from "@octokit/webhooks-types";
import { LinkType } from "@repo/api/src/types/artifact";
import { StatusCheckRollupFailureReason } from "@repo/api/src/types/github";
import {
  GitHubDirtyScopeKind,
  GitHubDirtyTrigger,
} from "@repo/api/src/types/github-dirty-scope";
import {
  GitHubFetchTrigger,
  GitHubSyncResultReason,
} from "@repo/api/src/types/github-read-model";
import { ArtifactType, GitHubInstallationStatus, withDb } from "@repo/database";
import {
  GitHubProviderResultStatus,
  queryStatusCheckRollupWithProviderResult,
} from "@repo/github";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { scheduleCheckRunRetry } from "@/lib/branch-status-check-retry";
import { persistBranchStatusChecksFromRollup } from "@/lib/branch-status-checks";
import type { GitHubWebhookObservationContext } from "@/lib/github/github-webhook-observation";
import { readWithInstallationClient } from "@/lib/github/installation-client";
import { githubAppGraphqlFetchProvenance } from "@/lib/github-fetch-provenance";
import {
  GitHubBranchActivityEventName,
  persistGitHubBranchActivity,
} from "./branch-activity-producer";
import { publishGitHubDirtyScopes } from "./dirty-scope-publisher";

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
export async function handleCheckRun(
  event: CheckRunEvent,
  observationContext?: GitHubWebhookObservationContext
): Promise<Response> {
  // (1) Action guard - exit immediately for non-completed events
  if (event.action !== "completed") {
    logCheckRunTerminalEvent(event, {
      action: event.action,
      outcome: "ignored_action",
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

  // (3) Non-transactional read - avoid holding locks during external GraphQL call
  // Look up by githubRepoId — a GitHub repo may appear once per installation,
  // but the first match suffices for owner/name needed by the GraphQL call.
  const { repo, branch } = await withDb(async (db) => {
    const foundRepo = await db.gitHubInstallationRepository.findFirst({
      where: {
        githubRepoId: String(event.repository.id),
        fullName: event.repository.full_name,
        removedAt: null,
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
      ? await db.branchDetail.findMany({
          where: {
            repositoryId: foundRepo.id,
            branchName: headBranch,
          },
          select: branchDetailSelect,
          orderBy: [{ createdAt: "asc" }, { artifactId: "asc" }],
          take: 2,
        })
      : [];
    const foundByHeadSha =
      foundByBranchName.length > 0
        ? []
        : await db.branchDetail.findMany({
            where: {
              repositoryId: foundRepo.id,
              headSha,
            },
            select: branchDetailSelect,
            orderBy: [{ createdAt: "asc" }, { artifactId: "asc" }],
            take: 2,
          });
    const foundBranchDetailCandidates =
      foundByBranchName.length > 0 ? foundByBranchName : foundByHeadSha;
    const foundBranchDetail =
      foundBranchDetailCandidates.length === 1
        ? foundBranchDetailCandidates[0]
        : null;

    const linkedDoc =
      foundBranchDetail?.artifact.targetLinks[0]?.source ?? null;
    const foundBranch = foundBranchDetail
      ? {
          id: foundBranchDetail.artifactId,
          repositoryId: foundRepo.id,
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
    logCheckRunTerminalEvent(event, {
      githubRepoId: event.repository.id,
      installationId,
      outcome: "repo_not_registered",
    });
    return NextResponse.json({ message: "Repository not tracked", ok: true });
  }

  if (!branch) {
    logCheckRunTerminalEvent(event, {
      installationId,
      outcome: "no_branch_artifact",
      repositoryId: repo.id,
    });
    return NextResponse.json({
      message: "No matching branch for this commit",
      ok: true,
    });
  }

  // (4) External call - query GitHub GraphQL statusCheckRollup outside any
  // transaction. A failed client acquisition is classified as the same
  // provider result the read produces, so a rate-limited mint still schedules
  // a retry instead of bubbling to the route's generic 500.
  const rollupResult = await readWithInstallationClient(
    String(installationId),
    (octokit) =>
      queryStatusCheckRollupWithProviderResult(
        octokit,
        repo.owner,
        repo.name,
        headSha
      )
  );
  const rollup =
    rollupResult.status === GitHubProviderResultStatus.Success
      ? rollupResult.value
      : {
          ok: false as const,
          reason:
            rollupResult.status === GitHubProviderResultStatus.ProviderRateLimit
              ? StatusCheckRollupFailureReason.RateLimited
              : StatusCheckRollupFailureReason.GraphqlError,
        };
  const retryAfterSeconds =
    rollupResult.status === GitHubProviderResultStatus.ProviderRateLimit
      ? rollupResult.retryAfterSeconds
      : null;

  const persistResult = await withDb.tx(async (tx) => {
    const result = await persistBranchStatusChecksFromRollup(tx, {
      branchArtifactId: branch.id,
      organizationId: branch.organizationId,
      headSha,
      rollup,
      fetchProvenance: githubAppGraphqlFetchProvenance({
        resultReason: rollup.ok
          ? GitHubSyncResultReason.Success
          : GitHubSyncResultReason.ProviderUnavailable,
        trigger: GitHubFetchTrigger.Webhook,
      }),
    });
    if (
      !rollup.ok &&
      rollup.reason === StatusCheckRollupFailureReason.RateLimited
    ) {
      await scheduleCheckRunRetry(
        tx,
        {
          branchArtifactId: branch.id,
          organizationId: branch.organizationId,
          repositoryId: branch.repositoryId,
          headSha,
          resourceId: String(event.check_run.id),
          idempotencyKey: buildCheckRunRetryIdempotencyKey(event),
        },
        rollup.reason,
        new Date(),
        retryAfterSeconds
      );
    }
    await persistGitHubBranchActivity({
      eventName: GitHubBranchActivityEventName.CheckRun,
      deliveryId: observationContext?.deliveryId,
      payload: event,
      attribution: {
        organizationId: branch.organizationId,
        branchArtifactId: branch.id,
      },
    });
    return result;
  });

  if (persistResult.status === "skipped") {
    logCheckRunTerminalEvent(event, {
      branchArtifactId: branch.id,
      installationId,
      outcome: "stale_branch",
      reason: persistResult.reason,
      repositoryId: branch.repositoryId,
    });
    return NextResponse.json({ message: "Stale branch skipped", ok: true });
  }

  const organizationId = repo.installation?.organizationId;
  if (organizationId) {
    await publishGitHubDirtyScopes({
      organizationId,
      repositoryId: branch.repositoryId,
      repositoryFullName: event.repository.full_name,
      scopes: [
        {
          kind: GitHubDirtyScopeKind.Checks,
          repositoryId: branch.repositoryId,
          repositoryFullName: event.repository.full_name,
          branchName: branch.branchName,
          ...(branch.currentPullRequest?.number
            ? { pullRequestNumber: branch.currentPullRequest.number }
            : {}),
          checkRunId: String(event.check_run.id),
        },
      ],
      triggers: [GitHubDirtyTrigger.CheckRun],
    });
  }

  logCheckRunTerminalEvent(event, {
    branchArtifactId: branch.id,
    checksStatusChanged: persistResult.checksStatusChanged,
    installationId,
    newStatus: persistResult.nextChecksStatus,
    outcome: persistResult.checksStatusChanged
      ? "processed_checks_changed"
      : "processed",
    previousStatus: persistResult.previousChecksStatus,
    providerStatus: rollupResult.status,
    repositoryId: branch.repositoryId,
    retryAfterSeconds,
  });

  return NextResponse.json({
    message: "Event processed successfully",
    ok: true,
  });
}

function buildCheckRunRetryIdempotencyKey(event: CheckRunEvent): string {
  return [
    event.repository.id,
    event.check_run.id,
    event.check_run.head_sha,
    event.check_run.completed_at ?? event.action,
  ].join(":");
}

function logCheckRunTerminalEvent(
  event: CheckRunEvent,
  metadata: Record<string, unknown>
): void {
  log.info("[handleCheckRun] Completed check_run webhook handling", {
    action: event.action,
    check_run_name: event.check_run.name,
    checkRunId: event.check_run.id,
    conclusion: event.check_run.conclusion,
    eventType: "check_run",
    head_branch: event.check_run.check_suite?.head_branch ?? null,
    headSha: event.check_run.head_sha,
    provider: "github",
    repositoryFullName: event.repository.full_name,
    repositoryGithubId: event.repository.id,
    ...metadata,
  });
}
