import type { CheckRunEvent } from "@octokit/webhooks-types";
import { LinkType } from "@repo/api/src/types/artifact";
import { ChecksStatus } from "@repo/api/src/types/document";
import { ArtifactType, withDb } from "@repo/database";
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
      return ChecksStatus.Passing;
    case "FAILURE":
    case "ERROR":
      return ChecksStatus.Failing;
    case "PENDING":
    case "EXPECTED":
      return ChecksStatus.Pending;
    default: {
      const _exhaustiveCheck: never = rollupState;
      log.warn("[handleCheckRun] Unknown rollup state, defaulting to PENDING", {
        rollupState: _exhaustiveCheck,
      });
      return ChecksStatus.Pending;
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
  const headBranch = event.check_run.check_suite?.head_branch ?? null;

  log.info("[handleCheckRun] Processing check_run completed event", {
    checkRunName: event.check_run.name,
    conclusion: event.check_run.conclusion,
    headSha,
    headBranch,
    repositoryId: event.repository.id,
    installationId,
  });

  // (3) Non-transactional read - avoid holding locks during external GraphQL call
  // Look up by githubRepoId — a GitHub repo may appear once per installation,
  // but the first match suffices for owner/name needed by the GraphQL call.
  const { repo, pr } = await withDb(async (db) => {
    const foundRepo = await db.gitHubInstallationRepository.findFirst({
      where: { githubRepoId: String(event.repository.id) },
      select: { id: true, owner: true, name: true },
    });

    if (!foundRepo) {
      return { repo: null, pr: null };
    }

    // Match by headSha, or fall back to headBranch for PRs created
    // without headSha (e.g., via workflow-completion-handler).
    const foundPrDetail = await db.pullRequestDetail.findFirst({
      where: {
        prState: "OPEN",
        repositoryId: foundRepo.id,
        OR: [
          { headSha },
          ...(headBranch ? [{ headSha: null, headBranch }] : []),
        ],
      },
      select: {
        artifactId: true,
        number: true,
        checksStatus: true,
        headSha: true,
        artifact: {
          select: {
            name: true,
            externalUrl: true,
            workstreamId: true,
            // The PR is the TARGET of a DOCUMENT → produces → PR link, so
            // query targetLinks here. (sourceLinks would filter
            // links-where-PR-is-source, which never match.)
            targetLinks: {
              where: {
                linkType: LinkType.Produces,
                source: { type: ArtifactType.DOCUMENT },
              },
              select: {
                source: { select: { id: true, slug: true } },
              },
              orderBy: { createdAt: "asc" },
              take: 1,
            },
          },
        },
      },
    });

    const linkedDoc = foundPrDetail?.artifact.targetLinks[0]?.source ?? null;
    const foundPr = foundPrDetail
      ? {
          id: foundPrDetail.artifactId,
          number: foundPrDetail.number,
          title: foundPrDetail.artifact.name,
          htmlUrl: foundPrDetail.artifact.externalUrl ?? "",
          checksStatus: foundPrDetail.checksStatus,
          headSha: foundPrDetail.headSha,
          // Preserve null — empty string is not a valid workstreams.id and
          // would FK-fail in tx.workstreamEvent.create below.
          workstreamId: foundPrDetail.artifact.workstreamId,
          documentId: linkedDoc?.id ?? null,
          document: linkedDoc ? { slug: linkedDoc.slug ?? "" } : null,
        }
      : null;

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
    String(installationId),
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
    const currentPr = await tx.pullRequestDetail.findUnique({
      where: { artifactId: pr.id },
      select: { headSha: true, checksStatus: true, prState: true },
    });

    if (!currentPr) {
      log.info("[handleCheckRun] PR no longer exists, skipping update", {
        prId: pr.id,
      });
      return;
    }

    // If the PR's headSha changed, a synchronize event arrived between our read
    // and this transaction. The new commit will trigger its own check_run events.
    if (currentPr.headSha !== null && currentPr.headSha !== headSha) {
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
    if (currentPr.prState !== "OPEN") {
      log.info("[handleCheckRun] PR is no longer open, skipping update", {
        prId: pr.id,
        state: currentPr.prState,
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

    // Update checksStatus on the PR detail
    await tx.pullRequestDetail.update({
      where: { artifactId: pr.id },
      data: { checksStatus: newStatus },
    });

    // Create workstream event — only when the PR artifact has a workstream.
    // Payload keys match pull-request-handler synchronize.
    if (pr.workstreamId) {
      await tx.workstreamEvent.create({
        data: {
          workstreamId: pr.workstreamId,
          type: "GITHUB_CI_STATUS_CHANGED",
          actorType: "system",
          data: {
            prNumber: pr.number,
            prTitle: pr.title,
            prUrl: pr.htmlUrl,
            documentId: pr.documentId,
            slug: pr.document?.slug,
            checksStatus: newStatus,
            previousChecksStatus: currentPr.checksStatus,
            headSha,
          },
        },
      });
    }

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
