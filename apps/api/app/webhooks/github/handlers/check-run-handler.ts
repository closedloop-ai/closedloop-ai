import type { CheckRunEvent } from "@octokit/webhooks-types";
import { ChecksStatus, withDb } from "@repo/database";
import { queryStatusCheckRollup } from "@repo/github";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";

/**
 * Map a GitHub statusCheckRollup state to our ChecksStatus enum.
 * Exported separately for unit testing.
 *
 * Mapping:
 * - SUCCESS → PASSING
 * - FAILURE | ERROR → FAILING
 * - PENDING | EXPECTED → PENDING
 */
export function mapRollupStateToChecksStatus(
  rollupState: "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED"
): ChecksStatus {
  switch (rollupState) {
    case "SUCCESS":
      return ChecksStatus.PASSING;
    case "FAILURE":
    case "ERROR":
      return ChecksStatus.FAILING;
    case "PENDING":
    case "EXPECTED":
      return ChecksStatus.PENDING;
    default: {
      const _exhaustiveCheck: never = rollupState;
      log.warn("[handleCheckRun] Unknown rollup state, defaulting to PENDING", {
        rollupState: _exhaustiveCheck,
      });
      return ChecksStatus.PENDING;
    }
  }
}

/**
 * Handle GitHub check_run webhook events.
 *
 * On check_run.completed for a tracked PR's commit:
 * 1. Look up the repository by githubId (installation-scoped via unique constraint)
 * 2. Find the matching open pull request by headSha
 * 3. Query GitHub GraphQL statusCheckRollup for the aggregate CI state
 * 4. Update checksStatus atomically with idempotency guard
 * 5. Create a GITHUB_CI_STATUS_CHANGED workstream event on change
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

  log.info("[handleCheckRun] Processing check_run completed event", {
    checkRunName: event.check_run.name,
    conclusion: event.check_run.conclusion,
    headSha,
    repositoryId: event.repository.id,
    installationId,
  });

  // (3) Non-transactional read - avoid holding locks during external GraphQL call
  // Look up by githubRepoId — a GitHub repo may appear once per installation,
  // but the first match suffices for owner/name needed by the GraphQL call.
  const { repo, pr } = await withDb(async (db) => {
    const foundRepo = await db.gitHubInstallationRepository.findFirst({
      where: { githubRepoId: event.repository.id },
      select: { id: true, owner: true, name: true },
    });

    if (!foundRepo) {
      return { repo: null, pr: null };
    }

    const foundPr = await db.gitHubPullRequest.findFirst({
      where: {
        headSha,
        state: "OPEN",
        repositoryId: foundRepo.id,
      },
      select: {
        id: true,
        number: true,
        title: true,
        htmlUrl: true,
        checksStatus: true,
        headSha: true,
        workstreamId: true,
        artifactId: true,
        artifact: { select: { slug: true } },
      },
    });

    return { repo: foundRepo, pr: foundPr };
  });

  if (!repo) {
    log.info("[handleCheckRun] Repository not registered in Symphony", {
      githubRepoId: event.repository.id,
      repositoryFullName: event.repository.full_name,
    });
    return NextResponse.json({ message: "Repository not tracked", ok: true });
  }

  if (!pr) {
    log.info("[handleCheckRun] No open PR found for headSha", {
      headSha,
      repositoryId: repo.id,
    });
    return NextResponse.json({
      message: "No matching open PR for this commit",
      ok: true,
    });
  }

  // (4) External call - query GitHub GraphQL statusCheckRollup outside any transaction
  const rollupState = await queryStatusCheckRollup(
    installationId,
    repo.owner,
    repo.name,
    headSha
  );

  if (!rollupState) {
    log.warn(
      "[handleCheckRun] statusCheckRollup returned null, skipping update",
      {
        headSha,
        repositoryId: repo.id,
        prId: pr.id,
      }
    );
    return NextResponse.json({ message: "Rollup state unavailable", ok: true });
  }

  // (5) Pure mapping - convert GitHub rollup state to ChecksStatus
  const newStatus = mapRollupStateToChecksStatus(rollupState);

  // (6) Transactional write with TOCTOU guard
  await withDb.tx(async (tx) => {
    // Re-read to guard against TOCTOU: a synchronize event may have arrived
    // between our non-tx read above and now, changing headSha or state.
    const currentPr = await tx.gitHubPullRequest.findUnique({
      where: { id: pr.id },
      select: { headSha: true, checksStatus: true, state: true },
    });

    if (!currentPr) {
      log.info("[handleCheckRun] PR no longer exists, skipping update", {
        prId: pr.id,
      });
      return;
    }

    // If the PR's headSha changed, a synchronize event arrived between our read
    // and this transaction. The new commit will trigger its own check_run events.
    if (currentPr.headSha !== headSha) {
      log.info(
        "[handleCheckRun] PR headSha changed since read, skipping update",
        {
          prId: pr.id,
          expectedHeadSha: headSha,
          currentHeadSha: currentPr.headSha,
        }
      );
      return;
    }

    // PR must still be open
    if (currentPr.state !== "OPEN") {
      log.info("[handleCheckRun] PR is no longer open, skipping update", {
        prId: pr.id,
        state: currentPr.state,
      });
      return;
    }

    // Idempotency guard - no update or event if status is already correct
    if (currentPr.checksStatus === newStatus) {
      log.info("[handleCheckRun] checksStatus already up to date, skipping", {
        prId: pr.id,
        checksStatus: newStatus,
      });
      return;
    }

    // Update checksStatus
    await tx.gitHubPullRequest.update({
      where: { id: pr.id },
      data: { checksStatus: newStatus },
    });

    // Create workstream event — payload keys match pull-request-handler synchronize
    await tx.workstreamEvent.create({
      data: {
        workstreamId: pr.workstreamId,
        type: "GITHUB_CI_STATUS_CHANGED",
        actorType: "system",
        data: {
          prNumber: pr.number,
          prTitle: pr.title,
          prUrl: pr.htmlUrl,
          artifactId: pr.artifactId,
          slug: pr.artifact?.slug,
          checksStatus: newStatus,
          previousChecksStatus: currentPr.checksStatus,
          headSha,
        },
      },
    });

    log.info(
      "[handleCheckRun] Updated checksStatus and created workstream event",
      {
        prId: pr.id,
        headSha,
        previousStatus: currentPr.checksStatus,
        newStatus,
      }
    );
  });

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
