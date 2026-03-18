import { LoopCommand } from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { loopsService } from "@/app/loops/service";
import { launchLoop } from "./loop-orchestrator";

/**
 * Schedule an automatic EVALUATE_PRD loop for a PRD artifact via waitUntil().
 * Skips if an EVALUATE_PRD loop is already active for the same artifact version
 * or a newer one — prevents redundant evaluations for unchanged content.
 * When a newer version arrives while an older evaluation is in flight, a new
 * loop is created so the latest content is always evaluated.
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
  // Fetch the artifact's current version to use as the evaluation anchor.
  const artifact = await withDb((db) =>
    db.artifact.findUnique({
      where: { id: artifactId, organizationId },
      select: { latestVersion: true },
    })
  );

  if (!artifact) {
    log.warn("[auto-evaluate-prd] Artifact not found, skipping evaluation", {
      artifactId,
    });
    return;
  }

  const latestVersion = artifact.latestVersion;

  // Guard: skip if an EVALUATE_PRD loop is already active for this artifact
  // version or newer. Allows a new loop when the active loop was created for
  // an older version (version B arriving while version A's evaluation is running).
  const activeLoop = await withDb((db) =>
    db.loop.findFirst({
      where: {
        artifactId,
        organizationId,
        command: LoopCommand.EvaluatePrd,
        status: { in: ["PENDING", "CLAIMED", "RUNNING"] },
        artifactVersion: { gte: latestVersion },
      },
      select: { id: true, artifactVersion: true },
    })
  );

  if (activeLoop) {
    log.info(
      "[auto-evaluate-prd] Skipping — active EVALUATE_PRD loop exists for this version or newer",
      {
        artifactId,
        loopId: activeLoop.id,
        activeLoopVersion: activeLoop.artifactVersion,
        requestedVersion: latestVersion,
      }
    );
    return;
  }

  const { loopId } = await loopsService.create(organizationId, userId, {
    command: LoopCommand.EvaluatePrd,
    artifactId,
    artifactVersion: latestVersion,
  });

  await launchLoop(loopId, organizationId).catch((error) => {
    log.error("[auto-evaluate-prd] Failed to launch loop", {
      loopId,
      artifactId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
