import {
  type ExecutionResultFile,
  type ExecutionResultV2,
  parseExecutionResultFile,
} from "@closedloop-ai/loops-api/execution-result";
import type { WorkflowRunCompletedEvent } from "@octokit/webhooks-types";
import {
  EvaluationReportType,
  type JudgesReport,
} from "@repo/api/src/types/evaluation";
import type { PromptsSnapshot } from "@repo/api/src/types/prompt";
import { type Prisma, type TransactionClient, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { documentVersionService } from "@/app/documents/document-version-service";
import { documentWhere } from "@/lib/artifact-adapters";
import { fanOutJudgeScores } from "@/lib/judge-score-fanout";
import {
  type IngestionContext,
  ingestRepoExecutionResults,
} from "@/lib/loops/ingest-repo-execution-results";
import { upsertFromSnapshot } from "@/lib/prompts-service";
import type { WorkflowContext } from "../types";
import { findActionRunByCorrelationId } from "../webhook-service";
import { processArtifactDownloads } from "./workflow-artifacts";

/**
 * Handle successful execution workflow — delegates to the shared
 * ingestRepoExecutionResults routine for PR creation/dedup logic.
 */
export async function handleExecutionSuccess(
  ctx: WorkflowContext,
  executionResult: ExecutionResultFile | ExecutionResultV2,
  codeJudgesReport: JudgesReport | null,
  promptsSnapshot: PromptsSnapshot | null,
  opts: { tx?: TransactionClient } = {}
): Promise<void> {
  const {
    correlationId,
    workstreamId,
    organizationId,
    documentId,
    runId,
    actionRunId,
    fullName,
  } = ctx;

  const parsed = parseExecutionResultFile(executionResult, fullName);

  if (!parsed.ok) {
    log.error(
      "[handleExecutionSuccess] Failed to parse execution result file",
      {
        correlationId,
        runId,
        error: parsed.error,
        schemaVersion: parsed.schemaVersion,
      }
    );
    throw new Error(
      `[handleExecutionSuccess] Failed to parse execution result file for correlation ${correlationId}: ${parsed.error}`
    );
  }

  log.info("[handleExecutionSuccess] Parsed execution result file", {
    correlationId,
    runId,
    schemaVersion: parsed.schemaVersion,
    repoCount: parsed.repoCount,
  });

  const ingestionCtx: IngestionContext = {
    organizationId,
    workstreamId,
    documentId,
    correlationId,
    actionRunId,
  };

  await ingestRepoExecutionResults(ingestionCtx, parsed.results, {
    codeJudgesReport,
    promptsSnapshot,
    tx: opts.tx,
  });

  log.info(
    `[handleExecutionSuccess] Completed ingestion for workflow run ${runId}, correlation ${correlationId}`
  );
}

/**
 * Handle successful workflow completion.
 * Persists prompts snapshot for non-execute path; execute path persists via handleExecutionSuccess.
 *
 * `tx` is required for the non-execute path (artifact content must land
 * atomically with the action run status update). For the execute path
 * it is always passed as `null` by `processWorkflowCompletion` so the
 * inner per-repo withDb.tx calls can own their own transactions instead
 * of joining an outer tx via AsyncLocalStorage.
 */
export async function handleWorkflowSuccess(
  tx: TransactionClient | null,
  ctx: WorkflowContext
): Promise<void> {
  const { correlationId, documentId, workstreamId, runId, command } = ctx;

  // Download and extract artifacts from GitHub
  const result = await processArtifactDownloads(runId);
  const {
    planContent,
    questionsContent,
    executionResult,
    judgesReport,
    codeJudgesReport,
    perfSummary,
    promptsSnapshot,
  } = result;

  // Handle execute command differently - create PR record instead of updating artifact.
  // Performance data is intentionally not persisted for execute runs: perf.jsonl tracks
  // Symphony orchestrator iterations, which are only produced by plan-generation runs.
  if (command === "execute") {
    if (executionResult) {
      await handleExecutionSuccess(
        ctx,
        executionResult,
        codeJudgesReport,
        promptsSnapshot,
        tx ? { tx } : {}
      );
    } else {
      log.warn(
        "[handleWorkflowSuccess] No execution result for execute command",
        {
          correlationId,
          runId,
        }
      );
    }
    return;
  }

  if (!tx) {
    throw new Error(
      "handleWorkflowSuccess: tx is required for non-execute command paths"
    );
  }

  // TODO: Handle questionsContent with needs_answers status in future
  // For now, if we have questions but no plan, include them in the content
  const finalContent = planContent ?? questionsContent;

  log.info("[handleWorkflowSuccess] Updating artifact", {
    documentId,
    hasContent: !!finalContent,
    contentLength: finalContent?.length ?? 0,
    hasPerfSummary: !!perfSummary,
    command,
  });

  if (!documentId) {
    log.error(
      "[handleWorkflowSuccess] No documentId in context - cannot update artifact",
      {
        correlationId,
        workstreamId,
        command,
      }
    );
    return;
  }

  const workstream = await tx.workstream.findUnique({
    where: { id: workstreamId },
    select: { organizationId: true },
  });

  if (!workstream) {
    throw new Error(
      `Workstream ${workstreamId} not found - cannot update artifact`
    );
  }

  const existingDocument = await tx.artifact.findUnique({
    where: documentWhere({
      id: documentId,
      organizationId: workstream.organizationId,
    }),
    select: {
      id: true,
      organizationId: true,
      document: { select: { latestVersion: true } },
    },
  });

  if (!existingDocument) {
    throw new Error(
      `Artifact ${documentId} not found in organization - cannot update with workflow results`
    );
  }

  log.info("[handleWorkflowSuccess] Found existing artifact", {
    documentId,
    latestVersion: existingDocument.document?.latestVersion,
  });

  // Store content via ArtifactVersion instead of directly on Artifact
  if (finalContent) {
    await documentVersionService.createVersion(
      documentId,
      existingDocument.organizationId,
      null,
      finalContent
    );
  }

  await tx.artifact.update({
    where: {
      id: documentId,
      organizationId: existingDocument.organizationId,
    },
    data: {
      status: "DRAFT",
    },
  });

  log.info("[handleWorkflowSuccess] Artifact updated successfully", {
    documentId,
    newContentLength: finalContent?.length ?? 0,
  });

  await tx.workstreamEvent.create({
    data: {
      workstreamId,
      type: "GITHUB_ACTION_COMPLETED",
      actorType: "system",
      data: {
        correlationId,
        documentId,
        runId,
        conclusion: "success",
      },
    },
  });

  await upsertFromSnapshot(workstream.organizationId, promptsSnapshot);

  if (judgesReport && ctx.actionRunId) {
    const evaluation = await tx.artifactEvaluation.upsert({
      where: {
        artifactId_reportId: {
          artifactId: documentId,
          reportId: judgesReport.report_id,
        },
      },
      create: {
        organizationId: workstream.organizationId,
        artifactId: documentId,
        actionRunId: ctx.actionRunId,
        reportType: EvaluationReportType.Plan,
        reportId: judgesReport.report_id,
        reportData: judgesReport,
      },
      update: {
        actionRunId: ctx.actionRunId,
        reportType: EvaluationReportType.Plan,
        reportData: judgesReport,
      },
    });

    await fanOutJudgeScores({
      evaluationId: evaluation.id,
      organizationId: workstream.organizationId,
      report: judgesReport,
      tx,
    });

    log.info("[handleWorkflowSuccess] Persisted judges report", {
      documentId,
      reportId: judgesReport.report_id,
      judgesCount: judgesReport.stats.length,
    });
  }

  // Persist perf summary if available (upsert to handle webhook replay idempotently)
  if (perfSummary !== null && perfSummary !== undefined && ctx.actionRunId) {
    await tx.gitHubActionRunPerformance.upsert({
      where: {
        artifactId_actionRunId: {
          artifactId: documentId,
          actionRunId: ctx.actionRunId,
        },
      },
      create: {
        artifactId: documentId,
        actionRunId: ctx.actionRunId,
        summaryData: perfSummary as unknown as Prisma.InputJsonValue,
      },
      update: {
        summaryData: perfSummary as unknown as Prisma.InputJsonValue,
      },
    });

    log.info("[handleWorkflowSuccess] Persisted perf summary", {
      documentId,
    });
  }

  log.info(
    `Successfully processed workflow run ${runId} for correlation ${correlationId}`
  );
}

/**
 * Handle failed workflow completion.
 * IMPORTANT: We NEVER overwrite artifact content with error messages.
 * Errors are tracked via GitHubActionRun status and workstream events.
 * The UI shows failures via the status banner.
 */
export async function handleWorkflowFailure(
  tx: TransactionClient,
  ctx: WorkflowContext,
  htmlUrl: string
): Promise<void> {
  const { correlationId, documentId, workstreamId, runId, command } = ctx;

  // Only create the event - NEVER overwrite artifact content with error messages
  await tx.workstreamEvent.create({
    data: {
      workstreamId,
      type: "GITHUB_ACTION_COMPLETED",
      actorType: "system",
      data: {
        correlationId,
        documentId,
        runId,
        command,
        conclusion: "failure",
        htmlUrl,
      },
    },
  });

  log.error(`Workflow run ${runId} failed for correlation ${correlationId}`, {
    htmlUrl,
    documentId,
    command,
  });
}

/**
 * Process workflow completion event and update database accordingly.
 */
export async function processWorkflowCompletion(
  event: WorkflowRunCompletedEvent,
  correlationId: string
): Promise<Response> {
  const runId = String(event.workflow_run.id);

  // Find GitHubActionRun by correlation ID in triggerData
  // Use activeOnly=false to support replay of completed events (idempotent processing)
  const actionRun = await findActionRunByCorrelationId(correlationId, false);

  if (!actionRun) {
    log.info("[webhook/github] No GitHubActionRun found", {
      runId,
      correlationId,
      reason:
        "No matching action run in database - may be manual run or different environment",
    });
    return NextResponse.json({
      message: "No matching action run found",
      ok: true,
    });
  }

  const triggerData = actionRun.triggerData as {
    correlationId: string;
    documentId: string;
    command?: string;
  };

  log.info("[webhook/github] Found matching GitHubActionRun", {
    actionRunId: actionRun.id,
    workstreamId: actionRun.workstreamId,
    correlationId: triggerData.correlationId,
    command: triggerData.command,
  });

  const workstream = await withDb((db) =>
    db.workstream.findUnique({
      where: { id: actionRun.workstreamId },
      select: { organizationId: true },
    })
  );

  if (!workstream) {
    throw new Error(
      `Workstream ${actionRun.workstreamId} not found - cannot process workflow completion`
    );
  }

  const conclusion = event.workflow_run.conclusion;
  const ctx: WorkflowContext = {
    correlationId: triggerData.correlationId,
    documentId: triggerData.documentId,
    workstreamId: actionRun.workstreamId,
    organizationId: workstream.organizationId,
    repositoryId: actionRun.repositoryId,
    command: triggerData.command,
    runId,
    actionRunId: actionRun.id,
    fullName: event.repository.full_name,
  };

  // For execute-success we deliberately run ingestion OUTSIDE an outer
  // withDb.tx wrapper. ingestRepoExecutionResults opens a per-repo
  // withDb.tx internally, and withDb's AsyncLocalStorage would cause that
  // inner tx to join an outer webhook tx — defeating the per-repo
  // isolation contract (a DB error in one repo would poison the outer
  // transaction and abort the subsequent gitHubActionRun.update as well
  // as every other repo's writes).
  //
  // See apps/api/app/webhooks/github/CLAUDE.md (nested withDb calls
  // participate in the parent transaction via ALS).
  if (conclusion === "success" && triggerData.command === "execute") {
    let executeProcessingError: Error | null = null;

    try {
      await handleWorkflowSuccess(null, ctx);
    } catch (error) {
      executeProcessingError =
        error instanceof Error ? error : new Error(String(error));
      log.error(
        "[processWorkflowCompletion] Execute workflow ingestion failed",
        {
          correlationId: triggerData.correlationId,
          actionRunId: actionRun.id,
          runId,
          error: executeProcessingError.message,
        }
      );
    }

    await withDb((db) =>
      db.gitHubActionRun.update({
        where: { id: actionRun.id },
        data: {
          runId: String(runId),
          status: executeProcessingError ? "FAILURE" : "SUCCESS",
          conclusion,
          htmlUrl: event.workflow_run.html_url,
          completedAt: new Date(),
        },
      })
    );

    if (executeProcessingError) {
      throw executeProcessingError;
    }

    return NextResponse.json({ result: "processed", ok: true });
  }

  // Use transaction to ensure artifact content and status are updated atomically.
  // This prevents race condition where frontend sees SUCCESS before content is ready.
  await withDb.tx(async (tx) => {
    // 1. Process the result (updates artifact content, persists prompts for non-execute path)
    if (conclusion === "success") {
      await handleWorkflowSuccess(tx, ctx);
    } else {
      await handleWorkflowFailure(tx, ctx, event.workflow_run.html_url);
    }

    // 2. Update GitHubActionRun status (done last so frontend sees content first)
    await tx.gitHubActionRun.update({
      where: { id: actionRun.id },
      data: {
        runId: String(runId),
        status: conclusion === "success" ? "SUCCESS" : "FAILURE",
        conclusion,
        htmlUrl: event.workflow_run.html_url,
        completedAt: new Date(),
      },
    });
  });

  return NextResponse.json({ result: "processed", ok: true });
}
