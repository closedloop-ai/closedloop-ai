import type {
  LoopEvent,
  LoopEventCompleted,
  TokensByModel,
} from "@repo/api/src/types/loop";
import {
  LoopCommand,
  LoopStatus,
  MODEL_PRICING,
} from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { getInstallationAccessToken } from "@repo/github";
import { log } from "@repo/observability/log";
import { getCommitterInfo } from "@/app/artifacts/service";
import { githubService } from "@/app/integrations/github/service";
import {
  isInvalidStatusTransitionError,
  loopsService,
} from "@/app/loops/service";
import { apiKeyService } from "@/app/settings/api-key-service";
import { issueLoopRunnerToken } from "@/lib/auth/loop-runner-jwt";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { getCommandHandler } from "./loop-commands";
import {
  buildContextPack,
  buildContextPackInMemory,
} from "./loop-context-pack";
import {
  isDispatchError,
  launchLoopOnDesktop,
  stopDesktopLoop,
} from "./loop-desktop";
import { runEcsTask, stopLoopTask } from "./loop-ecs";
import {
  downloadMetadata,
  generateDownloadUrl,
  getStateKeyPrefix,
  scrubContextPackSecrets,
} from "./loop-state";

type RunnerReplayContext = {
  tokenJti: string;
  nonce: string;
};

// ---------------------------------------------------------------------------
// Key resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the Anthropic API key for the loop owner.
 * Priority: user key > org key > throw.
 */
async function resolveAnthropicApiKey(
  userId: string,
  organizationId: string
): Promise<string> {
  const key = await apiKeyService.resolveApiKey(userId, organizationId);
  if (!key) {
    throw new Error(
      "No Anthropic API key configured. Set a key at the user or organization level."
    );
  }
  return key;
}

/**
 * Generate a short-lived GitHub installation access token for a target repo.
 * Looks up the org's GitHub App installation, then creates an installation token
 * scoped to the target repository.
 */
export async function resolveGitHubToken(
  organizationId: string,
  repoFullName: string
): Promise<string> {
  // Find the GitHub App installation ID for this repo + org
  const installationId = await githubService.findInstallationForRepoFullName(
    organizationId,
    repoFullName
  );

  if (!installationId) {
    throw new Error(
      `No GitHub App installation found for repo "${repoFullName}" in this organization. ` +
        "Install the GitHub App and grant access to this repository."
    );
  }

  // Generate a short-lived installation access token via the @repo/github package
  return getInstallationAccessToken(installationId);
}

/**
 * When launching a child loop (resume), resolve the parent's state info
 * so the container can download prior run state and continue from where
 * the parent left off.
 */
async function resolveParentLoopInfo(
  parentLoopId: string,
  organizationId: string
): Promise<
  | {
      s3StateKey: string | null;
      sessionId: string | null;
      branchName: string | null;
    }
  | undefined
> {
  const parent = await loopsService.findById(parentLoopId, organizationId);
  if (!parent) {
    log.warn("[loop-orchestrator] Parent loop not found", { parentLoopId });
    return undefined;
  }
  if (!(parent.s3StateKey || parent.computeTargetId)) {
    log.warn(
      "[loop-orchestrator] Parent loop has no s3StateKey or computeTargetId",
      { parentLoopId }
    );
    return undefined;
  }
  return {
    s3StateKey: parent.s3StateKey ?? null,
    sessionId: parent.sessionId ?? null,
    branchName: parent.branchName ?? null,
  };
}

// ---------------------------------------------------------------------------
// Cost calculation
// ---------------------------------------------------------------------------

/**
 * Calculate estimated cost from per-model token breakdown.
 * Falls back to default (Opus) pricing if no model breakdown is available.
 */
function calculateCost(
  tokensInput: number,
  tokensOutput: number,
  tokensByModel: TokensByModel | null
): number {
  if (!tokensByModel || Object.keys(tokensByModel).length === 0) {
    const fallback = MODEL_PRICING.default;
    return (
      (tokensInput / 1_000_000) * fallback.input +
      (tokensOutput / 1_000_000) * fallback.output
    );
  }

  let totalCost = 0;
  for (const [model, usage] of Object.entries(tokensByModel)) {
    // Match model name to pricing — try exact match, then prefix match, then default.
    // Use startsWith (not includes) to avoid false matches like "opus-4" matching "opus-4-5".
    // Exclude "default" from prefix matching to prevent it from matching model names.
    const pricing =
      MODEL_PRICING[model] ??
      Object.entries(MODEL_PRICING)
        .filter(([key]) => key !== "default")
        .find(([key]) => model.startsWith(key))?.[1] ??
      MODEL_PRICING.default;

    // Include cache tokens in cost calculation:
    // - cacheCreation tokens are billed at the input rate
    // - cacheRead tokens are billed at ~10% of input rate
    const cacheCreationCost =
      ((usage.cacheCreation ?? 0) / 1_000_000) * pricing.input;
    const cacheReadCost =
      ((usage.cacheRead ?? 0) / 1_000_000) * pricing.input * 0.1;

    totalCost +=
      (usage.input / 1_000_000) * pricing.input +
      (usage.output / 1_000_000) * pricing.output +
      cacheCreationCost +
      cacheReadCost;
  }
  return totalCost;
}

