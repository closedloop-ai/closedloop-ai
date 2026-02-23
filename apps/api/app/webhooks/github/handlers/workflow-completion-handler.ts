import type { WorkflowRunCompletedEvent } from "@octokit/webhooks-types";
import type { SymphonyCommand } from "@repo/api/src/types/artifact";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { ZipContentBag } from "../extractors/types";
import type { WorkflowContext } from "../types";
import { findActionRunByCorrelationId } from "../webhook-service";
import { resolveHandler } from "./commands/registry";
import type { WorkflowConclusion } from "./commands/types";
import { processArtifactUploads } from "./workflow-artifacts";

/**
 * Process workflow completion event and update database accordingly.
 *
 * The command and conclusion together determine which handler runs — this
 * is the single explicit dispatch point. WORKFLOW_HANDLER_MAP is the only
 * place to extend behavior; this function never changes for new commands.
 */
export async function processWorkflowCompletion(
  event: WorkflowRunCompletedEvent,
  correlationId: string,
  s3Configured: boolean
): Promise<Response> {
  const runId = event.workflow_run.id;

  // Find GitHubActionRun by correlation ID in triggerData.
  // Use activeOnly=false to support replay of completed events (idempotent processing).
  const actionRun = await findActionRunByCorrelationId(correlationId, false);

  if (!actionRun) {
    log.info("[webhook/github] No GitHubActionRun found", {
      runId,
      correlationId,
      reason:
        "No matching action run in database — may be manual run or different environment",
    });
    return NextResponse.json({
      message: "No matching action run found",
      ok: true,
    });
  }

  const triggerData = actionRun.triggerData as {
    correlationId: string;
    artifactId: string;
    command?: SymphonyCommand;
  };

  log.info("[webhook/github] Found matching GitHubActionRun", {
    actionRunId: actionRun.id,
    workstreamId: actionRun.workstreamId,
    correlationId: triggerData.correlationId,
    command: triggerData.command,
  });

  const conclusion = event.workflow_run.conclusion as WorkflowConclusion;
  const ctx: WorkflowContext = {
    correlationId: triggerData.correlationId,
    artifactId: triggerData.artifactId,
    workstreamId: actionRun.workstreamId,
    repositoryId: actionRun.repositoryId,
    command: triggerData.command,
    runId,
    actionRunId: actionRun.id,
    htmlUrl: event.workflow_run.html_url,
    conclusion,
  };

  // Use transaction to ensure artifact content and status are updated atomically.
  // This prevents race conditions where the frontend sees SUCCESS before content is ready.
  await withDb.tx(async (tx) => {
    // Artifacts are only available on successful runs — failures get an empty bag.
    const bag =
      conclusion === "success"
        ? (
            await processArtifactUploads(
              ctx.correlationId,
              ctx.runId,
              s3Configured
            )
          ).bag
        : new ZipContentBag();

    // Explicit dispatch: command + conclusion together determine behavior.
    // Extend WORKFLOW_HANDLER_MAP in registry.ts to add new commands or conclusions.
    const handler = resolveHandler(ctx.command, conclusion);
    await handler.handle(tx, ctx, bag);

    // Update GitHubActionRun status last so frontend sees content before status changes.
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
