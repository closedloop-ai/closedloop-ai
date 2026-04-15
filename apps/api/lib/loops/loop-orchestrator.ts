import type { JsonObject } from "@repo/api/src/types/common";
import type {
  AdditionalRepoRef,
  AdditionalRepoRefWithToken,
  LoopEvent,
  LoopEventCompleted,
  LoopEventError,
  LoopEventOutput,
  TokensByModel,
} from "@repo/api/src/types/loop";
import {
  LoopCommand,
  LoopErrorCode,
  LoopStatus,
  MAX_ADDITIONAL_REPOS,
  MODEL_PRICING,
} from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { getInstallationAccessToken } from "@repo/github";
import { log } from "@repo/observability/log";
import { truncateUtf8 } from "@repo/observability/truncate-utf8";
import { getCommitterInfo } from "@/app/artifacts/service";
import { githubService } from "@/app/integrations/github/service";
import {
  isInvalidStatusTransitionError,
  loopsService,
} from "@/app/loops/service";
import { apiKeyService } from "@/app/settings/api-key-service";
import { issueLoopRunnerToken } from "@/lib/auth/loop-runner-jwt";
import type {
  LaunchContext,
  LaunchResult,
  PreparedContext,
  TokenMetadata,
} from "./compute-provider";
import { resolveProvider } from "./compute-provider-registry";
import { getCommandHandler } from "./loop-commands";
import { buildContextPackInMemory } from "./loop-context-pack";
import { scrubContextPackSecrets } from "./loop-state";

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
  parentLoopId: string | null,
  organizationId: string
): Promise<
  | { kind: "no-parent" }
  | { kind: "state-unavailable" }
  | {
      kind: "state-available";
      s3StateKey: string | null;
      sessionId: string | null;
      branchName: string | null;
    }