// ---------------------------------------------------------------------------
// Launch lifecycle helpers
// ---------------------------------------------------------------------------

async function getPendingLoopOrThrow(
  loopId: string,
  organizationId: string
): Promise<NonNullable<Awaited<ReturnType<typeof loopsService.findById>>>> {
  const loop = await loopsService.findById(loopId, organizationId);
  if (!loop) {
    throw new Error(`Loop not found: ${loopId}`);
  }
  if (loop.status !== LoopStatus.Pending) {
    throw new Error(
      `Cannot launch loop in ${loop.status} status. Only PENDING loops can be launched.`
    );
  }
  return loop;
}

/**
 * Scrub S3 context pack secrets in the runner-race path.
 * Skipped for desktop loops (no S3 state key).
 */
async function tryScrubSecretsInRacePath(
  loopId: string,
  organizationId: string,
  s3StateKey: string | null
): Promise<void> {
  if (!s3StateKey) {
    return;
  }
  try {
    await scrubContextPackSecrets(s3StateKey);
  } catch (scrubError) {
    log.error(
      "[loop-orchestrator] Failed to scrub secrets in runner-race path",
      {
        loopId,
        s3StateKey,
        error:
          scrubError instanceof Error ? scrubError.message : String(scrubError),
      }
    );
    await recordScrubFailureWarning(loopId, organizationId);
  }
}

async function claimOrPersistRunning(
  loopId: string,
  organizationId: string,
  taskArn: string,
  s3StateKey: string | null
): Promise<void> {
  try {
    await loopsService.updateStatus(
      loopId,
      organizationId,
      LoopStatus.Claimed,
      {
        containerId: taskArn,
        s3StateKey: s3StateKey ?? undefined,
      }
    );
    return;
  } catch (claimError) {
    if (isInvalidStatusTransitionError(claimError)) {
      const currentLoop = await loopsService.findById(loopId, organizationId);
      if (currentLoop?.status === LoopStatus.Running) {
        await loopsService.persistLaunchInfo(loopId, organizationId, {
          containerId: taskArn,
          s3StateKey: s3StateKey ?? undefined,
        });
        await tryScrubSecretsInRacePath(loopId, organizationId, s3StateKey);
        log.info(
          "[loop-orchestrator] Loop already RUNNING (runner raced ahead), persisted launch info",
          { loopId, taskArn }
        );
        return;
      }
    }
    throw claimError;
  }
}

async function stopOrphanedTaskIfNeeded(
  taskArn: string | undefined,
  loopId: string
): Promise<void> {
  if (!taskArn) {
    return;
  }

  try {
    await stopLoopTask(taskArn, "Launch failed after task start");
    log.info("[loop-orchestrator] Stopped orphaned ECS task", {
      loopId,
      taskArn,
    });
  } catch (stopError) {
    log.error("[loop-orchestrator] Failed to stop orphaned ECS task", {
      loopId,
      taskArn,
      stopError,
    });
  }
}

/**
 * Expire an orphaned desktop command and send a kill signal.
 * Called when launchLoopDesktop fails after a command was created.
 */
async function cleanupOrphanedDesktopCommand(
  orphanedCommandId: string,
  loopId: string,
  computeTargetId: string,
  errorMessage: string
): Promise<void> {
  try {
    await desktopCommandStore.markCommandExpired(
      orphanedCommandId,
      `Launch failed: ${errorMessage}`
    );
  } catch (expireError) {
    log.warn("[loop-orchestrator] Failed to expire orphaned command", {
      loopId,
      commandId: orphanedCommandId,
      expireError,
    });
  }
  try {
    await stopDesktopLoop(loopId, computeTargetId);
  } catch (killError) {
    log.warn("[loop-orchestrator] Failed to stop orphaned desktop loop", {
      loopId,
      killError,
    });
  }
}

