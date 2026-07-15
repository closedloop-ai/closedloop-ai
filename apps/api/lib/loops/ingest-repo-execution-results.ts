/**
 * Shared routine for ingesting per-repo execution results from multi-repo loops.
 *
 * Consolidates the PR creation/dedup logic used by the loop execute path:
 * - apps/api/lib/loops/loop-commands/execute-handler.ts (ingestExecutionArtifacts)
 */

import {
  EvaluationReportType,
  type JudgesReport,
} from "@repo/api/src/types/evaluation";
import type { RepoExecutionResult } from "@repo/api/src/types/loop";
import type { PromptsSnapshot } from "@repo/api/src/types/prompt";
import {
  GitHubInstallationStatus,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { log } from "@repo/observability/log";
import pLimit from "p-limit";
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
  documentId: string;
  loopId?: string;
  correlationId?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Max number of per-repo ingests processed concurrently. Each success entry
 * opens a `withDb` lookup and a `withDb.tx` transaction, so an unbounded
 * fan-out over a large repo set could exhaust the shared pg pool (capped at
 * `max: 20`) and trigger transaction wait timeouts. Kept well under that cap
 * while still parallelizing the loop (matches PR_READ_REPAIR_CONCURRENCY).
 */
const REPO_INGEST_CONCURRENCY = 5;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Ingest a single successful repo result into the database within an own
 * transaction. Resolves the repo by fullName, creates the PR Artifact + detail
 * (race-safe via ensurePrLinkageRecords). Skipped entries (missing
 * installation repo or source artifact) are warn-logged and silently dropped.
 */
async function ingestSuccessEntry(
  ctx: IngestionContext,
  result: RepoExecutionResult & { status: "success" }
): Promise<void> {
  const { organizationId, documentId, loopId, correlationId } = ctx;

  // Look up via GitHubInstallationRepository (the canonical repo table).
  const installationRepo = await withDb((db) =>
    db.gitHubInstallationRepository.findFirst({
      where: {
        fullName: result.fullName,
        removedAt: null,
        installation: {
          organizationId,
          status: GitHubInstallationStatus.ACTIVE,
        },
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
    `Closedloop: ${result.branchName || `PR #${result.prNumber}`}`;

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
 * - Each successful entry is processed concurrently in its own transaction; a
 *   failure in one repo does not abort processing for other repos.
 * - Failed and skipped entries are logged and skipped.
 */
export async function ingestRepoExecutionResults(
  ctx: IngestionContext,
  results: RepoExecutionResult[],
  opts: IngestRepoExecutionResultsOpts = {}
): Promise<void> {
  const { organizationId, documentId, loopId, correlationId } = ctx;
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
      documentId,
      reportId: codeJudgesReport.report_id,
      judgesCount: codeJudgesReport.stats.length,
    });
  }

  // Process each per-repo result independently and concurrently. Each success
  // entry keeps its own transaction and its own try/catch, so a failure in one
  // repo is warn-logged and does not abort processing for the other repos.
  // Concurrency is bounded (pLimit) so a many-repo loop can't exhaust the
  // shared pg pool and hit transaction wait timeouts.
  const limit = pLimit(REPO_INGEST_CONCURRENCY);
  await Promise.all(
    results.map((result) =>
      limit(async () => {
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
          return;
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
          return;
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
              error: err,
            }
          );
        }
      })
    )
  );
}
