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
import {
  type TransactionClient,
  WorkstreamEventType,
  withDb,
} from "@repo/database";
import { log } from "@repo/observability/log";
import { documentWhere } from "@/lib/artifact-adapters";
import { upsertEvaluationWithJudgeScores } from "@/lib/loops/loop-document-ingestion";
import { ensurePrLinkageRecords } from "@/lib/pr-linkage";
import { upsertFromSnapshot } from "@/lib/prompts-service";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Context required for ingestion — identifies the artifact being produced and,
 * when available, the loop run that produced it.
 */
export type IngestionContext = {
  organizationId: string;
  workstreamId: string;
  documentId: string;
  loopId?: string;
  correlationId?: string;
  actionRunId?: string;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Ingest a single successful repo result into the database within an own
 * transaction. Resolves the repo by fullName, creates the PR Artifact + detail
 * (race-safe via ensurePrLinkageRecords), and writes a workstream event.
 * Skipped entries (missing installation repo or source artifact) are
 * warn-logged and silently dropped.
 */
async function ingestSuccessEntry(
  ctx: IngestionContext,
  result: RepoExecutionResult & { status: "success" }
): Promise<void> {
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
    return;
  }

  const prTitle =
    result.prTitle ||
    `ClosedLoop: ${result.branchName || `PR #${result.prNumber}`}`;

  let ingested = false;

  await withDb.tx(async (tx) => {
    // Verify the source DOCUMENT artifact exists (used for projectId scoping
    // + linkage creation). The cross-repo check in documentWhere also confines
    // the lookup to organizationId.
    const sourceArtifact = await tx.artifact.findUnique({
      where: documentWhere({ id: documentId, organizationId }),
      select: { organizationId: true, projectId: true, slug: true },
    });

    if (!sourceArtifact) {
      log.warn(
        "[ingest-repo-execution-results] Source artifact not found for PR record creation",
        {
          loopId,
          correlationId,
          documentId,
        }
      );
      return;
    }

    // Create PR artifact + detail and the source → PRODUCES → PR link, with
    // race-safe dedup against records that may have been created by the
    // pull_request webhook or another command handler.
    await ensurePrLinkageRecords(tx, {
      organizationId: sourceArtifact.organizationId,
      workstreamId,
      projectId: sourceArtifact.projectId,
      documentId,
      prUrl: result.prUrl,
      prTitle,
      prNumber: result.prNumber,
      githubId: String(result.githubId ?? result.prNumber),
      headBranch: result.branchName,
      baseBranch: result.baseBranch,
      commitSha: result.commitSha ?? null,
    });

    // Create workstream event (always — events are an append-only log)
    await tx.workstreamEvent.create({
      data: {
        workstreamId,
        type: WorkstreamEventType.GITHUB_PR_CREATED,
        actorType: "system",
        data: {
          ...(loopId ? { loopId } : {}),
          correlationId,
          prNumber: result.prNumber,
          prUrl: result.prUrl,
          prTitle,
          branch: result.branchName,
          documentId,
          slug: sourceArtifact.slug,
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
        artifactId: documentId,
        ...(loopId ? { loopId } : {}),
        ...(actionRunId ? { actionRunId } : {}),
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
