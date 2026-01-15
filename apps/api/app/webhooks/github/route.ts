import type { WorkflowRunCompletedEvent } from "@octokit/webhooks-types";
import { getArtifactUrl, uploadArtifact } from "@repo/aws";
import { keys as awsKeys } from "@repo/aws/keys";
import { database } from "@repo/database";
import {
  downloadWorkflowArtifacts,
  getWorkflowRunInputs,
  isCurrentEnvironment,
  parseCorrelationId,
  verifyWebhookSignature,
} from "@repo/github";
import { keys as githubKeys } from "@repo/github/keys";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import AdmZip from "adm-zip";
import { headers } from "next/headers";
import { NextResponse } from "next/server";

/**
 * Handle successful workflow completion.
 * Downloads artifacts, uploads to S3, and updates the implementation plan.
 */
async function handleWorkflowSuccess(
  correlationId: string,
  runId: number
): Promise<void> {
  const artifacts = await downloadWorkflowArtifacts(runId);

  if (artifacts.length === 0) {
    log.warn(`No artifacts found for run ${runId}`);
    return;
  }

  let planContent: string | null = null;
  const artifactKeys: string[] = [];

  for (const artifact of artifacts) {
    const zip = new AdmZip(artifact.data);
    const entries = zip.getEntries();

    for (const entry of entries) {
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

  await database.implementationPlan.update({
    where: { correlationId },
    data: {
      jobStatus: "completed",
      jobCompletedAt: new Date(),
      content: planContent || undefined,
      artifactUrl:
        artifactKeys.length > 0
          ? getArtifactUrl(`plans/${correlationId}/`)
          : undefined,
      artifactKeys,
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
  correlationId: string,
  runId: number,
  htmlUrl: string
): Promise<void> {
  await database.implementationPlan.update({
    where: { correlationId },
    data: {
      jobStatus: "failed",
      jobCompletedAt: new Date(),
      content: `Plan generation failed. See workflow run: ${htmlUrl}`,
    },
  });

  log.error(`Workflow run ${runId} failed for correlation ${correlationId}`);
}

function isGitHubConfigured(): boolean {
  try {
    githubKeys();
    return true;
  } catch {
    return false;
  }
}

function isS3Configured(): boolean {
  try {
    const s3Keys = awsKeys();
    return Boolean(s3Keys.S3_BUCKET_NAME);
  } catch {
    return false;
  }
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
    // Manual run or non-workflow_dispatch trigger
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

  // Look up the plan by correlation ID
  const plan = await database.implementationPlan.findUnique({
    where: { correlationId },
  });

  if (!plan) {
    log.warn(`No implementation plan found for correlation ${correlationId}`);
    return NextResponse.json({
      message: `No matching plan found for correlation ${correlationId}`,
      ok: true,
    });
  }

  if (event.workflow_run.conclusion === "success") {
    if (s3Configured) {
      await handleWorkflowSuccess(correlationId, runId);
    } else {
      await database.implementationPlan.update({
        where: { correlationId },
        data: {
          jobStatus: "completed",
          jobCompletedAt: new Date(),
        },
      });
      log.info(`Marked plan as completed (S3 not configured) for run ${runId}`);
    }
  } else {
    await handleWorkflowFailure(
      correlationId,
      runId,
      event.workflow_run.html_url
    );
  }

  return NextResponse.json({ result: "processed", ok: true });
}

export const POST = async (request: Request): Promise<Response> => {
  if (!isGitHubConfigured()) {
    return NextResponse.json({ message: "GitHub not configured", ok: false });
  }

  const s3Configured = isS3Configured();

  try {
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
