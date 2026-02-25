import { isCurrentEnvironment } from "@repo/github";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import type { WorkflowRunEvent } from "../types";
import { processWorkflowCompletion } from "./workflow-completion-handler";
import { handleWorkflowStatusUpdate } from "./workflow-status-handler";

/**
 * Main handler for workflow_run events.
 * Routes to either status update handling or completion handling based on the event action.
 *
 * This function extracts the workflow_run event routing logic from route.ts.
 * It validates the workflow path, extracts the correlation ID, checks environment,
 * and routes to the appropriate handler based on the event action.
 */
export async function handleWorkflowRun(
  event: WorkflowRunEvent
): Promise<Response> {
  log.info("[webhook/github] Parsed workflow_run event", {
    action: event.action,
    workflowName: event.workflow.name,
    workflowPath: event.workflow.path,
    runId: event.workflow_run.id,
    conclusion:
      event.action === "completed" ? event.workflow_run.conclusion : null,
    htmlUrl: event.workflow_run.html_url,
  });

  // Only process symphony-dispatch workflows
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
        conclusion: event.workflow_run.conclusion,
      });
      return await processWorkflowCompletion(event, correlationId);

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
}