async function cancelLoopAfterLaunchFailure(
  loopId: string,
  organizationId: string
): Promise<void> {
  try {
    await loopsService.cancel(loopId, organizationId);
  } catch (cancelError) {
    if (isInvalidStatusTransitionError(cancelError)) {
      log.warn(
        "[loop-orchestrator] Cancel-after-launch-failure skipped — loop already in terminal status (cancel-after-complete race)",
        { loopId }
      );
    } else {
      log.error(
        "[loop-orchestrator] Failed to cancel loop after launch error",
        {
          loopId,
          cancelError,
        }
      );
    }
  }
}

async function recordScrubFailureWarning(
  loopId: string,
  organizationId: string
): Promise<void> {
  try {
    await loopsService.addEvent(loopId, organizationId, {
      type: "security_warning",
      data: {
        code: "CONTEXT_PACK_SECRET_SCRUB_FAILED",
        message:
          "Failed to scrub context-pack secrets after loop start. Secrets may persist in S3 until cleanup succeeds.",
        timestamp: new Date().toISOString(),
      },
    });
  } catch (auditError) {
    log.error(
      "[loop-orchestrator] Failed to persist scrub-failure security warning",
      {
        loopId,
        error:
          auditError instanceof Error ? auditError.message : String(auditError),
      }
    );
  }
}

// ---------------------------------------------------------------------------
// ECS task launch
// ---------------------------------------------------------------------------

/**
 * Resolve shared launch context needed by both ECS and desktop paths.
 */
async function resolveLoopLaunchContext(
  loop: NonNullable<Awaited<ReturnType<typeof loopsService.findById>>>,
  organizationId: string,
  options?: { skipSecrets?: boolean }
) {
  // Desktop loops don't need server-side secrets — the electron has its own
  // Anthropic API key and gh CLI auth locally.
  const anthropicApiKey = options?.skipSecrets
    ? undefined
    : await resolveAnthropicApiKey(loop.userId, organizationId);

  let githubToken: string | undefined;
  if (!options?.skipSecrets && loop.repo?.fullName) {
    githubToken = await resolveGitHubToken(organizationId, loop.repo.fullName);
  }

  const committerInfo = await getCommitterInfo(loop.userId);
  const committer = committerInfo
    ? {
        name: committerInfo.committerName,
        email: committerInfo.committerEmail,
      }
    : undefined;

  const closedLoopAuthToken = await issueLoopRunnerToken({
    loopId: loop.id,
    organizationId,
  });

  const parentInfo = loop.parentLoopId
    ? await resolveParentLoopInfo(loop.parentLoopId, organizationId)
    : undefined;

  return {
    anthropicApiKey,
    githubToken,
    committer,
    closedLoopAuthToken,
    parentInfo,
  };
}

/**
 * Launch a Loop — dispatches to either ECS (cloud) or desktop (local)
 * based on the loop's computeTargetId.
 *
 * @returns The ECS task ARN or desktop command ID
 */
export async function launchLoop(
  loopId: string,
  organizationId: string
): Promise<string> {
  const loop = await getPendingLoopOrThrow(loopId, organizationId);

  log.info("[loop-orchestrator] Launching loop", {
    loopId,
    command: loop.command,
    repo: loop.repo,
    hasArtifact: !!loop.artifactId,
    hasParent: !!loop.parentLoopId,
    computeTargetId: loop.computeTargetId,
  });

  // Desktop path: dispatch to electron via desktop gateway
  if (loop.computeTargetId) {
    return launchLoopDesktop(loopId, organizationId, loop);
  }

  // ECS path: launch as container task
  return launchLoopEcs(loopId, organizationId, loop);
}

/**
 * Launch a loop on a desktop compute target.
 * Builds the context pack in memory (no S3) and dispatches via gateway.
 */
