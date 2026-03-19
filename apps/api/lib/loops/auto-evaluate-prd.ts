import { LoopCommand } from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { loopsService } from "@/app/loops/service";
import { launchLoop } from "./loop-orchestrator";

/**
 * Schedule an automatic EVALUATE_PRD loop for a PRD artifact via waitUntil().
 * Skips if a loop already exists for the same (artifactId, artifactVersion,
 * command) combination — the DB unique constraint makes this check atomic,
 * preventing duplicate ECS containers from concurrent calls.
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

  // Atomically create the loop only if no row exists for this
  // (artifactId, command, artifactVersion) combination. The DB unique constraint
  // on those three columns ensures two concurrent calls cannot both succeed —
  // eliminating the TOCTOU window of the old findFirst → create pattern.
  const result = await loopsService.createIfNotExists(organizationId, userId, {
    command: LoopCommand.EvaluatePrd,
    artifactId,
    artifactVersion: latestVersion,
  });

  if (!result) {
    log.info(
      "[auto-evaluate-prd] Skipping — EVALUATE_PRD loop already exists for this version",
      { artifactId, requestedVersion: latestVersion }
    );
    return;
  }

  const { loopId } = result;

  await launchLoop(loopId, organizationId).catch((error) => {
    log.error("[auto-evaluate-prd] Failed to launch loop", {
      loopId,
      artifactId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
