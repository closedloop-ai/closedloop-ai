import type { WorkflowRunCompletedEvent } from "@octokit/webhooks-types";
import { getArtifactUrl, uploadArtifact } from "@repo/aws";
import { database, ensureDatabase } from "@repo/database";
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

  await database.artifact.update({
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

  await database.workstreamEvent.create({
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

  await database.artifact.update({
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

  await database.workstreamEvent.create({
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
  const inputs = await getWorkflowRunInputs(runId);

  if (!inputs) {
    log.info(`Workflow run ${runId} has no inputs (manual run?), ignoring`);
    return NextResponse.json({
      message: "No workflow inputs found (manual run)",
      ok: true,
    });
  }

  const correlationId = inputs.correlation_id;
  if (!correlationId) {
    log.info(`Workflow run ${runId} has no correlation_id input, ignoring`);
    return NextResponse.json({
      message: "No correlation_id in workflow inputs",
      ok: true,
    });
  }

  if (!isCurrentEnvironment(correlationId)) {
    return NextResponse.json({
      message: "Event for different environment, ignoring",
      ok: true,
    });
  }

  const parsed = parseCorrelationId(correlationId);
  if (!parsed) {
    return NextResponse.json({
      message: "Invalid correlation ID format",
      ok: false,
    });
  }

  // Find the GitHubActionRun by correlation ID in triggerData
  // We stored it as triggerData: { correlationId, artifactId, command }
  const actionRuns = await database.gitHubActionRun.findMany({
    where: {
      workflowName: "symphony-dispatch",
      status: { in: ["PENDING", "RUNNING"] },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  // Find the one with matching correlation ID
  const actionRun = actionRuns.find((run) => {
    const data = run.triggerData as { correlationId?: string } | null;
    return data?.correlationId === correlationId;
  });

  if (!actionRun) {
    log.warn(`No GitHubActionRun found for correlation ${correlationId}`);
    return NextResponse.json({
      message: `No matching action run found for correlation ${correlationId}`,
      ok: true,
    });
  }

  const triggerData = actionRun.triggerData as {
    correlationId: string;
    artifactId: string;
  };

  // Update GitHubActionRun
  const conclusion = event.workflow_run.conclusion;
  await database.gitHubActionRun.update({
    where: { id: actionRun.id },
    data: {
      runId: BigInt(runId),
      status: conclusion === "success" ? "SUCCESS" : "FAILURE",
      conclusion,
      htmlUrl: event.workflow_run.html_url,
      completedAt: new Date(),
    },
  });

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
  if (!isGitHubConfigured()) {
    return NextResponse.json({ message: "GitHub not configured", ok: false });
  }

  const s3Configured = isS3Configured();

  try {
    await ensureDatabase();
    const { body, signature, eventType } = await validateRequest(request);

    if (!signature) {
      return NextResponse.json(
        { message: "Missing signature", ok: false },
        { status: 401 }
      );
    }

    if (!verifyWebhookSignature(body, signature)) {
      return NextResponse.json(
        { message: "Invalid signature", ok: false },
        { status: 401 }
      );
    }

    if (eventType !== "workflow_run") {
      return NextResponse.json({
        message: `Ignoring event type: ${eventType}`,
        ok: true,
      });
    }

    const event: WorkflowRunCompletedEvent = JSON.parse(body);

    if (event.action !== "completed") {
      return NextResponse.json({
        message: `Ignoring action: ${event.action}`,
        ok: true,
      });
    }

    if (!event.workflow.path.includes("symphony-dispatch")) {
      return NextResponse.json({
        message: `Ignoring workflow: ${event.workflow.name}`,
        ok: true,
      });
    }

    return await processWorkflowCompletion(event, s3Configured);
  } catch (error) {
    const message = parseError(error);
    log.error(`GitHub webhook error: ${message}`);

    return NextResponse.json(
      { message: "Something went wrong", ok: false },
      { status: 500 }
    );
  }
};