async function launchLoopDesktop(
  loopId: string,
  organizationId: string,
  loop: NonNullable<Awaited<ReturnType<typeof loopsService.findById>>>
): Promise<string> {
  let commandId: string | undefined;
  try {
    const ctx = await resolveLoopLaunchContext(loop, organizationId, {
      skipSecrets: true,
    });

    // Build context pack in memory (no S3 upload)
    const contextPack = await buildContextPackInMemory(
      loop,
      organizationId,
      { anthropicApiKey: ctx.anthropicApiKey, githubToken: ctx.githubToken },
      ctx.committer
    );

    // Resolve API base URL for the electron to call back
    const apiBaseUrl =
      process.env.API_BASE_URL ?? process.env.LOOP_CALLBACK_URL;
    if (!apiBaseUrl) {
      throw new Error(
        "Cannot launch desktop loop: neither API_BASE_URL nor LOOP_CALLBACK_URL is set"
      );
    }

    // Resolve artifact slug for worktree/branch naming on desktop.
    // All loops for the same artifact share a single worktree keyed by slug
    // (e.g., symphony/PLAN-5), so PLAN → REQUEST_CHANGES → EXECUTE all reuse it.
    let artifactSlug: string | undefined;
    if (loop.artifactId) {
      const artifact = await withDb((db) =>
        db.artifact.findUnique({
          where: { id: loop.artifactId!, organizationId },
          select: { slug: true },
        })
      );
      artifactSlug = artifact?.slug;
    }

    const localRepoPath =
      typeof loop.metadata?.localRepoPath === "string"
        ? loop.metadata.localRepoPath
        : undefined;

    commandId = await launchLoopOnDesktop({
      loopId,
      organizationId,
      command: loop.command,
      computeTargetId: loop.computeTargetId!,
      closedLoopAuthToken: ctx.closedLoopAuthToken,
      apiBaseUrl,
      contextPack,
      artifactSlug,
      parentLoopId: loop.parentLoopId ?? undefined,
      parentBranchName: ctx.parentInfo?.branchName ?? undefined,
      parentSessionId: ctx.parentInfo?.sessionId ?? undefined,
      localRepoPath,
    });

    // Use commandId as containerId for desktop loops, null s3StateKey
    await claimOrPersistRunning(loopId, organizationId, commandId, null);

    log.info("[loop-orchestrator] Desktop loop launched", {
      loopId,
      commandId,
      computeTargetId: loop.computeTargetId,
    });

    return commandId;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown launch error";
    log.error("[loop-orchestrator] Failed to launch desktop loop", {
      loopId,
      error: errorMessage,
    });
    // Expire the command record so it won't be replayed on reconnect
    const orphanedCommandId =
      commandId ?? (isDispatchError(error) ? error.commandId : undefined);
    if (orphanedCommandId) {
      await cleanupOrphanedDesktopCommand(
        orphanedCommandId,
        loopId,
        loop.computeTargetId!,
        errorMessage
      );
    } else {
      log.warn(
        "[loop-orchestrator] Desktop launch failed with no recoverable commandId -- orphaned command may persist",
        { loopId, errorType: describeErrorType(error) }
      );
    }
    await cancelLoopAfterLaunchFailure(loopId, organizationId);
    throw error;
  }
}

/**
 * Launch a loop as an ECS task via EC2 capacity provider.
 * Original cloud path — builds context pack, uploads to S3, launches ECS task.
 */
async function launchLoopEcs(
  loopId: string,
  organizationId: string,
  loop: NonNullable<Awaited<ReturnType<typeof loopsService.findById>>>
): Promise<string> {
  let taskArn: string | undefined;
  let s3StateKey: string | undefined;

  try {
    const ctx = await resolveLoopLaunchContext(loop, organizationId);

    // Build context pack and upload to S3
    s3StateKey = getStateKeyPrefix(organizationId, loopId);
    const s3ContextKey = await buildContextPack(
      loop,
      organizationId,
      s3StateKey,
      { anthropicApiKey: ctx.anthropicApiKey, githubToken: ctx.githubToken },
      ctx.committer
    );

    // Generate pre-signed GET URL for context pack
    const CONTEXT_PACK_URL_TTL_SECONDS = 1800; // 30 minutes
    const s3ContextUrl = await generateDownloadUrl(
      s3ContextKey,
      CONTEXT_PACK_URL_TTL_SECONDS
    );

    // Launch ECS task
    taskArn = await runEcsTask({
      loopId,
      organizationId,
      command: loop.command,
      s3StateKey,
      s3ContextKey,
      s3ContextUrl,
      repo: loop.repo ?? undefined,
      closedLoopAuthToken: ctx.closedLoopAuthToken,
      artifactId: loop.artifactId ?? undefined,
      parentS3StateKey: ctx.parentInfo?.s3StateKey ?? undefined,
      parentSessionId: ctx.parentInfo?.sessionId ?? undefined,
      parentBranchName: ctx.parentInfo?.branchName ?? undefined,
    });

    // Update loop status to CLAIMED
    await claimOrPersistRunning(loopId, organizationId, taskArn, s3StateKey);

    log.info("[loop-orchestrator] ECS loop launched", {
      loopId,
      taskArn,
    });

    return taskArn;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown launch error";

    log.error("[loop-orchestrator] Failed to launch ECS loop", {
      loopId,
      error: errorMessage,
    });

    if (s3StateKey) {
      try {
        await scrubContextPackSecrets(s3StateKey);
      } catch (scrubError) {
        log.error(
          "[loop-orchestrator] Failed to scrub context-pack secrets after launch failure",
          {
            loopId,
            s3StateKey,
            error:
              scrubError instanceof Error
                ? scrubError.message
                : String(scrubError),
          }
        );
      }
    }

    await stopOrphanedTaskIfNeeded(taskArn, loopId);
    await cancelLoopAfterLaunchFailure(loopId, organizationId);

    throw error;
  }
}

