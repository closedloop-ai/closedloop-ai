import type { WorkflowRunCompletedEvent } from "@octokit/webhooks-types";
import {
  ArtifactStatus,
  ArtifactSubtype,
  ArtifactType,
} from "@repo/api/src/types/artifact";
import { getArtifactUrl } from "@repo/aws";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import type { WorkflowContext } from "../types";
import { findActionRunByCorrelationId } from "../webhook-service";
import type { ExecutionResult } from "../zip-parser";
import { processArtifactUploads } from "./workflow-artifacts";

/**
 * Handle successful execution workflow - creates a PR record if changes were made.
 */
export async function handleExecutionSuccess(
  ctx: WorkflowContext,
  executionResult: ExecutionResult
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
    `Symphony: ${executionResult.branch_name || `PR #${prNumber}`}`;
  const baseBranch =
    executionResult.base_branch || executionResult.base_ref || "main";

  await withDb.tx(async (tx) => {
    // Query plan artifact for organizationId, projectId, generatedBy
    const planArtifact = await tx.artifact.findUnique({
      where: { id: ctx.artifactId },
      select: {
        organizationId: true,
        projectId: true,
        generatedBy: true,
      },
    });

    if (!planArtifact) {
      throw new Error(
        `[handleExecutionSuccess] Implementation plan artifact ${ctx.artifactId} not found for correlation ${correlationId}`
      );
    }

    // Create GitHubPullRequest record
    await tx.gitHubPullRequest.create({
      data: {
        workstreamId,
        repositoryId,
        githubId: executionResult.github_id ?? prNumber,
        number: prNumber,
        title: prTitle,
        htmlUrl: executionResult.pr_url,
        headBranch: executionResult.branch_name,
        baseBranch,
        state: "OPEN",
      },
    });

    // Create Artifact record for the PR
    await tx.artifact.create({
      data: {
        organizationId: planArtifact.organizationId,
        workstreamId,
        projectId: planArtifact.projectId,
        type: ArtifactType.Branch,
        subtype: ArtifactSubtype.PullRequest,
        title: prTitle,
        externalUrl: executionResult.pr_url,
        status: ArtifactStatus.Review,
        generatedBy: planArtifact.generatedBy,
      },
    });

    // Create preview deployment record for the branch.
    // Don't set updatedAt here — let the polling refresh set it from GitHub
    // once an actual deployment exists.
    if (ctx.artifactId) {
      await tx.previewDeployment.upsert({
        where: { artifactId: ctx.artifactId },
        create: {
          artifactId: ctx.artifactId,
          ref: executionResult.branch_name,
          sha: executionResult.commit_sha ?? null,
          environment: "preview",
        },
        update: {
          ref: executionResult.branch_name,
          sha: executionResult.commit_sha ?? null,
          environment: "preview",
        },
      });
    }

    // Create workstream event
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
        },
      },
    });
  });

  log.info(
    `Successfully created PR record for workflow run ${runId}, PR #${prNumber}`
  );
}

/**
 * Handle successful workflow completion.
 */
export async function handleWorkflowSuccess(
  ctx: WorkflowContext,
  s3Configured: boolean
): Promise<void> {
  const { correlationId, artifactId, workstreamId, runId, command } = ctx;

  // Always download and extract artifacts (we need the plan content regardless of S3)
  const result = await processArtifactUploads(
    correlationId,
    runId,
    s3Configured
  );
  const {
    planContent,
    questionsContent,
    executionResult,
    judgesReport,
    artifactKeys,
  } = result;

  // Handle execute command differently - create PR record instead of updating artifact
  if (command === "execute" && executionResult) {
    await handleExecutionSuccess(ctx, executionResult);
    return;
  }

  // TODO: Handle questionsContent with needs_answers status in future
  // For now, if we have questions but no plan, include them in the content
  const finalContent = planContent ?? questionsContent;

  log.info("[handleWorkflowSuccess] Updating artifact", {
    artifactId,
    hasContent: !!finalContent,
    contentLength: finalContent?.length ?? 0,
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

  await withDb(async (db) => {
    // TODO: These artifact queries need to include the organizationId for proper isolation!
    // Verify artifact exists before updating
    const existingArtifact = await db.artifact.findUnique({
      where: { id: artifactId },
      select: { id: true, content: true },
    });

    if (!existingArtifact) {
      throw new Error(
        `Artifact ${artifactId} not found - cannot update with workflow results`
      );
    }

    log.info("[handleWorkflowSuccess] Found existing artifact", {
      artifactId,
      hasExistingContent: !!existingArtifact.content,
      existingContentLength: existingArtifact.content?.length ?? 0,
    });

    await db.artifact.update({
      where: { id: artifactId },
      data: {
        status: "DRAFT",
        content: finalContent || undefined,
        externalUrl:
          artifactKeys.length > 0
            ? getArtifactUrl(`plans/${correlationId}/`)
            : undefined,
      },
    });

    log.info("[handleWorkflowSuccess] Artifact updated successfully", {
      artifactId,
      newContentLength: finalContent?.length ?? 0,
    });

    await db.workstreamEvent.create({
      data: {
        workstreamId,
        type: "GITHUB_ACTION_COMPLETED",
        actorType: "system",
        data: {
          correlationId,
          artifactId,
          runId,
          conclusion: "success",
          artifactKeys,
        },
      },
    });

    // Persist judges report if available
    if (judgesReport && ctx.actionRunId) {
      await db.artifactEvaluation.upsert({
        where: {
          artifactId_reportId: {
            artifactId,
            reportId: judgesReport.report_id,
          },
        },
        create: {
          artifactId,
          actionRunId: ctx.actionRunId,
          reportId: judgesReport.report_id,
          reportData: judgesReport,
        },
        update: {
          reportData: judgesReport,
        },
      });

      log.info("[handleWorkflowSuccess] Persisted judges report", {
        artifactId,
        reportId: judgesReport.report_id,
        judgesCount: judgesReport.stats.length,
      });
    }
  });

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
  ctx: WorkflowContext,
  htmlUrl: string
): Promise<void> {
  const { correlationId, artifactId, workstreamId, runId, command } = ctx;

  await withDb(async (db) => {
    // Only create the event - NEVER overwrite artifact content with error messages
    await db.workstreamEvent.create({
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
  correlationId: string,
  s3Configured: boolean
): Promise<Response> {
  const runId = event.workflow_run.id;

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
    // 1. Process the result (updates artifact content)
    if (conclusion === "success") {
      await handleWorkflowSuccess(ctx, s3Configured);
    } else {
      await handleWorkflowFailure(ctx, event.workflow_run.html_url);
    }

    // 2. Update GitHubActionRun status (done last so frontend sees content first)
    await tx.gitHubActionRun.update({
      where: { id: actionRun.id },
      data: {
        runId: BigInt(runId),
        status: conclusion === "success" ? "SUCCESS" : "FAILURE",
        conclusion,
        htmlUrl: event.workflow_run.html_url,
        completedAt: new Date(),
      },
    });
  });

  return NextResponse.json({ result: "processed", ok: true });
}
