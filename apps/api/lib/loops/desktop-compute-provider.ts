/**
 * Desktop compute provider — handles local (Electron) loop dispatch.
 *
 * Extracted from loop-orchestrator.ts: relay dispatch, orphaned command cleanup,
 * and desktop artifact ingestion (with re-read fallback for async race).
 */

import type { JsonObject } from "@repo/api/src/types/common";
import type { Loop } from "@repo/api/src/types/loop";
import { log } from "@repo/observability/log";
import { loopsService } from "@/app/loops/service";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import type {
  ComputeProvider,
  LaunchContext,
  LaunchResult,
  PreparedContext,
  TokenMetadata,
} from "./compute-provider";
import type { LoopCommandHandler } from "./loop-commands/loop-command-handler";
import {
  isDispatchError,
  launchLoopOnDesktop,
  stopDesktopLoop,
} from "./loop-desktop";
import { getStateKeyPrefix } from "./loop-state";

export class DesktopComputeProvider implements ComputeProvider {
  prepareContext(ctx: LaunchContext): Promise<PreparedContext> {
    // Desktop loops don't upload context to S3; this prefix scopes support artifacts.
    return Promise.resolve({
      s3StateKey: getStateKeyPrefix(ctx.organizationId, ctx.loopId),
      s3ContextKey: null,
      s3ContextUrl: null,
    });
  }

  async dispatch(
    ctx: LaunchContext,
    prepared: PreparedContext
  ): Promise<LaunchResult> {
    const commandId = await launchLoopOnDesktop({
      loopId: ctx.loopId,
      organizationId: ctx.organizationId,
      command: ctx.command,
      computeTargetId: ctx.computeTargetId!,
      desktopApiNamespace: ctx.desktopApiNamespace,
      closedLoopAuthToken: ctx.closedLoopAuthToken,
      apiBaseUrl: ctx.apiBaseUrl,
      contextPack: ctx.contextPack,
      documentSlug: ctx.documentSlug,
      parentLoopId: ctx.parentLoopId ?? undefined,
      parentBranchName: ctx.parentBranchName ?? undefined,
      parentSessionId: ctx.parentSessionId ?? undefined,
      localRepoPath: ctx.localRepoPath,
      additionalRepos: ctx.additionalRepos,
      documentId: ctx.documentId ?? undefined,
      s3StateKey: prepared.s3StateKey ?? undefined,
    });

    return { containerId: commandId, s3StateKey: prepared.s3StateKey };
  }

  async abort(
    loopId: string,
    _containerId: string,
    computeTargetId: string | null
  ): Promise<void> {
    if (computeTargetId) {
      await stopDesktopLoop(loopId, computeTargetId);
    }
  }

  onStarted(_loop: Loop): Promise<void> {
    // No secrets to scrub — desktop loops have no S3 state.
    return Promise.resolve();
  }

  getTokenMetadata(_loop: Loop): Promise<TokenMetadata | null> {
    // No S3 metadata — desktop token data comes from the event payload.
    return Promise.resolve(null);
  }

  async ingestArtifacts(
    loop: Loop,
    organizationId: string,
    handler: LoopCommandHandler
  ): Promise<void> {
    const artifacts = await resolveUploadedArtifacts(loop, organizationId);
    if (!artifacts) {
      // Skip ingestion rather than throw — the runner has already exited and
      // won't retry. Allowing the COMPLETED transition without artifacts is
      // the lesser evil.
      log.error(
        "[desktop-compute-provider] Desktop loop completed but uploadedArtifacts not found — skipping ingestion",
        { loopId: loop.id, loopStatus: loop.status }
      );
      return;
    }

    await handler.uploadAndIngest(artifacts, loop, organizationId);
  }

  async cleanupOnLaunchFailure(
    loopId: string,
    _organizationId: string,
    launchResult: Partial<LaunchResult>,
    error: unknown,
    computeTargetId: string | null
  ): Promise<void> {
    // Resolve the orphaned commandId from the launch result or DispatchError
    const orphanedCommandId =
      launchResult.containerId ??
      (isDispatchError(error) ? error.commandId : undefined);

    if (orphanedCommandId) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown launch error";
      try {
        await desktopCommandStore.markCommandExpired(
          orphanedCommandId,
          `Launch failed: ${errorMessage}`,
          computeTargetId ? { computeTargetId } : undefined
        );
      } catch (expireError) {
        log.warn(
          "[desktop-compute-provider] Failed to expire orphaned command",
          { loopId, commandId: orphanedCommandId, expireError }
        );
      }
      if (computeTargetId) {
        try {
          await stopDesktopLoop(loopId, computeTargetId);
        } catch (killError) {
          log.warn(
            "[desktop-compute-provider] Failed to stop orphaned desktop loop",
            { loopId, killError }
          );
        }
      } else {
        log.warn(
          "[desktop-compute-provider] Orphaned command expired but no computeTargetId to send kill signal",
          { loopId, commandId: orphanedCommandId }
        );
      }
    } else {
      log.warn(
        "[desktop-compute-provider] Desktop launch failed with no recoverable commandId -- orphaned command may persist",
        { loopId }
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve uploadedArtifacts, with a re-read fallback for the async race
 * where the upload-artifacts request commits after our initial loop read.
 */
async function resolveUploadedArtifacts(
  loop: Loop,
  organizationId: string
): Promise<JsonObject | null> {
  if (loop.uploadedArtifacts) {
    return loop.uploadedArtifacts;
  }
  const freshLoop = await loopsService.findById(loop.id, organizationId);
  if (freshLoop?.uploadedArtifacts) {
    log.info("[desktop-compute-provider] uploadedArtifacts found on re-read", {
      loopId: loop.id,
    });
    return freshLoop.uploadedArtifacts;
  }
  return null;
}