// ---------------------------------------------------------------------------
// Event handling (called by harness callback endpoint)
// ---------------------------------------------------------------------------

/**
 * Process an event received from the container harness.
 *
 * Event types:
 * - "started": Transition loop to RUNNING
 * - "output" / "progress" / "tool_call" / "artifact_created": Store as LoopEvent
 * - "completed": Download metadata from S3, update token counts, mark COMPLETED
 * - "error": Mark loop as FAILED with error details
 */
export async function handleLoopEvent(
  loopId: string,
  organizationId: string,
  event: LoopEvent,
  replayContext?: RunnerReplayContext
): Promise<LoopEvent[]> {
  log.info("[loop-orchestrator] Handling loop event", {
    loopId,
    eventType: event.type,
  });

  switch (event.type) {
    case "started": {
      // Extract sessionId if present on the started event
      const startedData = event as Record<string, unknown>;
      const startSessionId =
        typeof startedData.sessionId === "string"
          ? startedData.sessionId
          : undefined;

      await loopsService.updateStatus(
        loopId,
        organizationId,
        LoopStatus.Running,
        {
          startedAt: new Date(),
          ...(startSessionId ? { sessionId: startSessionId } : {}),
        }
      );
      await loopsService.addEvent(
        loopId,
        organizationId,
        {
          type: event.type,
          data: { loopId: event.loopId, timestamp: event.timestamp },
        },
        replayContext
      );
      // Scrub secrets from the S3 context pack now that the container is running.
      // The container has already consumed the secrets at this point.
      // This is a critical security step — do not silently swallow errors.
      const loop = await loopsService.findById(loopId, organizationId);
      if (loop?.s3StateKey) {
        try {
          await scrubContextPackSecrets(loop.s3StateKey);
        } catch (scrubError) {
          log.error(
            "[loop-orchestrator] Failed to scrub secrets from context pack — secrets may still be in S3",
            {
              loopId,
              s3StateKey: loop.s3StateKey,
              error:
                scrubError instanceof Error
                  ? scrubError.message
                  : String(scrubError),
            }
          );
          await recordScrubFailureWarning(loopId, organizationId);
        }
      }
      return [event];
    }

    case "output": {
      await loopsService.addEvent(
        loopId,
        organizationId,
        {
          type: event.type,
          data: { chunk: event.chunk, timestamp: event.timestamp },
        },
        replayContext
      );
      return [event];
    }

    case "progress": {
      await loopsService.addEvent(
        loopId,
        organizationId,
        {
          type: event.type,
          data: {
            percent: event.percent,
            stage: event.stage,
            timestamp: event.timestamp,
          },
        },
        replayContext
      );
      return [event];
    }

    case "tool_call": {
      await loopsService.addEvent(
        loopId,
        organizationId,
        {
          type: event.type,
          data: {
            tool: event.tool,
            status: event.status,
            input: event.input,
            output: event.output,
            timestamp: event.timestamp,
          } as Record<string, unknown>,
        },
        replayContext
      );
      return [event];
    }

    case "artifact_created": {
      await loopsService.addEvent(
        loopId,
        organizationId,
        {
          type: event.type,
          data: {
            artifactId: event.artifactId,
            artifactType: event.artifactType,
            timestamp: event.timestamp,
          },
        },
        replayContext
      );
      return [event];
    }

    case "completed": {
      return handleLoopCompleted(loopId, organizationId, event, replayContext);
    }

    case "error": {
      return handleLoopError(loopId, organizationId, event, replayContext);
    }

    default: {
      // Store unknown event types for forward compatibility
      await loopsService.addEvent(
        loopId,
        organizationId,
        {
          type: (event as LoopEvent).type,
          data: event as unknown as Record<string, unknown>,
        },
        replayContext
      );
      return [event];
    }
  }
}

/**
 * Ingest loop artifacts from the appropriate source (DB upload or S3).
 * Throws if a desktop loop is missing uploadedArtifacts.
 */
