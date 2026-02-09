import { withDb } from "@repo/database";
import { parseCorrelationId } from "@repo/github";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { findActionRunByCorrelationId } from "../webhook-service";

/**
 * Handle workflow status updates (requested, in_progress).
 */
export async function handleWorkflowStatusUpdate(
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
