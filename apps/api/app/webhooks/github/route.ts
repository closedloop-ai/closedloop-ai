import type {
  WorkflowRunCompletedEvent,
  WorkflowRunInProgressEvent,
  WorkflowRunRequestedEvent,
} from "@octokit/webhooks-types";
import { getArtifactUrl, uploadArtifact } from "@repo/aws";
import { withDb } from "@repo/database";
import {
  downloadWorkflowArtifacts,
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

type WorkflowRunEvent =
  | WorkflowRunCompletedEvent
  | WorkflowRunInProgressEvent
  | WorkflowRunRequestedEvent;

type ZipContent = {
  planContent: string | null;
  questionsContent: string | null;
  entries: { name: string; data: Buffer }[];
};

/**
 * Search a zip for plan or questions files.
 * Returns the content if found, null otherwise.
 */
function findPlanInZip(zip: AdmZip): ZipContent {
  const entries: { name: string; data: Buffer }[] = [];
  let planContent: string | null = null;
  let questionsContent: string | null = null;

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) {
      continue;
    }

    const content = entry.getData();
    entries.push({ name: entry.entryName, data: content });

    if (entry.entryName.endsWith("implementation-plan.md")) {
      planContent = content.toString("utf-8");
      log.info(
        `Found implementation plan: ${entry.entryName} (${planContent.length} chars)`
      );
    }

    if (entry.entryName.endsWith("open-questions.md")) {
      questionsContent = content.toString("utf-8");
      log.info(
        `Found questions file: ${entry.entryName} (${questionsContent.length} chars)`
      );
    }
  }

  return { planContent, questionsContent, entries };
}

/**
 * Upload entries to S3, optionally filtering out certain file types.
 */
async function uploadEntriesToS3(
  correlationId: string,
  entries: { name: string; data: Buffer }[],
  skipZips = false
): Promise<string[]> {
  const artifactKeys: string[] = [];
  for (const entry of entries) {
    if (skipZips && entry.name.endsWith(".zip")) {
      continue;
    }
    const s3Key = `plans/${correlationId}/${entry.name}`;
    await uploadArtifact(s3Key, entry.data);
    artifactKeys.push(s3Key);
  }
  return artifactKeys;
}

/**
 * Process a single artifact zip, handling nested zips.
 */
async function processArtifactZip(
  correlationId: string,
  artifactData: Buffer,
  artifactName: string,
  uploadToS3: boolean
): Promise<ZipContent & { artifactKeys: string[] }> {
  const outerZip = new AdmZip(artifactData);
  const outerEntries = outerZip.getEntries();
  const artifactKeys: string[] = [];

  log.info(
    `[processArtifactZip] "${artifactName}" contains ${outerEntries.length} files`
  );

  let planContent: string | null = null;
  let questionsContent: string | null = null;

  // Check for nested zips first (Symphony artifact structure)
  for (const entry of outerEntries) {
    if (!entry.entryName.endsWith(".zip") || entry.isDirectory) {
      continue;
    }

    log.info(`[processArtifactZip] Found nested zip: ${entry.entryName}`);
    const innerZip = new AdmZip(entry.getData());
    const result = findPlanInZip(innerZip);

    planContent = result.planContent ?? planContent;
    questionsContent = result.questionsContent ?? questionsContent;

    if (uploadToS3) {
      const keys = await uploadEntriesToS3(correlationId, result.entries);
      artifactKeys.push(...keys);
    }
  }

  // Also check outer zip directly (in case it's not nested)
  if (!planContent) {
    const result = findPlanInZip(outerZip);
    planContent = result.planContent ?? planContent;
    questionsContent = result.questionsContent ?? questionsContent;

    if (uploadToS3) {
      const keys = await uploadEntriesToS3(correlationId, result.entries, true);
      artifactKeys.push(...keys);
    }
  }

  return { planContent, questionsContent, entries: [], artifactKeys };
}

/**
 * Download and extract workflow artifacts, optionally upload to S3.
 * Handles nested zips (GitHub wraps artifacts, Symphony may also zip).
 */
async function processArtifactUploads(
  correlationId: string,
  runId: number,
  uploadToS3: boolean
): Promise<{
  planContent: string | null;
  questionsContent: string | null;
  artifactKeys: string[];
}> {
  log.info(
    `[processArtifactUploads] Downloading artifacts for run ${runId}, uploadToS3=${uploadToS3}`
  );

  const artifacts = await downloadWorkflowArtifacts(runId);
  let planContent: string | null = null;
  let questionsContent: string | null = null;
  const artifactKeys: string[] = [];

  log.info(`[processArtifactUploads] Downloaded ${artifacts.length} artifacts`);

  for (const artifact of artifacts) {
    const result = await processArtifactZip(
      correlationId,
      artifact.data,
      artifact.name,
      uploadToS3
    );

    planContent = result.planContent ?? planContent;
    questionsContent = result.questionsContent ?? questionsContent;
    artifactKeys.push(...result.artifactKeys);
  }

  if (planContent || questionsContent) {
    log.info(
      `[processArtifactUploads] Found content: plan=${!!planContent}, questions=${!!questionsContent}`
    );
  } else {
    log.warn(
      "[processArtifactUploads] No plan or questions found in artifacts"
    );
  }

  return { planContent, questionsContent, artifactKeys };
}

/**
 * Handle successful workflow completion.
 */
