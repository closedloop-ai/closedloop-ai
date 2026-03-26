import { LoopCommand } from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { isConcurrentLoopLimitError, loopsService } from "@/app/loops/service";
import { resolveComputeTarget } from "./compute-target-resolver";
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
      if (isConcurrentLoopLimitError(error)) {
        log.info(
          "[auto-evaluate-prd] Skipping — concurrent loop limit reached (rate-limited background evaluation)",
          {
            artifactId,
            activeCount: error.activeCount,
            limit: error.limit,
          }
        );
        return;
      }
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

  // Fetch the user's preferred compute mode to route to local vs cloud.
  const user = await withDb((db) =>
    db.user.findUnique({
      where: { id: userId },
      select: { preferredComputeMode: true },
    })
  );

  const computeTargetResolution = await resolveComputeTarget(
    organizationId,
    userId,
    undefined,
    user?.preferredComputeMode,
    true
  );

  let computeTargetId: string | undefined;

  if (computeTargetResolution.reason === "resolved") {
    computeTargetId = computeTargetResolution.target.id;
  } else if (computeTargetResolution.reason === "cloud_resolved") {
    computeTargetId = undefined;
  } else if (computeTargetResolution.reason === "multiple_targets") {
    log.warn(
      "[auto-evaluate-prd] Multiple compute targets found, falling back to cloud",
      { userId, organizationId }
    );
    computeTargetId = undefined;
  } else {
    log.info(
      "[auto-evaluate-prd] No local compute target available, falling back to cloud",
      { reason: computeTargetResolution.reason, userId, organizationId }
    );
    computeTargetId = undefined;
  }

  // Atomically create the loop only if no row exists for this
  // (artifactId, command, artifactVersion) combination. The DB unique constraint
  // on those three columns ensures two concurrent calls cannot both succeed —
  // eliminating the TOCTOU window of the old findFirst → create pattern.
  const result = await loopsService.createIfNotExists(organizationId, userId, {
    command: LoopCommand.EvaluatePrd,
    artifactId,
    artifactVersion: latestVersion,
    computeTargetId,
  });

  if (!result) {
    log.info(
      "[auto-evaluate-prd] Skipping — EVALUATE_PRD loop already exists for this version",
      { artifactId, requestedVersion: latestVersion }
    );
    return;
  }

  const { loopId } = result;

  await launchLoop(loopId, organizationId).catch(async (error) => {
    log.error("[auto-evaluate-prd] Failed to launch loop", {
      loopId,
      artifactId,
      error: error instanceof Error ? error.message : String(error),
    });
    await loopsService.cancel(loopId, organizationId).catch((cancelError) => {
      log.error(
        "[auto-evaluate-prd] Failed to cancel orphaned loop after launch failure",
        {
          loopId,
          error:
            cancelError instanceof Error
              ? cancelError.message
              : String(cancelError),
        }
      );
    });
  });
}