async function ingestLoopArtifacts(
  loop: NonNullable<Awaited<ReturnType<typeof loopsService.findById>>>,
  organizationId: string
): Promise<void> {
  if (!loop.artifactId) {
    return;
  }
  if (!(loop.s3StateKey || loop.computeTargetId)) {
    return;
  }

  const handler = getCommandHandler(loop.command);
  if (!handler) {
    return;
  }

  if (loop.computeTargetId && loop.uploadedArtifacts) {
    await handler.uploadAndIngest(loop.uploadedArtifacts, loop, organizationId);
  } else if (loop.computeTargetId) {
    // uploadedArtifacts missing — re-read in case the upload-artifacts request
    // committed after our initial read.
    const freshLoop = await loopsService.findById(loop.id, organizationId);
    if (freshLoop?.uploadedArtifacts) {
      log.info("[loop-orchestrator] uploadedArtifacts found on re-read", {
        loopId: loop.id,
      });
      await handler.uploadAndIngest(
        freshLoop.uploadedArtifacts,
        freshLoop,
        organizationId
      );
    } else {
      // Skip ingestion rather than throw. Throwing would leave the loop in
      // TIMED_OUT/FAILED permanently with no recovery path — the runner has
      // already exited and won't retry. Allowing the COMPLETED transition
      // without artifacts is the lesser evil: the loop shows as completed
      // (matching reality — the runner finished) even if the plan content
      // wasn't ingested. The upload-artifacts endpoint no longer filters by
      // status, so this path should only trigger if the upload itself failed.
      log.error(
        "[loop-orchestrator] Desktop loop completed but uploadedArtifacts not found — skipping ingestion",
        {
          loopId: loop.id,
          loopStatus: loop.status,
        }
      );
    }
  } else if (loop.s3StateKey) {
    await handler.downloadAndIngest(loop.s3StateKey, loop, organizationId);
  }
}

/**
 * Handle loop completion: download metadata from S3, update token counts.
 * Returns the canonical event(s) to publish via SSE.
 */
async function handleLoopCompleted(
  loopId: string,
  organizationId: string,
  event: LoopEventCompleted,
  replayContext?: RunnerReplayContext
): Promise<LoopEvent[]> {
  // Try to download metadata from S3 for detailed token counts
  const loop = await loopsService.findById(loopId, organizationId);
  const metadata = loop?.s3StateKey
    ? await downloadMetadata(loop.s3StateKey)
    : null;

  // Use the event's token pair as an atomic unit when both fields are numeric
  // (including zeros). Only fall back to the metadata pair if the event pair is
  // absent/invalid. Never mix input from one source and output from another.
  const hasEventTokens =
    typeof event.tokensUsed?.input === "number" &&
    typeof event.tokensUsed?.output === "number";
  const tokensInput = hasEventTokens
    ? event.tokensUsed!.input
    : (metadata?.tokensInput ?? 0);
  const tokensOutput = hasEventTokens
    ? event.tokensUsed!.output
    : (metadata?.tokensOutput ?? 0);
  const tokensByModel: TokensByModel | null =
    event.tokensByModel ?? metadata?.tokensByModel ?? null;

  // Calculate cost per model if we have breakdown, otherwise fall back to Opus pricing
  const estimatedCost = calculateCost(tokensInput, tokensOutput, tokensByModel);

  // Guard: EXECUTE loops that completed with 0/0 tokens did no work.
  // Convert to a NO_WORK_PRODUCED error instead of accepting as success.
  if (
    loop?.command === LoopCommand.Execute &&
    tokensInput === 0 &&
    tokensOutput === 0
  ) {
    return handleZeroTokenExecute(
      loopId,
      organizationId,
      loop,
      event,
      replayContext
    );
  }

  // Extract PR info + session ID from event.result
  const prSession = extractPrSessionInfo(
    event as unknown as Record<string, unknown>
  );

  // Log when the runner reports success but the loop was already marked terminal.
  // The status machine allows TIMED_OUT/FAILED → COMPLETED because the runner
  // is ground truth for whether work actually finished.
  if (
    loop &&
    loop.status !== LoopStatus.Running &&
    loop.status !== LoopStatus.Claimed
  ) {
    log.info("[loop-orchestrator] Completed event overriding terminal status", {
      loopId,
      previousStatus: loop.status,
    });
  }

  // Ingest artifacts BEFORE marking the loop as COMPLETED.
  // If ingestion fails, the loop stays in its current status (e.g., RUNNING)
  // so the completed event can be replayed. Once a loop is COMPLETED the
  // status transition is irreversible, leaving no recovery path for the artifact.
  if (loop) {
    await ingestLoopArtifacts(loop, organizationId);
  }

  // Transition status after ingestion succeeds.
  // Clear stale error details when overriding a TIMED_OUT, FAILED, or CANCELLED status so the
  // loop detail page doesn't render a failure banner on a successfully recovered loop.
  // isOverridingFailure is derived from a pre-updateStatus read -- it is advisory only;
  // the atomic updateStatus WHERE clause is the authoritative gate for the transition.
  const isOverridingFailure =
    loop &&
    (loop.status === LoopStatus.TimedOut ||
      loop.status === LoopStatus.Failed ||
      loop.status === LoopStatus.Cancelled);
  if (isOverridingFailure) {
    log.warn(
      "[loop-orchestrator] Overriding terminal status to COMPLETED, clearing stale error",
      {
        loopId: loop.id,
        previousStatus: loop.status,
      }
    );
  }
  await loopsService.updateStatus(
    loopId,
    organizationId,
    LoopStatus.Completed,
    {
      completedAt: new Date(),
      tokensInput,
      tokensOutput,
      tokensByModel: tokensByModel ?? undefined,
      estimatedCost,
      ...(isOverridingFailure ? { error: null } : {}),
      ...prSession,
    }
  );

  // Persist the completion event only after transition succeeds
  await loopsService.addEvent(
    loopId,
    organizationId,
    {
      type: event.type,
      data: {
        result: event.result,
        tokensUsed: event.tokensUsed ?? null,
        timestamp: event.timestamp,
      } as Record<string, unknown>,
    },
    replayContext
  );

  log.info("[loop-orchestrator] Loop completed", {
    loopId,
    tokensInput,
    tokensOutput,
    tokensByModel,
    estimatedCost,
    ...prSession,
  });
  return [event];
}

