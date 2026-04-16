import type { WorkflowRunCompletedEvent } from "@octokit/webhooks-types";
import {
  EvaluationReportType,
  type JudgesReport,
} from "@repo/api/src/types/evaluation";
import type { PromptsSnapshot } from "@repo/api/src/types/prompt";
import {
  EntityType,
  type Prisma,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { artifactVersionService } from "@/app/artifacts/artifact-version-service";
import { fanOutJudgeScores } from "@/lib/judge-score-fanout";
import { ensurePrLinkageRecords } from "@/lib/pr-linkage";
import { upsertFromSnapshot } from "@/lib/prompts-service";
import type { ExecutionResult, WorkflowContext } from "../types";
import { findActionRunByCorrelationId } from "../webhook-service";
import { processArtifactDownloads } from "./workflow-artifacts";

/**
 * Metadata structure for GITHUB_PR_CREATED and GITHUB_PR_MERGED events.
 * Used for type-safe event data serialization in WorkstreamEvent.data.
 */
type PrEventMetadata = {
  prTitle: string;
  prUrl: string;
  artifactId: string;
  slug?: string;
  branch: string;
  prNumber: number;
  correlationId: string;
  runId: string;
};

/**
 * Handle successful execution workflow - creates a PR record and
 * ExternalLink/EntityLink entries if changes were made.
 */
export async function handleExecutionSuccess(
  ctx: WorkflowContext,
  executionResult: ExecutionResult,
  codeJudgesReport: JudgesReport | null,
  promptsSnapshot: PromptsSnapshot | null
): Promise<void> {
  const { correlationId, workstreamId, repositoryId, runId } = ctx;

  // Check if execution actually produced changes and a PR
  if (!(executionResult.has_changes && executionResult.pr_url)) {
    log.info(
      `Execution completed with no changes for workflow run ${runId}, correlation ${correlationId}`
    );
    // Create event to indicate execution completed but no PR was needed
    await withDb((db) =>
      db.workstreamEvent.create({
        data: {
          workstreamId,
          type: "GITHUB_ACTION_COMPLETED",
          actorType: "system",
          data: {
            correlationId,
            runId,
            command: "execute",
            conclusion: "success",
            hasChanges: false,
            message: "Execution completed - no changes to commit",
          },
        },
      })
    );
    return;
  }

  if (!repositoryId) {
    if (codeJudgesReport) {
      log.warn(
        "[handleExecutionSuccess] Dropping codeJudgesReport — no repositoryId in context",
        {
          reportId: codeJudgesReport.report_id,
        }
      );
    }
    log.error(
      `[handleExecutionSuccess] No repositoryId in context for correlation ${correlationId}`
    );
    return;
  }

  // Convert pr_number from string to number (GitHub Actions outputs strings)
  const prNumber =
    typeof executionResult.pr_number === "string"
      ? Number.parseInt(executionResult.pr_number, 10)
      : executionResult.pr_number;

  // Provide defaults for optional fields
  const prTitle =
    executionResult.pr_title ||
    `ClosedLoop: ${executionResult.branch_name || `PR #${prNumber}`}`;
  const baseBranch =
    executionResult.base_branch || executionResult.base_ref || "main";

  await withDb.tx(async (tx) => {
    // Look up workstream to get organizationId for org-scoped queries
    const workstream = await tx.workstream.findUnique({
      where: { id: workstreamId },
      select: { organizationId: true },
    });

    if (!workstream) {
      throw new Error(
        `[handleExecutionSuccess] Workstream ${workstreamId} not found for correlation ${correlationId}`
      );
    }

    // Query plan artifact scoped to organization for defense-in-depth
    const planArtifact = await tx.artifact.findUnique({
      where: { id: ctx.artifactId, organizationId: workstream.organizationId },
      select: {
        organizationId: true,
        projectId: true,
        slug: true,
      },
    });

    if (!planArtifact) {
      throw new Error(
        `[handleExecutionSuccess] Implementation plan artifact ${ctx.artifactId} not found in organization for correlation ${correlationId}`
      );
    }

    // Check if a PR record already exists (may have been created by the
    // pull_request webhook or loop execute handler racing with this handler).
    const existingPr = await tx.gitHubPullRequest.findUnique({
      where: {
        repositoryId_number: {
          repositoryId,
          number: prNumber,
        },
      },
      select: { id: true, artifactId: true },
    });

    // Determine the effective artifactId for linkage. If the PR row already
    // exists with a different artifact, respect the existing link to avoid
    // creating contradictory entity-link edges.
    let effectiveArtifactId = ctx.artifactId;

    if (existingPr) {
      if (!existingPr.artifactId) {
        // PR exists without an artifact link — claim it
        await tx.gitHubPullRequest.update({
          where: { id: existingPr.id },
          data: { artifactId: ctx.artifactId },
        });
      } else if (existingPr.artifactId !== ctx.artifactId) {
        // PR is already linked to a different artifact — don't overwrite
        effectiveArtifactId = existingPr.artifactId;
        log.warn(
          "[handleExecutionSuccess] PR already linked to a different artifact",
          {
            existingArtifactId: existingPr.artifactId,
            requestedArtifactId: ctx.artifactId,
            prNumber,
            correlationId,
          }
        );
      }
      log.info(
        "[handleExecutionSuccess] PR already exists; skipping duplicate PR row create",
        {
          repositoryId,
          prNumber,
          pullRequestId: existingPr.id,
          correlationId,
        }
      );
    } else {
      // Create GitHubPullRequest record
      await tx.gitHubPullRequest.create({
        data: {
          workstreamId,
          organizationId: workstream.organizationId,
          repositoryId,
          artifactId: ctx.artifactId,
          githubId: String(executionResult.github_id ?? prNumber),
          number: prNumber,
          title: prTitle,
          htmlUrl: executionResult.pr_url,
          headBranch: executionResult.branch_name,
          baseBranch,
          state: "OPEN",
        },
      });
    }

    // Create ExternalLink, EntityLink, and preview deployment records (with dedup)
    await ensurePrLinkageRecords(tx, {
      organizationId: workstream.organizationId,
      workstreamId,
      projectId: planArtifact.projectId!,
      artifactId: effectiveArtifactId,
      prUrl: executionResult.pr_url,
      prTitle,
      prNumber,
      githubId: String(executionResult.github_id ?? prNumber),
      headBranch: executionResult.branch_name,
      baseBranch,
      commitSha: executionResult.commit_sha ?? null,
    });

    // Create workstream event (always — events are an append-only log)
    await tx.workstreamEvent.create({
      data: {
        workstreamId,
        type: "GITHUB_PR_CREATED",
        actorType: "system",
        data: {
          correlationId,
          prNumber,
          prUrl: executionResult.pr_url,
          prTitle,
          branch: executionResult.branch_name,
          runId,
          artifactId: ctx.artifactId,
          slug: planArtifact.slug,
        } as PrEventMetadata,
      },
    });

    await upsertFromSnapshot(workstream.organizationId, promptsSnapshot);

    if (codeJudgesReport && ctx.actionRunId) {
      const evaluation = await tx.artifactEvaluation.upsert({
        where: {
          entityId_reportId: {
            entityId: ctx.artifactId,
            reportId: codeJudgesReport.report_id,
          },
        },
        create: {
          organizationId: workstream.organizationId,
          entityId: ctx.artifactId,
          entityType: EntityType.ARTIFACT,
          artifactId: ctx.artifactId,
          actionRunId: ctx.actionRunId,
          reportType: EvaluationReportType.Code,
          reportId: codeJudgesReport.report_id,
          reportData: codeJudgesReport,
        },
        update: {
          reportType: EvaluationReportType.Code,
          reportData: codeJudgesReport,
        },
      });

      await fanOutJudgeScores({
        evaluationId: evaluation.id,
        organizationId: workstream.organizationId,
        report: codeJudgesReport,
        tx,
      });

      log.info("[handleExecutionSuccess] Persisted code judges report", {
        artifactId: ctx.artifactId,
        reportId: codeJudgesReport.report_id,
        judgesCount: codeJudgesReport.stats.length,
      });
    }
  });

  log.info(
    `Successfully created PR record for workflow run ${runId}, PR #${prNumber}`
  );
}

/**
 * Handle successful workflow completion.
 * Persists prompts snapshot for non-execute path; execute path persists via handleExecutionSuccess.
 */
export async function handleWorkflowSuccess(
  tx: TransactionClient,
  ctx: WorkflowContext
): Promise<void> {
  const { correlationId, artifactId, workstreamId, runId, command } = ctx;

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
  if (command === "execute" && executionResult) {
    await handleExecutionSuccess(
      ctx,
      executionResult,
      codeJudgesReport,
      promptsSnapshot
    );
    return;
  }

  // TODO: Handle questionsContent with needs_answers status in future
  // For now, if we have questions but no plan, include them in the content
  const finalContent = planContent ?? questionsContent;

  log.info("[handleWorkflowSuccess] Updating artifact", {
    artifactId,
    hasContent: !!finalContent,
    contentLength: finalContent?.length ?? 0,
    hasPerfSummary: !!perfSummary,
    command,
  });

  if (!artifactId) {
    log.error(
      "[handleWorkflowSuccess] No artifactId in context - cannot update artifact",
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

  const existingArtifact = await tx.artifact.findUnique({
    where: { id: artifactId, organizationId: workstream.organizationId },
    select: { id: true, organizationId: true, latestVersion: true },
  });

  if (!existingArtifact) {
    throw new Error(
      `Artifact ${artifactId} not found in organization - cannot update with workflow results`
    );
  }

  log.info("[handleWorkflowSuccess] Found existing artifact", {
    artifactId,
    latestVersion: existingArtifact.latestVersion,
  });

  // Store content via ArtifactVersion instead of directly on Artifact
  if (finalContent) {
    await artifactVersionService.createVersion(
      artifactId,
      existingArtifact.organizationId,
      null,
      finalContent
    );
  }

  await tx.artifact.update({
    where: {
      id: artifactId,
      organizationId: existingArtifact.organizationId,
    },
    data: {
      status: "DRAFT",
    },
  });

  log.info("[handleWorkflowSuccess] Artifact updated successfully", {
    artifactId,
    newContentLength: finalContent?.length ?? 0,
  });

  await tx.workstreamEvent.create({
    data: {
      workstreamId,
      type: "GITHUB_ACTION_COMPLETED",
      actorType: "system",
      data: {
        correlationId,
        artifactId,
        runId,
        conclusion: "success",
      },
    },
  });

  await upsertFromSnapshot(workstream.organizationId, promptsSnapshot);

  if (judgesReport && ctx.actionRunId) {
    const evaluation = await tx.artifactEvaluation.upsert({
      where: {
        entityId_reportId: {
          entityId: artifactId,
          reportId: judgesReport.report_id,
        },
      },
      create: {
        organizationId: workstream.organizationId,
        entityId: artifactId,
        entityType: EntityType.ARTIFACT,
        artifactId,
        actionRunId: ctx.actionRunId,
        reportType: EvaluationReportType.Plan,
        reportId: judgesReport.report_id,
        reportData: judgesReport,
      },
      update: {
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
      artifactId,
      reportId: judgesReport.report_id,
      judgesCount: judgesReport.stats.length,
    });
  }

  // Persist perf summary if available (upsert to handle webhook replay idempotently)
  if (perfSummary !== null && perfSummary !== undefined && ctx.actionRunId) {
    await tx.gitHubActionRunPerformance.upsert({
      where: {
        artifactId_actionRunId: {
          artifactId,
          actionRunId: ctx.actionRunId,
        },
      },
      create: {
        artifactId,
        actionRunId: ctx.actionRunId,
        summaryData: perfSummary as unknown as Prisma.InputJsonValue,
      },
      update: {
        summaryData: perfSummary as unknown as Prisma.InputJsonValue,
      },
    });

    log.info("[handleWorkflowSuccess] Persisted perf summary", {
      artifactId,
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
  const { correlationId, artifactId, workstreamId, runId, command } = ctx;

  // Only create the event - NEVER overwrite artifact content with error messages
  await tx.workstreamEvent.create({
    data: {
      workstreamId,
      type: "GITHUB_ACTION_COMPLETED",
      actorType: "system",
      data: {
        correlationId,
        artifactId,
        runId,
        command,
        conclusion: "failure",
        htmlUrl,
      },
    },
  });

  log.error(`Workflow run ${runId} failed for correlation ${correlationId}`, {
    htmlUrl,
    artifactId,
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
    artifactId: string;
    command?: string;
  };

  log.info("[webhook/github] Found matching GitHubActionRun", {
    actionRunId: actionRun.id,
    workstreamId: actionRun.workstreamId,
    correlationId: triggerData.correlationId,
    command: triggerData.command,
  });

  const conclusion = event.workflow_run.conclusion;
  const ctx: WorkflowContext = {
    correlationId: triggerData.correlationId,
    artifactId: triggerData.artifactId,
    workstreamId: actionRun.workstreamId,
    repositoryId: actionRun.repositoryId,
    command: triggerData.command,
    runId,
    actionRunId: actionRun.id,
  };

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
