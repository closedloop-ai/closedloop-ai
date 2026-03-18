import { LoopCommand } from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { loopsService } from "@/app/loops/service";
import { launchLoop } from "./loop-orchestrator";

/**
 * Schedule an automatic EVALUATE_PRD loop for a PRD artifact via waitUntil().
 * No-ops if an EVALUATE_PRD loop is already active for the artifact.
 * Intended to be called from route handlers after PRD creation or new version publish.
 */
export function scheduleAutoEvaluatePrd(
  artifactId: string,
  organizationId: string,
  userId: string
): void {
  waitUntil(
    runAutoEvaluatePrd(artifactId, organizationId, userId).catch((error) => {
      log.error("[auto-evaluate-prd] Failed to schedule PRD evaluation", {
        artifactId,
        error: error instanceof Error ? error.message : String(error),
      });
    })
  );
}

async function runAutoEvaluatePrd(
  artifactId: string,
  organizationId: string,
  userId: string
): Promise<void> {
  // Guard: skip if an EVALUATE_PRD loop is already active for this artifact.
  const activeLoop = await withDb((db) =>
    db.loop.findFirst({
      where: {
        artifactId,
        organizationId,
        command: LoopCommand.EvaluatePrd,
        status: { in: ["PENDING", "CLAIMED", "RUNNING"] },
      },
      select: { id: true },
    })
  );

  if (activeLoop) {
    log.info("[auto-evaluate-prd] Skipping — active EVALUATE_PRD loop exists", {
      artifactId,
      loopId: activeLoop.id,
    });
    return;
  }

  const { loopId } = await loopsService.create(organizationId, userId, {
    command: LoopCommand.EvaluatePrd,
    artifactId,
  });

  await launchLoop(loopId, organizationId).catch((error) => {
    log.error("[auto-evaluate-prd] Failed to launch loop", {
      loopId,
      artifactId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
