/**
 * Shared routine for ingesting per-repo execution results from multi-repo loops.
 *
 * Consolidates the PR creation/dedup logic that was previously duplicated across:
 * - apps/api/lib/loops/loop-commands/execute-handler.ts (ingestExecutionArtifacts)
 * - apps/api/app/webhooks/github/handlers/workflow-completion-handler.ts (handleExecutionSuccess)
 */

import type { RepoExecutionResult } from "@closedloop-ai/loops-api/execution-result";
import {
  EvaluationReportType,
  type JudgesReport,
} from "@repo/api/src/types/evaluation";
import type { PromptsSnapshot } from "@repo/api/src/types/prompt";
import { EntityType, type TransactionClient, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { upsertEvaluationWithJudgeScores } from "@/lib/loops/loop-document-ingestion";
import { ensurePrLinkageRecords } from "@/lib/pr-linkage";
import { upsertFromSnapshot } from "@/lib/prompts-service";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Context required for ingestion — identifies the loop run and the artifact
 * being produced.
 */
export type IngestionContext = {
  organizationId: string;
  workstreamId: string;
  documentId: string;
  loopId: string;
  correlationId?: string;
  actionRunId?: string;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Ingest a single successful repo result into the database within an own
 * transaction. Resolves the repo by fullName, upserts the GitHubPullRequest
 * row (race-safe), and calls ensurePrLinkageRecords.
 *
 * Returns `true` when the per-repo writes actually landed, `false` when the
 * entry was skipped (missing installation repo or missing artifact). The
 * caller uses the return value to gate the "ingested" success log so that
 * skipped entries aren't misreported as ingested.
 */
async function ingestSuccessEntry(
  ctx: IngestionContext,
  result: RepoExecutionResult & { status: "success" }
): Promise<boolean> {
  const { organizationId, workstreamId, documentId, loopId, correlationId } =
    ctx;

  // Look up via GitHubInstallationRepository (the canonical repo table).
  const installationRepo = await withDb((db) =>
    db.gitHubInstallationRepository.findFirst({
      where: {
        fullName: result.fullName,
        installation: { organizationId, status: "ACTIVE" },
      },
      select: { id: true },
    })
  );

  if (!installationRepo) {
    log.warn(
      "[ingest-repo-execution-results] GitHubInstallationRepository not found",
      {
        loopId,
        correlationId,
        fullName: result.fullName,
      }
    );
    return false;
  }

  const prTitle =
    result.prTitle ||
    `ClosedLoop: ${result.branchName || `PR #${result.prNumber}`}`;

  let ingested = false;

  await withDb.tx(async (tx) => {
    const artifact = await tx.document.findUnique({
      where: { id: documentId, organizationId },
      select: { organizationId: true, projectId: true, slug: true },
    });

    if (!artifact) {
      log.warn(
        "[ingest-repo-execution-results] Artifact not found for PR record creation",
        {
          loopId,
          correlationId,
          documentId,
        }
      );
      return;
    }

    // Check if a PR record already exists (may have been created by the
    // pull_request webhook or workflow-completion handler racing with this handler).
    const existingPr = await tx.gitHubPullRequest.findUnique({
      where: {
        repositoryId_number: {
          repositoryId: installationRepo.id,
          number: result.prNumber,
        },
      },
      select: { id: true, documentId: true },
    });

    // Determine the effective documentId for linkage. If the PR row already
    // exists with a different artifact, respect the existing link to avoid
    // creating contradictory entity-link edges.
    let effectiveDocumentId = documentId;

    if (existingPr) {
      if (!existingPr.documentId) {
        // PR exists without an artifact link — claim it
        await tx.gitHubPullRequest.update({
          where: { id: existingPr.id },
          data: { documentId },
        });
      } else if (existingPr.documentId !== documentId) {
        // PR is already linked to a different artifact — don't overwrite
        effectiveDocumentId = existingPr.documentId;
        log.warn(
          "[ingest-repo-execution-results] PR already linked to a different artifact",
          {
            loopId,
            correlationId,
            existingDocumentId: existingPr.documentId,
            requestedDocumentId: documentId,
            prNumber: result.prNumber,
            fullName: result.fullName,
          }
        );
      }
      log.info(
        "[ingest-repo-execution-results] PR already exists; skipping duplicate PR row create",
        {
          loopId,
          correlationId,
          repositoryId: installationRepo.id,
          prNumber: result.prNumber,
          pullRequestId: existingPr.id,
        }
      );
    } else {
      await tx.gitHubPullRequest.upsert({
        where: {
          repositoryId_number: {
            repositoryId: installationRepo.id,
            number: result.prNumber,
          },
        },
        create: {
          workstreamId,
          organizationId,
          repositoryId: installationRepo.id,
          documentId,
          githubId: String(result.githubId ?? result.prNumber),
          number: result.prNumber,
          title: prTitle,
          htmlUrl: result.prUrl,
          headBranch: result.branchName,
          baseBranch: result.baseBranch,
          state: "OPEN",
        },
        // Don't overwrite fields that a concurrent handler may have set
        // more accurately (e.g. state from a webhook).
        update: {},
        select: { id: true, documentId: true },
      });
    }

    // Create ExternalLink, EntityLink, and preview deployment records (with dedup)
    await ensurePrLinkageRecords(tx, {
      organizationId: artifact.organizationId,
      workstreamId,
      projectId: artifact.projectId!,
      documentId: effectiveDocumentId,
      prUrl: result.prUrl,
      prTitle,
      prNumber: result.prNumber,
      githubId: String(result.githubId ?? result.prNumber),
      headBranch: result.branchName,
      baseBranch: result.baseBranch,
      commitSha: result.commitSha ?? null,
    });

    // Create workstream event
    await tx.workstreamEvent.create({
      data: {
        workstreamId,
        type: "GITHUB_PR_CREATED",
        actorType: "system",
        data: {
          loopId,
          correlationId,
          prNumber: result.prNumber,
          prUrl: result.prUrl,
          prTitle,
          branch: result.branchName,
          documentId,
          slug: artifact.slug,
          fullName: result.fullName,
        },
      },
    });

    ingested = true;
  });

  if (ingested) {
    log.info(
      "[ingest-repo-execution-results] Ingested execution result for repo",
      {
        loopId,
        correlationId,
        fullName: result.fullName,
        prUrl: result.prUrl,
        prNumber: result.prNumber,
      }
    );
  }

  return ingested;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Options for ingestRepoExecutionResults.
 */
type IngestRepoExecutionResultsOpts = {
  codeJudgesReport?: JudgesReport | null;
  promptsSnapshot?: PromptsSnapshot | null;
  tx?: TransactionClient;
};

/**
 * Ingest a list of per-repo execution results into the platform.
 *
 * - Code judges report and prompts snapshot are processed once, outside the
 *   per-repo loop.
 * - Each successful entry is processed in its own transaction; a failure in one
 *   repo does not abort processing for other repos.
 * - Failed and skipped entries are logged and skipped.
 */
export async function ingestRepoExecutionResults(
  ctx: IngestionContext,
  results: RepoExecutionResult[],
  opts: IngestRepoExecutionResultsOpts = {}
): Promise<void> {
  const { organizationId, documentId, loopId, correlationId, actionRunId } =
    ctx;
  const { codeJudgesReport = null, promptsSnapshot = null } = opts;

  // Process code judges report and prompts snapshot once, outside the per-repo
  // loop — these apply to the overall loop run, not to individual repos.
  // Persist prompts snapshot first so it is available before judge scores land.
  await upsertFromSnapshot(organizationId, promptsSnapshot);

  if (codeJudgesReport) {
    const persist = async (tx: TransactionClient) => {
      await upsertEvaluationWithJudgeScores({
        entityId: documentId,
        entityType: EntityType.DOCUMENT,
        documentId,
        loopId,
        organizationId,
        reportType: EvaluationReportType.Code,
        report: codeJudgesReport,
        tx,
      });
    };

    if (opts.tx) {
      await persist(opts.tx);
    } else {
      await withDb.tx(persist);
    }

    log.info("[ingest-repo-execution-results] Persisted code judges report", {
      loopId,
      correlationId,
      actionRunId,
      documentId,
      reportId: codeJudgesReport.report_id,
      judgesCount: codeJudgesReport.stats.length,
    });
  }

  // Process each per-repo result independently.
  for (const result of results) {
    if (result.status === "failed") {
      log.error(
        "[ingest-repo-execution-results] Repo execution result reported failure",
        {
          loopId,
          correlationId,
          fullName: result.fullName,
          error: result.error,
        }
      );
      continue;
    }

    if (result.status === "skipped") {
      log.info(
        "[ingest-repo-execution-results] Repo execution result was skipped",
        {
          loopId,
          correlationId,
          fullName: result.fullName,
          reason: result.reason,
        }
      );
      continue;
    }

    // status === "success"
    try {
      await ingestSuccessEntry(ctx, result);
    } catch (err) {
      log.error(
        "[ingest-repo-execution-results] Failed to ingest result for repo; continuing with remaining repos",
        {
          loopId,
          correlationId,
          fullName: result.fullName,
          error: err instanceof Error ? err.message : String(err),
        }
      );
    }
  }
}
