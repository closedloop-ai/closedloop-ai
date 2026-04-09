/**
 * ECS compute provider — handles cloud (ECS) loop dispatch.
 *
 * Extracted from loop-orchestrator.ts: S3 context upload, ECS task launch,
 * secret scrubbing, artifact download, and launch failure cleanup.
 */

import type { Loop } from "@repo/api/src/types/loop";
import { log } from "@repo/observability/log";
import type {
  ComputeProvider,
  LaunchContext,
  LaunchResult,
  PreparedContext,
  TokenMetadata,
} from "./compute-provider";
import type { LoopCommandHandler } from "./loop-commands/loop-command-handler";
import { runEcsTask, stopLoopTask } from "./loop-ecs";
import {
  downloadMetadata,
  generateDownloadUrl,
  getStateKeyPrefix,
  scrubContextPackSecrets,
  uploadContextPack,
} from "./loop-state";

const CONTEXT_PACK_URL_TTL_SECONDS = 1800; // 30 minutes

export class EcsComputeProvider implements ComputeProvider {
  async prepareContext(ctx: LaunchContext): Promise<PreparedContext> {
    const s3StateKey = getStateKeyPrefix(ctx.organizationId, ctx.loopId);
    const s3ContextKey = await uploadContextPack(s3StateKey, ctx.contextPack);
    const s3ContextUrl = await generateDownloadUrl(
      s3ContextKey,
      CONTEXT_PACK_URL_TTL_SECONDS
    );

    return { s3StateKey, s3ContextKey, s3ContextUrl };
  }

  async dispatch(
    ctx: LaunchContext,
    prepared: PreparedContext
  ): Promise<LaunchResult> {
    const taskArn = await runEcsTask({
      loopId: ctx.loopId,
      organizationId: ctx.organizationId,
      command: ctx.command,
      s3StateKey: prepared.s3StateKey!,
      s3ContextKey: prepared.s3ContextKey!,
      s3ContextUrl: prepared.s3ContextUrl!,
      repo: ctx.repo ?? undefined,
      closedLoopAuthToken: ctx.closedLoopAuthToken,
      artifactId: ctx.artifactId ?? undefined,
      parentS3StateKey: ctx.parentS3StateKey ?? undefined,
      parentSessionId: ctx.parentSessionId ?? undefined,
      parentBranchName: ctx.parentBranchName ?? undefined,
    });

    return { containerId: taskArn, s3StateKey: prepared.s3StateKey };
  }

  async abort(
    _loopId: string,
    containerId: string,
    _computeTargetId: string | null
  ): Promise<void> {
    await stopLoopTask(containerId, "Loop cancelled");
  }

  async onStarted(loop: Loop): Promise<void> {
    if (!loop.s3StateKey) {
      return;
    }
    await scrubContextPackSecrets(loop.s3StateKey);
  }

  getTokenMetadata(loop: Loop): Promise<TokenMetadata | null> {
    if (!loop.s3StateKey) {
      return Promise.resolve(null);
    }
    return downloadMetadata(loop.s3StateKey);
  }

  async ingestArtifacts(
    loop: Loop,
    organizationId: string,
    handler: LoopCommandHandler
  ): Promise<void> {
    if (!loop.s3StateKey) {
      return;
    }
    await handler.downloadAndIngest(loop.s3StateKey, loop, organizationId);
  }

  async cleanupOnLaunchFailure(
    loopId: string,
    _organizationId: string,
    launchResult: Partial<LaunchResult>,
    _error: unknown,
    _computeTargetId: string | null
  ): Promise<void> {
    if (launchResult.s3StateKey) {
      try {
        await scrubContextPackSecrets(launchResult.s3StateKey);
      } catch (scrubError) {
        log.error(
          "[ecs-compute-provider] Failed to scrub context-pack secrets after launch failure",
          {
            loopId,
            s3StateKey: launchResult.s3StateKey,
            error:
              scrubError instanceof Error
                ? scrubError.message
                : String(scrubError),
          }
        );
      }
    }

    if (launchResult.containerId) {
      try {
        await stopLoopTask(
          launchResult.containerId,
          "Launch failed after task start"
        );
        log.info("[ecs-compute-provider] Stopped orphaned ECS task", {
          loopId,
          taskArn: launchResult.containerId,
        });
      } catch (stopError) {
        log.error("[ecs-compute-provider] Failed to stop orphaned ECS task", {
          loopId,
          taskArn: launchResult.containerId,
          stopError,
        });
      }
    }
  }
}
