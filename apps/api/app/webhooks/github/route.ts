import type { WorkflowRunCompletedEvent } from "@octokit/webhooks-types";
import { getArtifactUrl, uploadArtifact } from "@repo/aws";
import { withDb } from "@repo/database";
import {
  downloadWorkflowArtifacts,
  getWorkflowRunInputs,
  isCurrentEnvironment,
  parseCorrelationId,
  verifyWebhookSignature,
} from "@repo/github";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import AdmZip from "adm-zip";
import { headers } from "next/headers";
import { NextResponse } from "next/server";

type WorkflowContext = {
  correlationId: string;
  artifactId: string;
  workstreamId: string;
  runId: number;
};

/**
 * Download and upload workflow artifacts to S3.
 */
async function processArtifactUploads(
  correlationId: string,
  runId: number
): Promise<{ planContent: string | null; artifactKeys: string[] }> {
  const artifacts = await downloadWorkflowArtifacts(runId);
  let planContent: string | null = null;
  const artifactKeys: string[] = [];

  for (const artifact of artifacts) {
    const zip = new AdmZip(artifact.data);
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) {
        continue;
      }

      const content = entry.getData();
      const s3Key = `plans/${correlationId}/${entry.entryName}`;

      await uploadArtifact(s3Key, content);
      artifactKeys.push(s3Key);

      if (entry.entryName.endsWith("implementation-plan.md")) {
        planContent = content.toString("utf-8");
      }
    }
  }

  return { planContent, artifactKeys };
}

/**
 * Handle successful workflow completion.
 */
async function handleWorkflowSuccess(
  ctx: WorkflowContext,
  s3Configured: boolean
): Promise<void> {
  const { correlationId, artifactId, workstreamId, runId } = ctx;
  let planContent: string | null = null;
  let artifactKeys: string[] = [];

  if (s3Configured) {
    const result = await processArtifactUploads(correlationId, runId);
    planContent = result.planContent;
    artifactKeys = result.artifactKeys;
  }

  await withDb(async (db) => {
    await db.artifact.update({
      where: { id: artifactId },
      data: {
        status: "DRAFT",
        content: planContent || undefined,
        externalUrl:
          artifactKeys.length > 0
            ? getArtifactUrl(`plans/${correlationId}/`)
            : undefined,
        generatedBy: `symphony-dispatch:${correlationId}:completed`,
      },
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
  });

  log.info(
    `Successfully processed workflow run ${runId} for correlation ${correlationId}`
  );
}

/**
 * Handle failed workflow completion.
 */
async function handleWorkflowFailure(
  ctx: WorkflowContext,
  htmlUrl: string
): Promise<void> {
  const { correlationId, artifactId, workstreamId, runId } = ctx;

  await withDb(async (db) => {
    await db.artifact.update({
      where: { id: artifactId },
      data: {
        status: "DRAFT",
        content: `# Plan Generation Failed

The automated plan generation encountered an error.

**Workflow Run:** [View on GitHub](${htmlUrl})
**Correlation ID:** ${correlationId}

Please check the workflow logs for more details, or try regenerating the plan.
`,
        generatedBy: `symphony-dispatch:${correlationId}:failed`,
      },
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
          conclusion: "failure",
          htmlUrl,
        },
      },
    });
  });

  log.error(`Workflow run ${runId} failed for correlation ${correlationId}`);
}

function isGitHubConfigured(): boolean {
  // Check env vars directly to avoid build-time validation errors
  return Boolean(
    process.env.SYMPHONY_APP_ID &&
      process.env.SYMPHONY_APP_PRIVATE_KEY &&
      process.env.GITHUB_WEBHOOK_SECRET &&
      process.env.SYMPHONY_DISPATCH_REPO
  );
}

function isS3Configured(): boolean {
  // Check env vars directly to avoid build-time validation errors
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY &&
      process.env.S3_BUCKET_NAME
  );
}

async function validateRequest(request: Request) {
  const body = await request.text();
  const headerPayload = await headers();
  const signature = headerPayload.get("x-hub-signature-256");
  const eventType = headerPayload.get("x-github-event");

  return { body, signature, eventType };
}