/**
 * Extract PR and session info from an event's result field or top-level fields.
 * The harness agent attaches these to completed, error, and timed-out events.
 *
 * For completed events, PR info is nested under `result`.
 * For error/timed-out events, PR info may be at the top level (no `result` field).
 * We check both locations to avoid silently dropping PR/branch info on failures.
 */
function extractPrSessionInfo(event: Record<string, unknown>): {
  prUrl?: string;
  prNumber?: number;
  branchName?: string;
  sessionId?: string;
} {
  const result = (event.result as Record<string, unknown>) ?? {};

  // Check result first (completed events), then fall back to top-level (error events).
  // Helper avoids nested ternaries that Biome flags.
  function pickString(field: string): string | undefined {
    if (typeof result[field] === "string") {
      return result[field];
    }
    if (typeof event[field] === "string") {
      return event[field];
    }
    return undefined;
  }
  function pickNumber(field: string): number | undefined {
    if (typeof result[field] === "number") {
      return result[field];
    }
    if (typeof event[field] === "number") {
      return event[field];
    }
    return undefined;
  }

  return {
    prUrl: pickString("prUrl"),
    prNumber: pickNumber("prNumber"),
    branchName: pickString("branchName"),
    sessionId: pickString("sessionId"),
  };
}

/**
 * Handle loop error: mark as FAILED with error details.
 */