async function handleWorkflowSuccess(
  ctx: WorkflowContext,
  s3Configured: boolean
): Promise<void> {
  const { correlationId, artifactId, workstreamId, runId } = ctx;

  // Always download and extract artifacts (we need the plan content regardless of S3)
  const result = await processArtifactUploads(
    correlationId,
    runId,
    s3Configured
  );
  const { planContent, questionsContent, artifactKeys } = result;

  // TODO: Handle questionsContent with needs_answers status in future
  // For now, if we have questions but no plan, include them in the content
  const finalContent = planContent ?? questionsContent;

  await withDb(async (db) => {
    // TODO: These artifact queries need to include the organizationId for proper isolation!
    // Verify artifact exists before updating
    const existingArtifact = await db.artifact.findUnique({
      where: { id: artifactId },
      select: { id: true },
    });

    if (!existingArtifact) {
      throw new Error(
        `Artifact ${artifactId} not found - cannot update with workflow results`
      );
    }

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
        // Note: generatedBy is a UUID field, not free-form text
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

/**
 * Find the GitHubActionRun by correlation ID in triggerData.
 * @param correlationId - The correlation ID to search for
 * @param activeOnly - If true, only find runs that are still in progress (PENDING, QUEUED, RUNNING)
 *                     If false, find any run regardless of status (for replay support)
 */
async function findActionRunByCorrelationId(
  correlationId: string,
  activeOnly = true
) {
  const actionRuns = await withDb((db) =>
    db.gitHubActionRun.findMany({
      where: {
        workflowName: "symphony-dispatch",
        ...(activeOnly
          ? { status: { in: ["PENDING", "QUEUED", "RUNNING"] } }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    })
  );

  return actionRuns.find((run) => {
    const data = run.triggerData as { correlationId?: string } | null;
    return data?.correlationId === correlationId;
  });
}

/**
 * Handle workflow status updates (requested, in_progress).
 */
async function handleWorkflowStatusUpdate(
  correlationId: string,
  action: "requested" | "in_progress",
  runId: number,
  htmlUrl: string
): Promise<Response> {
  const parsed = parseCorrelationId(correlationId);
  if (!parsed) {
    log.warn("[webhook/github] Invalid correlation ID format", {
      correlationId,
      action,
    });
    return NextResponse.json({
      message: "Invalid correlation ID format",
      ok: true,
    });
  }

  const actionRun = await findActionRunByCorrelationId(correlationId);
  if (!actionRun) {
    log.info("[webhook/github] No GitHubActionRun found for status update", {
      correlationId,
      action,
      runId,
    });
    return NextResponse.json({
      message: `No matching action run found for correlation ${correlationId}`,
      ok: true,
    });
  }

  const newStatus = action === "requested" ? "QUEUED" : "RUNNING";

  await withDb((db) =>
    db.gitHubActionRun.update({
      where: { id: actionRun.id },
      data: {
        runId: BigInt(runId),
        status: newStatus,
        htmlUrl,
        ...(action === "in_progress" ? { startedAt: new Date() } : {}),
      },
    })
  );

  log.info("[webhook/github] Updated GitHubActionRun status", {
    actionRunId: actionRun.id,
    correlationId,
    newStatus,
    runId,
  });

  return NextResponse.json({ result: "status_updated", ok: true });
}

async function processWorkflowCompletion(
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
  };

  log.info("[webhook/github] Found matching GitHubActionRun", {
    actionRunId: actionRun.id,
    workstreamId: actionRun.workstreamId,
    correlationId: triggerData.correlationId,
  });

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
    correlationId: triggerData.correlationId,
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

    const event: WorkflowRunEvent = JSON.parse(body);

    log.info("[webhook/github] Parsed workflow_run event", {
      action: event.action,
      workflowName: event.workflow.name,
      workflowPath: event.workflow.path,
      runId: event.workflow_run.id,
      conclusion:
        event.action === "completed"
          ? (event as WorkflowRunCompletedEvent).workflow_run.conclusion
          : null,
      htmlUrl: event.workflow_run.html_url,
    });

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

    // Extract correlation ID from run name (workflow YAML sets run-name: ${{ inputs.correlation_id }})
    const correlationId = event.workflow_run.name;

    log.info("[webhook/github] Extracted correlation ID from run name", {
      runName: correlationId,
      runId: event.workflow_run.id,
      action: event.action,
    });

    // Check if this is for our environment
    if (!isCurrentEnvironment(correlationId)) {
      log.info("[webhook/github] Event for different environment, ignoring", {
        correlationId,
        currentEnv: process.env.WEBAPP_ENV,
        action: event.action,
      });
      return NextResponse.json({
        message: "Event for different environment, ignoring",
        ok: true,
      });
    }

    // Route by action type
    switch (event.action) {
      case "requested":
      case "in_progress": {
        return await handleWorkflowStatusUpdate(
          correlationId,
          event.action,
          event.workflow_run.id,
          event.workflow_run.html_url
        );
      }

      case "completed":
        log.info("[webhook/github] Processing symphony-dispatch completion", {
          runId: event.workflow_run.id,
          correlationId,
          conclusion: (event as WorkflowRunCompletedEvent).workflow_run
            .conclusion,
        });
        return await processWorkflowCompletion(
          event as WorkflowRunCompletedEvent,
          correlationId,
          s3Configured
        );

      default: {
        // TypeScript exhaustiveness check - this should never happen
        const unhandledAction = (event as { action: string }).action;
        log.info("[webhook/github] Ignoring unhandled action", {
          action: unhandledAction,
          reason: "Not a tracked action type",
        });
        return NextResponse.json({
          message: `Ignoring action: ${unhandledAction}`,
          ok: true,
        });
      }
    }
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