async function processWorkflowCompletion(
  event: WorkflowRunCompletedEvent,
  s3Configured: boolean
): Promise<Response> {
  const runId = event.workflow_run.id;

  // Fetch workflow inputs to get correlation_id
  let inputs: Record<string, string> | null;
  try {
    inputs = await getWorkflowRunInputs(runId);
  } catch (error) {
    const errorMessage = parseError(error);
    log.error("[webhook/github] Failed to fetch workflow inputs", {
      runId,
      error: errorMessage,
    });
    // Acknowledge the webhook but log the error - don't return 500
    return NextResponse.json({
      message: "Failed to fetch workflow inputs",
      ok: true,
    });
  }

  if (!inputs) {
    log.info("[webhook/github] No workflow inputs found", {
      runId,
      reason: "Manual run or no inputs - ignoring",
    });
    return NextResponse.json({
      message: "No workflow inputs found (manual run)",
      ok: true,
    });
  }

  log.info("[webhook/github] Workflow inputs retrieved", {
    runId,
    targetRepo: inputs.target_repo,
    command: inputs.command,
    correlationId: inputs.correlation_id,
    hasContext: !!inputs.context,
  });

  const correlationId = inputs.correlation_id;
  if (!correlationId) {
    log.info("[webhook/github] No correlation_id in inputs", {
      runId,
      reason: "Missing correlation_id - ignoring",
    });
    return NextResponse.json({
      message: "No correlation_id in workflow inputs",
      ok: true,
    });
  }

  if (!isCurrentEnvironment(correlationId)) {
    const parsed = parseCorrelationId(correlationId);
    log.info("[webhook/github] Event for different environment", {
      runId,
      correlationId,
      eventEnv: parsed?.env,
      currentEnv: process.env.WEBAPP_ENV,
      reason: "Environment mismatch - ignoring",
    });
    return NextResponse.json({
      message: "Event for different environment, ignoring",
      ok: true,
    });
  }

  const parsed = parseCorrelationId(correlationId);
  if (!parsed) {
    log.warn("[webhook/github] Invalid correlation ID format", {
      runId,
      correlationId,
      reason: "Could not parse correlation ID",
    });
    return NextResponse.json({
      message: "Invalid correlation ID format",
      ok: false,
    });
  }

  log.info("[webhook/github] Looking up GitHubActionRun", {
    correlationId: parsed.id,
    env: parsed.env,
  });

  // Find the GitHubActionRun by correlation ID in triggerData
  // We stored it as triggerData: { correlationId, artifactId, command }
  const actionRuns = await withDb((db) =>
    db.gitHubActionRun.findMany({
      where: {
        workflowName: "symphony-dispatch",
        status: { in: ["PENDING", "RUNNING"] },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    })
  );

  // Find the one with matching correlation ID
  const actionRun = actionRuns.find((run) => {
    const data = run.triggerData as { correlationId?: string } | null;
    return data?.correlationId === correlationId;
  });

  if (!actionRun) {
    log.warn("[webhook/github] No GitHubActionRun found", {
      correlationId,
      runId,
      searchedCount: actionRuns.length,
      reason: "No matching pending/running action run in database",
    });
    return NextResponse.json({
      message: `No matching action run found for correlation ${correlationId}`,
      ok: true,
    });
  }

  log.info("[webhook/github] Found matching GitHubActionRun", {
    actionRunId: actionRun.id,
    workstreamId: actionRun.workstreamId,
    correlationId,
  });

  const triggerData = actionRun.triggerData as {
    correlationId: string;
    artifactId: string;
  };

  // Update GitHubActionRun
  const conclusion = event.workflow_run.conclusion;
  await withDb((db) =>
    db.gitHubActionRun.update({
      where: { id: actionRun.id },
      data: {
        runId: BigInt(runId),
        status: conclusion === "success" ? "SUCCESS" : "FAILURE",
        conclusion,
        htmlUrl: event.workflow_run.html_url,
        completedAt: new Date(),
      },
    })
  );

  // Process the result
  const ctx: WorkflowContext = {
    correlationId,
    artifactId: triggerData.artifactId,
    workstreamId: actionRun.workstreamId,
    runId,
  };

  if (conclusion === "success") {
    await handleWorkflowSuccess(ctx, s3Configured);
  } else {
    await handleWorkflowFailure(ctx, event.workflow_run.html_url);
  }

  return NextResponse.json({ result: "processed", ok: true });
}

export const POST = async (request: Request): Promise<Response> => {
  log.info("[webhook/github] Received webhook request");

  if (!isGitHubConfigured()) {
    log.warn("[webhook/github] GitHub not configured, rejecting request");
    return NextResponse.json({ message: "GitHub not configured", ok: false });
  }

  const s3Configured = isS3Configured();

  try {
    const { body, signature, eventType } = await validateRequest(request);

    log.info("[webhook/github] Validating request", { eventType });

    if (!signature) {
      log.warn("[webhook/github] Missing signature header, rejecting");
      return NextResponse.json(
        { message: "Missing signature", ok: false },
        { status: 401 }
      );
    }

    if (!verifyWebhookSignature(body, signature)) {
      log.warn("[webhook/github] Invalid signature, rejecting");
      return NextResponse.json(
        { message: "Invalid signature", ok: false },
        { status: 401 }
      );
    }

    if (eventType !== "workflow_run") {
      log.info("[webhook/github] Ignoring non-workflow_run event", {
        eventType,
        reason: "Not a workflow_run event",
      });
      return NextResponse.json({
        message: `Ignoring event type: ${eventType}`,
        ok: true,
      });
    }

    const event: WorkflowRunCompletedEvent = JSON.parse(body);

    log.info("[webhook/github] Parsed workflow_run event", {
      action: event.action,
      workflowName: event.workflow.name,
      workflowPath: event.workflow.path,
      runId: event.workflow_run.id,
      conclusion: event.workflow_run.conclusion,
      htmlUrl: event.workflow_run.html_url,
    });

    if (event.action !== "completed") {
      log.info("[webhook/github] Ignoring non-completed action", {
        action: event.action,
        reason: "Only processing completed workflow runs",
      });
      return NextResponse.json({
        message: `Ignoring action: ${event.action}`,
        ok: true,
      });
    }

    if (!event.workflow.path.includes("symphony-dispatch")) {
      log.info("[webhook/github] Ignoring non-symphony-dispatch workflow", {
        workflowName: event.workflow.name,
        workflowPath: event.workflow.path,
        reason: "Not a symphony-dispatch workflow",
      });
      return NextResponse.json({
        message: `Ignoring workflow: ${event.workflow.name}`,
        ok: true,
      });
    }

    log.info("[webhook/github] Processing symphony-dispatch completion", {
      runId: event.workflow_run.id,
      conclusion: event.workflow_run.conclusion,
    });

    return await processWorkflowCompletion(event, s3Configured);
  } catch (error) {
    const message = parseError(error);
    log.error("[webhook/github] Unhandled error processing webhook", {
      error: message,
    });

    return NextResponse.json(
      { message: "Something went wrong", ok: false },
      { status: 500 }
    );
  }
};