async function handleLoopError(
  loopId: string,
  organizationId: string,
  event: { type: "error"; code: string; message: string; timestamp: string },
  replayContext?: RunnerReplayContext
): Promise<LoopEvent[]> {
  if (event.code === "CANCELLED") {
    const canonicalEvent = {
      type: "cancelled" as const,
      reason: event.message,
      timestamp: event.timestamp,
    };

    await loopsService.addEvent(
      loopId,
      organizationId,
      {
        type: "cancelled",
        data: {
          reason: event.message,
          timestamp: event.timestamp,
        },
      },
      replayContext
    );

    const loop = await loopsService.findById(loopId, organizationId);
    if (loop && loop.status !== LoopStatus.Cancelled) {
      await loopsService.updateStatus(
        loopId,
        organizationId,
        LoopStatus.Cancelled,
        {
          completedAt: new Date(),
        }
      );
    }

    log.info("[loop-orchestrator] Loop cancelled", {
      loopId,
      reason: event.message,
    });
    return [canonicalEvent as unknown as LoopEvent];
  }

  if (event.code === "TIMED_OUT") {
    const prSession = extractPrSessionInfo(event as Record<string, unknown>);

    await loopsService.updateStatus(
      loopId,
      organizationId,
      LoopStatus.TimedOut,
      {
        completedAt: new Date(),
        error: { code: event.code, message: event.message },
        ...prSession,
      }
    );

    await loopsService.addEvent(
      loopId,
      organizationId,
      {
        type: event.type,
        data: {
          code: event.code,
          message: event.message,
          timestamp: event.timestamp,
        },
      },
      replayContext
    );

    log.info("[loop-orchestrator] Loop timed out", {
      loopId,
      message: event.message,
    });
    return [event as unknown as LoopEvent];
  }

  // Structured error codes from electron/runner with specific log levels.
  // Both map to LoopStatus.Failed -- no new status enum needed.
  if (event.code === "CONTEXT_LIMIT_EXCEEDED") {
    log.warn("[loop-orchestrator] Loop hit context limit", {
      loopId,
      message: event.message,
    });
  } else if (event.code === "NO_WORK_PRODUCED") {
    log.error("[loop-orchestrator] Loop produced no work", {
      loopId,
      message: event.message,
    });
  }

  // Extract PR/session info from error event (harness includes these even on failure)
  const prSession = extractPrSessionInfo(event as Record<string, unknown>);

  await loopsService.updateStatus(loopId, organizationId, LoopStatus.Failed, {
    completedAt: new Date(),
    error: { code: event.code, message: event.message },
    ...prSession,
  });

  // Persist the error event only after transition succeeds
  await loopsService.addEvent(
    loopId,
    organizationId,
    {
      type: event.type,
      data: {
        code: event.code,
        message: event.message,
        timestamp: event.timestamp,
      },
    },
    replayContext
  );

  // Skip generic log for codes that already logged above
  if (
    event.code !== "CONTEXT_LIMIT_EXCEEDED" &&
    event.code !== "NO_WORK_PRODUCED"
  ) {
    log.error("[loop-orchestrator] Loop failed", {
      loopId,
      errorCode: event.code,
      errorMessage: event.message,
    });
  }

  return [event as unknown as LoopEvent];
}

/**
 * Describe the error type for structured logging.
 * Returns the constructor name for Error subclasses, or the typeof for non-Error values.
 */
function describeErrorType(error: unknown): string {
  if (error instanceof Error) {
    return error.constructor.name;
  }
  return typeof error;
}

/**
 * Handle an EXECUTE loop that completed with 0/0 tokens (ghost loop).
 * Converts the completion into a NO_WORK_PRODUCED error event.
 *
 * Only persists the error event when updateStatus(FAILED) succeeds.
 * Returns [] for terminal or race cases to avoid confusing the frontend.
 */
async function handleZeroTokenExecute(
  loopId: string,
  organizationId: string,
  loop:
    | NonNullable<Awaited<ReturnType<typeof loopsService.findById>>>
    | null
    | undefined,
  event: LoopEventCompleted,
  replayContext?: RunnerReplayContext
): Promise<LoopEvent[]> {
  const errorEvent: LoopEvent = {
    type: "error",
    code: "NO_WORK_PRODUCED",
    message: "EXECUTE loop completed with 0 tokens -- no work was done",
    timestamp: event.timestamp,
  };

  // Pre-read loop status to avoid appending error events to already-terminal loops
  const terminalStatuses = new Set<string>([
    LoopStatus.Completed,
    LoopStatus.Failed,
    LoopStatus.Cancelled,
    LoopStatus.TimedOut,
  ]);

  if (!loop || terminalStatuses.has(loop.status)) {
    log.info(
      "[loop-orchestrator] Skipping NO_WORK_PRODUCED -- loop already terminal",
      { loopId, status: loop?.status }
    );
    return [];
  }

  // Attempt transition to FAILED. If another event raced to terminal, catch and return [].
  try {
    await loopsService.updateStatus(loopId, organizationId, LoopStatus.Failed, {
      completedAt: new Date(),
      error: { code: "NO_WORK_PRODUCED", message: errorEvent.message },
    });
  } catch (err) {
    if (isInvalidStatusTransitionError(err)) {
      // Only swallow when the source status is terminal (another event raced
      // to completion). Re-throw for non-terminal source statuses (e.g.,
      // PENDING -> FAILED is invalid) so the runner can retry.
      if (terminalStatuses.has(err.from as LoopStatus)) {
        log.info(
          "[loop-orchestrator] NO_WORK_PRODUCED race -- loop already terminal",
          { loopId, from: err.from }
        );
        return [];
      }
      throw err;
    }
    throw err;
  }

  // Persist error event only after successful status transition
  await loopsService.addEvent(
    loopId,
    organizationId,
    {
      type: "error",
      data: {
        code: "NO_WORK_PRODUCED",
        message: errorEvent.message,
        timestamp: event.timestamp,
      },
    },
    replayContext
  );

  log.error("[loop-orchestrator] EXECUTE loop completed with 0 tokens", {
    loopId,
  });

  return [errorEvent];
}
