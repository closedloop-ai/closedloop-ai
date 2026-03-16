import type {
  LoopEvent,
  LoopEventCompleted,
  TokensByModel,
} from "@repo/api/src/types/loop";
import { MODEL_PRICING } from "@repo/api/src/types/loop";
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
import { getCommandHandler } from "./loop-commands";
import {
  buildContextPack,
  buildContextPackInMemory,
} from "./loop-context-pack";
import { launchLoopOnDesktop, stopDesktopLoop } from "./loop-desktop";
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
      {
        parentLoopId,
      }
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
  if (loop.status !== "PENDING") {
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
    await loopsService.updateStatus(loopId, organizationId, "CLAIMED", {
      containerId: taskArn,
      s3StateKey: s3StateKey ?? undefined,
    });
    return;
  } catch (claimError) {
    if (isInvalidStatusTransitionError(claimError)) {
      const currentLoop = await loopsService.findById(loopId, organizationId);
      if (currentLoop?.status === "RUNNING") {
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

async function cancelLoopAfterLaunchFailure(
  loopId: string,
  organizationId: string
): Promise<void> {
  try {
    await loopsService.cancel(loopId, organizationId);
  } catch (cancelError) {
    log.error("[loop-orchestrator] Failed to cancel loop after launch error", {
      loopId,
      cancelError,
    });
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

    commandId = await launchLoopOnDesktop({
      loopId,
      organizationId,
      command: loop.command,
      computeTargetId: loop.computeTargetId!,
      closedLoopAuthToken: ctx.closedLoopAuthToken,
      apiBaseUrl,
      contextPack,
      parentBranchName: ctx.parentInfo?.branchName ?? undefined,
      parentSessionId: ctx.parentInfo?.sessionId ?? undefined,
      sessionId: loop.sessionId ?? undefined,
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
    // Kill the desktop process if it was already dispatched
    if (commandId) {
      try {
        await stopDesktopLoop(loopId, loop.computeTargetId!);
      } catch (killError) {
        log.warn("[loop-orchestrator] Failed to stop orphaned desktop loop", {
          loopId,
          killError,
        });
      }
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

      await loopsService.updateStatus(loopId, organizationId, "RUNNING", {
        startedAt: new Date(),
        ...(startSessionId ? { sessionId: startSessionId } : {}),
      });
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
      await handleLoopCompleted(loopId, organizationId, event, replayContext);
      return [event];
    }

    case "error": {
      const canonicalEvents = await handleLoopError(
        loopId,
        organizationId,
        event,
        replayContext
      );
      return canonicalEvents;
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
    throw new Error(
      "Desktop loop completed but uploadedArtifacts not found — cannot ingest"
    );
  } else if (loop.s3StateKey) {
    await handler.downloadAndIngest(loop.s3StateKey, loop, organizationId);
  }
}

/**
 * Handle loop completion: download metadata from S3, update token counts.
 */
async function handleLoopCompleted(
  loopId: string,
  organizationId: string,
  event: LoopEventCompleted,
  replayContext?: RunnerReplayContext
): Promise<void> {
  // Try to download metadata from S3 for detailed token counts
  const loop = await loopsService.findById(loopId, organizationId);
  const metadata = loop?.s3StateKey
    ? await downloadMetadata(loop.s3StateKey)
    : null;

  // Prefer the event's token data (validated at ingestion) over S3 metadata.
  // S3 metadata may have stale zeros if uploaded before final counts.
  const tokensInput = event.tokensUsed?.input || metadata?.tokensInput || 0;
  const tokensOutput = event.tokensUsed?.output || metadata?.tokensOutput || 0;
  const tokensByModel: TokensByModel | null =
    event.tokensByModel ?? metadata?.tokensByModel ?? null;

  // Calculate cost per model if we have breakdown, otherwise fall back to Opus pricing
  const estimatedCost = calculateCost(tokensInput, tokensOutput, tokensByModel);

  // Extract PR info + session ID from event.result
  const prSession = extractPrSessionInfo(
    event as unknown as Record<string, unknown>
  );

  // Ingest artifacts BEFORE marking the loop as COMPLETED.
  // If ingestion fails, the loop stays in its current status (e.g., RUNNING)
  // so the completed event can be replayed. Once a loop is COMPLETED the
  // status transition is irreversible, leaving no recovery path for the artifact.
  if (loop) {
    await ingestLoopArtifacts(loop, organizationId);
  }

  // Transition status after ingestion succeeds. If the loop is already
  // terminal (e.g., timed out by cron), the transition throws and we avoid
  // leaving an inconsistent timeline (terminal loop with a later completed event).
  await loopsService.updateStatus(loopId, organizationId, "COMPLETED", {
    completedAt: new Date(),
    tokensInput,
    tokensOutput,
    tokensByModel: tokensByModel ?? undefined,
    estimatedCost,
    ...prSession,
  });

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

  const prUrl = pickString("prUrl");
  const prNumber = pickNumber("prNumber");
  const branchName = pickString("branchName");
  const sessionId = pickString("sessionId");

  return {
    ...(prUrl ? { prUrl } : {}),
    ...(prNumber ? { prNumber } : {}),
    ...(branchName ? { branchName } : {}),
    ...(sessionId ? { sessionId } : {}),
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
    if (loop && loop.status !== "CANCELLED") {
      await loopsService.updateStatus(loopId, organizationId, "CANCELLED", {
        completedAt: new Date(),
      });
    }

    log.info("[loop-orchestrator] Loop cancelled", {
      loopId,
      reason: event.message,
    });
    return [canonicalEvent as unknown as LoopEvent];
  }

  if (event.code === "TIMED_OUT") {
    const prSession = extractPrSessionInfo(event as Record<string, unknown>);

    await loopsService.updateStatus(loopId, organizationId, "TIMED_OUT", {
      completedAt: new Date(),
      error: { code: event.code, message: event.message },
      ...prSession,
    });

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

  // Extract PR/session info from error event (harness includes these even on failure)
  const prSession = extractPrSessionInfo(event as Record<string, unknown>);

  await loopsService.updateStatus(loopId, organizationId, "FAILED", {
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

  log.error("[loop-orchestrator] Loop failed", {
    loopId,
    errorCode: event.code,
    errorMessage: event.message,
  });

  return [event as unknown as LoopEvent];
}