> {
  if (parentLoopId === null) {
    return { kind: "no-parent" };
  }
  const parent = await loopsService.findById(parentLoopId, organizationId);
  if (!parent) {
    log.warn("[loop-orchestrator] Parent loop not found", { parentLoopId });
    return { kind: "state-unavailable" };
  }
  if (!(parent.s3StateKey || parent.computeTargetId)) {
    log.warn(
      "[loop-orchestrator] Parent loop has no s3StateKey or computeTargetId",
      { parentLoopId }
    );
    return { kind: "state-unavailable" };
  }
  return {
    kind: "state-available",
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
 * Optional cacheCreation/cacheRead apply only in the fallback (no-tokensByModel) path.
 */
function calculateCost(
  tokensInput: number,
  tokensOutput: number,
  tokensByModel: TokensByModel | null,
  cacheCreation = 0,
  cacheRead = 0
): number {
  if (!tokensByModel || Object.keys(tokensByModel).length === 0) {
    const fallback = MODEL_PRICING.default;
    return (
      (tokensInput / 1_000_000) * fallback.input +
      (tokensOutput / 1_000_000) * fallback.output +
      (cacheCreation / 1_000_000) * fallback.input +
      (cacheRead / 1_000_000) * fallback.input * 0.1
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

/**
 * Transition a loop to FAILED status and append an error event.
 * Silently swallows InvalidStatusTransition errors only when the loop is
 * already in a terminal status (COMPLETED, FAILED, CANCELLED, TIMED_OUT) --
 * indicating a benign race condition where another handler finished first.
 * If the source status is NOT terminal (e.g. PENDING), the transition failure
 * is a real validation issue and is re-thrown so it surfaces to the caller.
 * The event is only persisted after the status transition succeeds.
 */
async function failLoopWithError(
  loopId: string,
  organizationId: string,
  code: string,
  message: string,
  timestamp: string
): Promise<void> {
  const terminalStatuses = new Set<string>([
    LoopStatus.Completed,
    LoopStatus.Failed,
    LoopStatus.Cancelled,
    LoopStatus.TimedOut,
  ]);

  try {
    await loopsService.updateStatus(loopId, organizationId, LoopStatus.Failed, {
      error: { code, message },
      completedAt: new Date(),
    });
  } catch (err) {
    if (isInvalidStatusTransitionError(err)) {
      if (terminalStatuses.has(err.from)) {
        // Race: another handler already drove the loop to a terminal state.
        // This is a benign race condition -- swallow silently.
        log.info(
          "[loop-orchestrator] failLoopWithError: loop already terminal, skipping transition",
          { loopId, from: err.from }
        );
        return;
      }
      // Non-terminal source status (e.g. PENDING): this indicates a real
      // transition validation issue, not a race. Re-throw so the caller
      // sees the failure.
      log.error(
        "[loop-orchestrator] failLoopWithError: unexpected invalid transition from non-terminal status",
        { loopId, from: err.from, to: LoopStatus.Failed }
      );
      throw err;
    }
    throw err;
  }

  await loopsService.addEvent(loopId, organizationId, {
    type: "error",
    data: { code, message, timestamp },
  });
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
// Shared launch context resolution
// ---------------------------------------------------------------------------

/**
 * Resolve shared launch context needed by both ECS and desktop paths.
 * Desktop loops skip server-side secrets (electron has its own keys locally).
 */
async function resolveLoopLaunchContext(
  loop: NonNullable<Awaited<ReturnType<typeof loopsService.findById>>>,
  organizationId: string,
  parentInfo: Awaited<ReturnType<typeof resolveParentLoopInfo>>
): Promise<LaunchContext> {
  const isDesktop = !!loop.computeTargetId;

  // Desktop loops don't need server-side secrets — the electron has its own
  // Anthropic API key and gh CLI auth locally.
  const anthropicApiKey = isDesktop
    ? undefined
    : await resolveAnthropicApiKey(loop.userId, organizationId);

  let githubToken: string | undefined;
  if (!isDesktop && loop.repo?.fullName) {
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

  const apiBaseUrl = process.env.API_BASE_URL ?? process.env.LOOP_CALLBACK_URL;
  if (!apiBaseUrl) {
    throw new Error(
      "Cannot launch loop: neither API_BASE_URL nor LOOP_CALLBACK_URL is set"
    );
  }

  const resolvedAdditionalRepos = await resolveAdditionalRepos(
    loop.additionalRepos,
    organizationId,
    isDesktop
  );

  // Build context pack in memory (shared by both paths).
  // ECS provider uploads to S3; desktop provider sends inline.
  const contextPack = await buildContextPackInMemory(
    loop,
    organizationId,
    { anthropicApiKey, githubToken },
    committer,
    resolvedAdditionalRepos
  );

  // Resolve artifact slug for worktree/branch naming on desktop.
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

  return {
    loopId: loop.id,
    organizationId,
    command: loop.command,
    contextPack,
    closedLoopAuthToken,
    apiBaseUrl,
    anthropicApiKey,
    githubToken,
    committer,
    repo: loop.repo,
    artifactId: loop.artifactId,
    artifactSlug,
    parentLoopId: loop.parentLoopId,
    parentS3StateKey:
      parentInfo.kind === "state-available"
        ? (parentInfo.s3StateKey ?? null)
        : null,
    parentBranchName:
      parentInfo.kind === "state-available"
        ? (parentInfo.branchName ?? null)
        : null,
    parentSessionId:
      parentInfo.kind === "state-available"
        ? (parentInfo.sessionId ?? null)
        : null,
    localRepoPath,
    computeTargetId: loop.computeTargetId,
    additionalRepos: resolvedAdditionalRepos,
  };
}

// ---------------------------------------------------------------------------
// Launch (provider-delegated)
// ---------------------------------------------------------------------------

/**
 * Launch a Loop — delegates to the appropriate ComputeProvider (ECS or desktop)
 * based on the loop's computeTargetId.
 *
 * @returns The ECS task ARN or desktop command ID
 */
export async function launchLoop(
  loopId: string,
  organizationId: string
): Promise<string> {
  const loop = await getPendingLoopOrThrow(loopId, organizationId);

  // Pre-dispatch guard: if the command requires a parent loop's state and the
  // parent state is unavailable, fail the loop immediately rather than letting
  // the runner start and immediately abort.
  const parentInfo = await resolveParentLoopInfo(
    loop.parentLoopId,
    organizationId
  );
  if (
    getCommandHandler(loop.command)?.requiresParent === true &&
    parentInfo.kind === "state-unavailable"
  ) {
    const timestamp = new Date().toISOString();
    log.error(
      "[loop-orchestrator] Pre-dispatch guard: parent state unavailable, failing loop",
      { loopId, command: loop.command, parentLoopId: loop.parentLoopId }
    );
    await failLoopWithError(
      loopId,
      organizationId,
      LoopErrorCode.PlanStateUnavailable,
      "Parent loop state is unavailable, cannot resume execution",
      timestamp
    );
    return loopId;
  }

  log.info("[loop-orchestrator] Launching loop", {
    loopId,
    command: loop.command,
    repo: loop.repo,
    hasArtifact: !!loop.artifactId,
    hasParent: !!loop.parentLoopId,
    computeTargetId: loop.computeTargetId,
  });

  const provider = resolveProvider(loop);

  let prepared: PreparedContext | undefined;
  let result: LaunchResult | undefined;
  try {
    const launchCtx = await resolveLoopLaunchContext(
      loop,
      organizationId,
      parentInfo
    );
    prepared = await provider.prepareContext(launchCtx);
    result = await provider.dispatch(launchCtx, prepared);
    await claimOrPersistRunning(
      loopId,
      organizationId,
      result.containerId,
      result.s3StateKey
    );

    log.info("[loop-orchestrator] Loop launched", {
      loopId,
      containerId: result.containerId,
      computeTargetId: loop.computeTargetId,
    });

    return result.containerId;
  } catch (error) {
    log.error("[loop-orchestrator] Failed to launch loop", {
      loopId,
      error: error instanceof Error ? error.message : "Unknown launch error",
    });

    await provider.cleanupOnLaunchFailure(
      loopId,
      organizationId,
      result ?? { s3StateKey: prepared?.s3StateKey },
      error,
      loop.computeTargetId
    );
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
      // Delegate post-start hook to provider (ECS: scrub secrets, Desktop: no-op).
      const loop = await loopsService.findById(loopId, organizationId);
      if (loop) {
        const provider = resolveProvider(loop);
        try {
          await provider.onStarted(loop);
        } catch (onStartedError) {
          log.error(
            "[loop-orchestrator] Provider onStarted hook failed — secrets may still be in S3",
            {
              loopId,
              error:
                onStartedError instanceof Error
                  ? onStartedError.message
                  : String(onStartedError),
            }
          );
          await recordScrubFailureWarning(loopId, organizationId);
        }
      }
      return [event];
    }

    case "output": {
      const persisted = await loopsService.addEvent(
        loopId,
        organizationId,
        {
          type: event.type,
          data: { chunk: event.chunk, timestamp: event.timestamp },
        },
        replayContext
      );
      if (persisted && hasNonZeroTokenUsage(event.tokenUsage)) {
        const tu = event.tokenUsage!;
        await loopsService.updateTokens(
          loopId,
          organizationId,
          tu.inputTokens,
          tu.outputTokens,
          tu.cacheCreationInputTokens ?? 0,
          tu.cacheReadInputTokens ?? 0
        );
      }
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
 * Ingest loop artifacts via the compute provider.
 * Early-returns when there's no artifact or no command handler.
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

  const provider = resolveProvider(loop);
  await provider.ingestArtifacts(loop, organizationId, handler);
}

/**
 * Build a synthetic "default" TokensByModel entry from aggregate token counts.
 * Returns null when all counters are zero.
 */
function buildDefaultTokensByModel(
  input: number,
  output: number,
  cacheCreation: number,
  cacheRead: number
): TokensByModel | null {
  if (input === 0 && output === 0 && cacheCreation === 0 && cacheRead === 0) {
    return null;
  }
  return { default: { input, output, cacheCreation, cacheRead } };
}

/**
 * Resolve the effective TokensByModel for a completed event: use the per-model
 * breakdown from the event/metadata if present, otherwise synthesize a fallback
 * "default" entry so cache pricing can be applied.
 */
function resolveEffectiveTokensByModel(
  rawTokensByModel: TokensByModel | null,
  tokensInput: number,
  tokensOutput: number,
  cacheCreation: number,
  cacheRead: number
): TokensByModel | null {
  if (rawTokensByModel && Object.keys(rawTokensByModel).length > 0) {
    return rawTokensByModel;
  }
  return (
    buildDefaultTokensByModel(
      tokensInput,
      tokensOutput,
      cacheCreation,
      cacheRead
    ) ?? rawTokensByModel
  );
}

function hasNonZeroTokenUsage(
  tokenUsage: LoopEventOutput["tokenUsage"]
): boolean {
  if (!tokenUsage) {
    return false;
  }
  return (
    tokenUsage.inputTokens > 0 ||
    tokenUsage.outputTokens > 0 ||
    (tokenUsage.cacheCreationInputTokens ?? 0) > 0 ||
    (tokenUsage.cacheReadInputTokens ?? 0) > 0
  );
}

function calculateLoopCost(
  apiKeySource: string | undefined,
  tokensInput: number,
  tokensOutput: number,
  tokensByModel: TokensByModel | null,
  cacheCreation: number,
  cacheRead: number
): number {
  if (apiKeySource === "none") {
    return 0;
  }
  return calculateCost(
    tokensInput,
    tokensOutput,
    tokensByModel,
    cacheCreation,
    cacheRead
  );
}

function buildApiKeySourceMetadata(
  apiKeySource: string | undefined,
  existingMetadata?: JsonObject | null
): JsonObject | undefined {
  if (!apiKeySource) {
    return undefined;
  }
  return { ...(existingMetadata ?? {}), apiKeySource };
}

/**
 * Build a "default" TokensByModel entry from an error event's tokenUsage field.
 * Returns undefined when tokenUsage is absent or all-zero.
 */
function buildErrorTokensByModel(
  tokenUsage:
    | {
        inputTokens: number;
        outputTokens: number;
        cacheCreationInputTokens?: number;
        cacheReadInputTokens?: number;
      }
    | undefined
): TokensByModel | undefined {
  if (tokenUsage === undefined) {
    return undefined;
  }
  return (
    buildDefaultTokensByModel(
      tokenUsage.inputTokens,
      tokenUsage.outputTokens,
      tokenUsage.cacheCreationInputTokens ?? 0,
      tokenUsage.cacheReadInputTokens ?? 0
    ) ?? undefined
  );
}

/**
 * Resolve effective tokensByModel and estimatedCost for an error event.
 * Prefers event.tokensByModel when present, falls back to the "default" entry
 * derived from tokenUsage. Returns spread-ready fields for updateStatus.
 */
function buildErrorCostFields(event: LoopEventError): Record<string, unknown> {
  const rawTokensByModel = buildErrorTokensByModel(event.tokenUsage);
  const effectiveTokensByModel =
    event.tokensByModel && Object.keys(event.tokensByModel).length > 0
      ? event.tokensByModel
      : rawTokensByModel;

  const tokensInput = event.tokenUsage?.inputTokens ?? 0;
  const tokensOutput = event.tokenUsage?.outputTokens ?? 0;
  const estimatedCost = calculateLoopCost(
    event.apiKeySource,
    tokensInput,
    tokensOutput,
    effectiveTokensByModel ?? null,
    0,
    0
  );

  // Derive aggregate tokens: prefer event.tokenUsage, fall back to summing tokensByModel.
  let aggregateInput = event.tokenUsage?.inputTokens;
  let aggregateOutput = event.tokenUsage?.outputTokens;
  if (aggregateInput === undefined && effectiveTokensByModel !== undefined) {
    aggregateInput = Object.values(effectiveTokensByModel).reduce(
      (sum, m) => sum + m.input,
      0
    );
    aggregateOutput = Object.values(effectiveTokensByModel).reduce(
      (sum, m) => sum + m.output,
      0
    );
  }

  return {
    ...(aggregateInput !== undefined && {
      tokensInput: aggregateInput,
      tokensOutput: aggregateOutput ?? 0,
    }),
    ...(effectiveTokensByModel !== undefined && {
      tokensByModel: effectiveTokensByModel,
    }),
    ...(effectiveTokensByModel !== undefined && { estimatedCost }),
  };
}

function resolveTokenMetadata(
  loop: Awaited<ReturnType<typeof loopsService.findById>>
): Promise<TokenMetadata | null> {
  if (!loop) {
    return Promise.resolve(null);
  }
  const provider = resolveProvider(loop);
  return provider.getTokenMetadata(loop);
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
  // Retrieve token metadata via provider (ECS: S3 download, Desktop: null)
  const loop = await loopsService.findById(loopId, organizationId);
  const metadata = await resolveTokenMetadata(loop);

  // Extract cache token counts from the completed event (if present).
  // These are extracted before the zero-token guard so the guard can check all four counters.
  const cacheCreation = event.tokensUsed?.cacheCreationInputTokens ?? 0;
  const cacheRead = event.tokensUsed?.cacheReadInputTokens ?? 0;

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
  const rawTokensByModel: TokensByModel | null =
    event.tokensByModel ?? metadata?.tokensByModel ?? null;

  // Synthesize a fallback "default" entry when the runner reported aggregate
  // cache tokens but did not send a per-model breakdown. This lets the cost
  // calculator apply cache pricing even when tokensByModel is absent.
  const effectiveTokensByModel = resolveEffectiveTokensByModel(
    rawTokensByModel,
    tokensInput,
    tokensOutput,
    cacheCreation,
    cacheRead
  );

  const estimatedCost = calculateLoopCost(
    event.apiKeySource,
    tokensInput,
    tokensOutput,
    effectiveTokensByModel,
    cacheCreation,
    cacheRead
  );

  // Guard: EXECUTE loops that explicitly reported 0/0 tokens did no work.
  // Only fires when the event carried a valid token pair (hasEventTokens),
  // not when token data is simply absent (which falls back to metadata).
  if (
    loop?.command === LoopCommand.Execute &&
    hasEventTokens &&
    tokensInput === 0 &&
    tokensOutput === 0 &&
    cacheCreation === 0 &&
    cacheRead === 0
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
      tokensByModel: effectiveTokensByModel ?? undefined,
      estimatedCost,
      ...(isOverridingFailure ? { error: null } : {}),
      ...prSession,
      metadata: buildApiKeySourceMetadata(event.apiKeySource, loop?.metadata),
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
    cacheCreation,
    cacheRead,
    tokensByModel: effectiveTokensByModel,
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
  event: LoopEventError,
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
          ...buildErrorCostFields(event),
          metadata: buildApiKeySourceMetadata(
            event.apiKeySource,
            loop?.metadata
          ),
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
    const canonical = buildCanonicalErrorData(event);

    await loopsService.updateStatus(
      loopId,
      organizationId,
      LoopStatus.TimedOut,
      {
        completedAt: new Date(),
        error: { code: event.code, message: event.message },
        ...buildErrorCostFields(event),
        ...prSession,
        metadata: buildApiKeySourceMetadata(event.apiKeySource),
      }
    );

    await loopsService.addEvent(
      loopId,
      organizationId,
      {
        type: event.type,
        data: canonical,
      },
      replayContext
    );

    log.info("[loop-orchestrator] Loop timed out", {
      loopId,
      message: event.message,
    });
    return [canonical];
  }

  // Structured error codes from electron/runner with specific log levels.
  // Both map to LoopStatus.Failed -- no new status enum needed.
  if (event.code === LoopErrorCode.ContextLimitExceeded) {
    log.warn("[loop-orchestrator] Loop hit context limit", {
      loopId,
      message: event.message,
    });
  } else if (event.code === LoopErrorCode.NoWorkProduced) {
    log.error("[loop-orchestrator] Loop produced no work", {
      loopId,
      message: event.message,
    });
  } else if (event.code === LoopErrorCode.PlanStateUnavailable) {
    log.error("[loop-orchestrator] Loop failed: plan state unavailable", {
      loopId,
      message: event.message,
    });
  }

  // Extract PR/session info from error event (harness includes these even on failure)
  const prSession = extractPrSessionInfo(event as Record<string, unknown>);
  const canonical = buildCanonicalErrorData(event);

  await loopsService.updateStatus(loopId, organizationId, LoopStatus.Failed, {
    completedAt: new Date(),
    error: { code: event.code, message: event.message },
    ...buildErrorCostFields(event),
    ...prSession,
    metadata: buildApiKeySourceMetadata(event.apiKeySource),
  });

  // Persist the error event only after transition succeeds
  await loopsService.addEvent(
    loopId,
    organizationId,
    {
      type: event.type,
      data: canonical,
    },
    replayContext
  );

  // Skip generic log for codes that already logged above
  if (
    event.code !== LoopErrorCode.ContextLimitExceeded &&
    event.code !== LoopErrorCode.NoWorkProduced
  ) {
    log.error("[loop-orchestrator] Loop failed", {
      loopId,
      errorCode: event.code,
      errorMessage: event.message,
    });
  }

  return [canonical];
}

export const LOG_TAIL_MAX_BYTES_ERROR_EVENT = 8192;

/**
 * Build a canonical LoopEventError with truncated logTail.
 * Used for both addEvent persistence and SSE return so both paths see identical data.
 */
function buildCanonicalErrorData(event: LoopEventError): LoopEventError {
  return {
    type: "error",
    code: event.code,
    message: event.message,
    timestamp: event.timestamp,
    ...(event.logTail !== undefined && {
      logTail: truncateUtf8(event.logTail, LOG_TAIL_MAX_BYTES_ERROR_EVENT),
    }),
    ...(event.tokenUsage !== undefined && {
      tokenUsage: event.tokenUsage,
    }),
    ...(event.diagnosticsVersion !== undefined && {
      diagnosticsVersion: event.diagnosticsVersion,
    }),
    ...(event.tokensByModel !== undefined && {
      tokensByModel: event.tokensByModel,
    }),
  };
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
  _replayContext?: RunnerReplayContext
): Promise<LoopEvent[]> {
  const noWorkMessage =
    "EXECUTE loop completed with 0 tokens -- no work was done";
  const errorEvent: LoopEvent = {
    type: "error",
    code: LoopErrorCode.NoWorkProduced,
    message: noWorkMessage,
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

  // Extract PR/session info from the completed event (harness includes these even on zero-token runs)
  const prSession = extractPrSessionInfo(
    event as unknown as Record<string, unknown>
  );

  // Attempt to transition to FAILED. Handle races against other terminal transitions.
  try {
    await loopsService.updateStatus(loopId, organizationId, LoopStatus.Failed, {
      error: { code: LoopErrorCode.NoWorkProduced, message: noWorkMessage },
      completedAt: new Date(),
      ...prSession,
    });
  } catch (err) {
    if (isInvalidStatusTransitionError(err)) {
      if (terminalStatuses.has(err.from)) {
        // Race: another handler already drove the loop to a terminal state before
        // we could mark it FAILED. Treat as a no-op rather than surfacing an error.
        log.info(
          "[loop-orchestrator] NO_WORK_PRODUCED race to terminal -- skipping error event",
          { loopId, from: err.from }
        );
        return [];
      }
      // Non-terminal source: unexpected invalid transition, propagate to caller.
      throw err;
    }
    throw err;
  }

  await loopsService.addEvent(loopId, organizationId, {
    type: "error",
    data: {
      code: LoopErrorCode.NoWorkProduced,
      message: noWorkMessage,
      timestamp: event.timestamp,
    },
  });

  log.error("[loop-orchestrator] EXECUTE loop completed with 0 tokens", {
    loopId,
  });

  return [errorEvent];
}

// ---------------------------------------------------------------------------
// Additional repos resolution (extracted to keep resolveLoopLaunchContext
// below the cognitive-complexity limit)
// ---------------------------------------------------------------------------

/**
 * Cap and resolve GitHub tokens for additional repos declared on the loop.
 *
 * - Enforces MAX_ADDITIONAL_REPOS defensively via slice.
 * - Cloud/ECS: resolves a GitHub App installation token per repo (fail-fast).
 * - Desktop: includes repo entries without tokens — the electron has its own
 *   GitHub auth (gh CLI) locally.
 * - User-level auth is deferred to the runner; only installation-level tokens
 *   are resolved here.
 */
async function resolveAdditionalRepos(
  additionalRepos: AdditionalRepoRef[] | null,
  organizationId: string,
  isDesktop: boolean
): Promise<AdditionalRepoRefWithToken[] | undefined> {
  // Defensive: enforce MAX_ADDITIONAL_REPOS cap regardless of how the list
  // entered the system.
  const cappedAdditionalRepos = (additionalRepos ?? []).slice(
    0,
    MAX_ADDITIONAL_REPOS
  );

  if (cappedAdditionalRepos.length === 0) {
    return undefined;
  }

  if (isDesktop) {
    return cappedAdditionalRepos.map((r) => ({
      fullName: r.fullName,
      branch: r.branch,
    }));
  }

  // Cloud/ECS: resolve a GitHub installation token per repo.
  // Fail-fast: if any token cannot be resolved, throw immediately so the loop
  // fails before ECS dispatch rather than failing inside the container with a
  // cryptic auth error.
  const resolved: AdditionalRepoRefWithToken[] = [];
  for (const repoRef of cappedAdditionalRepos) {
    const token = await resolveGitHubToken(organizationId, repoRef.fullName);
    resolved.push({
      fullName: repoRef.fullName,
      branch: repoRef.branch,
      githubToken: token,
    });
  }
  return resolved;
}
