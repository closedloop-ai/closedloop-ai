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
  BootstrapLoopResultSchema,
  LoopCommand,
  LoopErrorCode,
  LoopStatus,
  MAX_ADDITIONAL_REPOS,
} from "@repo/api/src/types/loop";
import type { LoopBranchMaterializationEnvelope } from "@repo/api/src/types/loop-body";
import {
  issueLoopRunnerToken,
  type LoopRunnerTokenIssueOverrides,
} from "@repo/auth/loop-runner-jwt";
import { withDb } from "@repo/database";
import { getInstallationAccessToken } from "@repo/github";
import { DEFAULT_PRICING, getModelPricing } from "@closedloop-ai/loops-api/tokens";
import { log } from "@repo/observability/log";
import { truncateUtf8 } from "@repo/observability/truncate-utf8";
import { bulkIngestAgents } from "@/app/catalog/service";
import { getCommitterInfo } from "@/app/documents/document-service";
import { githubService } from "@/app/integrations/github/service";
import { isInvalidStatusTransitionError } from "@/app/loops/loop-errors";
import { loopsService } from "@/app/loops/service";
import { apiKeyService } from "@/app/settings/api-key-service";
import { documentWhere } from "@/lib/artifact-adapters";
import { parseJsonObject } from "@/lib/json-schema";
import { dispatchLoopCompletedNotification } from "@/lib/loop-notifications";
import { dispatchLoopCompletedSlackNotification } from "@/lib/loop-slack-notifications";
import type {
  DesktopUserIntentSignature,
  LaunchContext,
  LaunchResult,
  PreparedContext,
  TokenMetadata,
} from "./compute-provider";
import { resolveProvider } from "./compute-provider-registry";
import { buildLoopBranchMaterialization } from "./loop-branch-materialization";
import { getCommandHandler } from "./loop-commands";
import { buildContextPackInMemory } from "./loop-context-pack";
import { buildDesktopLoopExecutionBody } from "./loop-desktop";
import { getStateKeyPrefix, scrubContextPackSecrets } from "./loop-state";

type RunnerReplayContext = {
  tokenJti: string;
  nonce: string;
};

/**
 * Build the `runner` argument for `loopsService.addEvent` when the
 * orchestrator is handling a runner event. Returns undefined
 * when ctx is absent so callers can pass the result directly to addEvent
 * without a ternary at every call site (avoids cognitive complexity points in
 * the switch-heavy handleLoopEvent).
 *
 * Callers that do NOT have a replayContext (system events, failLoopWithError)
 * call addEvent without a runner arg, preserving existing behaviour.
 */
function replayRunner(
  ctx: RunnerReplayContext | undefined
): { tokenJti: string; nonce: string } | undefined {
  if (!ctx) {
    return undefined;
  }
  return { tokenJti: ctx.tokenJti, nonce: ctx.nonce };
}

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
  loopId: string,
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
    log.warn("loop.parent_not_found", { loopId, parentLoopId });
    return { kind: "state-unavailable" };
  }
  if (!(parent.s3StateKey || parent.computeTargetId)) {
    log.warn("loop.parent_state_unavailable", {
      loopId,
      parentLoopId,
      detail: "Parent loop has no s3StateKey or computeTargetId",
    });
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
 * Falls back to default pricing if no model breakdown is available.
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
    const fallback = DEFAULT_PRICING;
    return (
      (tokensInput / 1_000_000) * fallback.input +
      (tokensOutput / 1_000_000) * fallback.output +
      (cacheCreation / 1_000_000) * fallback.cacheWrite +
      (cacheRead / 1_000_000) * fallback.cacheRead
    );
  }

  let totalCost = 0;
  for (const [model, usage] of Object.entries(tokensByModel)) {
    const pricing = getModelPricing(model);

    totalCost +=
      (usage.input / 1_000_000) * pricing.input +
      (usage.output / 1_000_000) * pricing.output +
      ((usage.cacheCreation ?? 0) / 1_000_000) * pricing.cacheWrite +
      ((usage.cacheRead ?? 0) / 1_000_000) * pricing.cacheRead;
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
    log.error("loop.secret_scrub_failed", {
      loopId,
      s3StateKey,
      error: scrubError,
      detail: "Failed to scrub secrets in runner-race path",
    });
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
        log.info("loop.launch_info_persisted_after_race", {
          loopId,
          taskArn,
          detail:
            "Loop already RUNNING (runner raced ahead), persisted launch info",
        });
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
      log.warn("loop.cancel_after_launch_failure_skipped", {
        loopId,
        detail: "Loop already in terminal status (cancel-after-complete race)",
      });
    } else {
      log.error("loop.cancel_after_launch_failure_failed", {
        loopId,
        cancelError,
      });
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
        log.info("loop.fail_already_terminal", {
          loopId,
          from: err.from,
          detail:
            "failLoopWithError: loop already terminal, skipping transition",
        });
        return;
      }
      // Non-terminal source status (e.g. PENDING): this indicates a real
      // transition validation issue, not a race. Re-throw so the caller
      // sees the failure.
      log.error("loop.fail_invalid_transition", {
        loopId,
        from: err.from,
        to: LoopStatus.Failed,
        detail:
          "failLoopWithError: unexpected invalid transition from non-terminal status",
      });
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
    log.error("loop.scrub_failure_warning_persist_failed", {
      loopId,
      error: auditError,
    });
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
  parentInfo: Awaited<ReturnType<typeof resolveParentLoopInfo>>,
  options?: LaunchLoopOptions
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

  const {
    token: closedLoopAuthToken,
    tokenId,
    expiresAt,
  } = await issueLoopRunnerToken(
    { loopId: loop.id, organizationId },
    undefined,
    options?.tokenOverrides
  );

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
  let documentSlug: string | undefined;
  if (loop.documentId) {
    const artifact = await withDb((db) =>
      db.artifact.findUnique({
        where: documentWhere({ id: loop.documentId!, organizationId }),
        select: { slug: true },
      })
    );
    documentSlug = artifact?.slug ?? undefined;
  }

  const localRepoPath =
    typeof loop.metadata?.localRepoPath === "string"
      ? loop.metadata.localRepoPath
      : undefined;

  const branchMaterialization = await persistBranchMaterializationForDesktop({
    isDesktop,
    loopId: loop.id,
    organizationId,
    command: loop.command,
    metadata: loop.metadata,
    documentSlug,
    primaryRepo: loop.repo,
    additionalRepos: resolvedAdditionalRepos,
  });

  // Snapshot ComputeTarget capabilities for desktop loops; ECS loops have no
  // compute target so default to an empty object.
  const runnerCapabilities = await resolveRunnerCapabilities(
    loop.computeTargetId
  );

  return {
    loopId: loop.id,
    organizationId,
    userId: loop.userId,
    command: loop.command,
    contextPack,
    closedLoopAuthToken,
    tokenId,
    expiresAt,
    apiBaseUrl,
    anthropicApiKey,
    githubToken,
    committer,
    repo: loop.repo,
    documentId: loop.documentId,
    documentSlug,
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
    runnerCapabilities,
    additionalRepos: resolvedAdditionalRepos,
    branchMaterialization,
    harness: loop.harness,
    desktopUserIntentSignature: options?.desktopUserIntentSignature,
  };
}

async function persistBranchMaterializationForDesktop(input: {
  isDesktop: boolean;
  loopId: string;
  organizationId: string;
  command: LoopCommand;
  metadata: JsonObject;
  documentSlug?: string | null;
  primaryRepo: { fullName: string; branch: string } | null;
  additionalRepos?: AdditionalRepoRefWithToken[];
}): Promise<LoopBranchMaterializationEnvelope | undefined> {
  if (!(input.isDesktop && input.primaryRepo)) {
    return undefined;
  }

  const branchMaterialization = buildLoopBranchMaterialization({
    command: input.command,
    loopId: input.loopId,
    documentSlug: input.documentSlug,
    primaryRepo: input.primaryRepo,
    additionalRepos: input.additionalRepos,
  });
  if (branchMaterialization === null) {
    // Clear any stale envelope left by a prior write-mode run of the same loop.
    const { branchMaterialization: _stale, ...clearedMetadata } =
      input.metadata;
    await loopsService.updateMetadata(
      input.loopId,
      input.organizationId,
      clearedMetadata
    );
    return undefined;
  }
  const updated = await loopsService.updateMetadata(
    input.loopId,
    input.organizationId,
    { ...input.metadata, branchMaterialization }
  );
  if (updated === 0) {
    throw new Error(
      "Cannot launch loop: branch materialization metadata was not persisted"
    );
  }
  return branchMaterialization;
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
export type LaunchLoopOptions = {
  desktopUserIntentSignature?: DesktopUserIntentSignature;
  tokenOverrides?: LoopRunnerTokenIssueOverrides;
};

export async function launchLoop(
  loopId: string,
  organizationId: string,
  options?: LaunchLoopOptions
): Promise<string> {
  const loop = await getPendingLoopOrThrow(loopId, organizationId);

  // Pre-dispatch guard: if the command requires a parent loop's state and the
  // parent state is unavailable, fail the loop immediately rather than letting
  // the runner start and immediately abort.
  const parentInfo = await resolveParentLoopInfo(
    loopId,
    loop.parentLoopId,
    organizationId
  );
  if (
    getCommandHandler(loop.command)?.requiresParent === true &&
    parentInfo.kind === "state-unavailable"
  ) {
    const timestamp = new Date().toISOString();
    log.error("loop.pre_dispatch_guard_failed", {
      loopId,
      command: loop.command,
      parentLoopId: loop.parentLoopId,
      detail: "Pre-dispatch guard: parent state unavailable, failing loop",
    });
    await failLoopWithError(
      loopId,
      organizationId,
      LoopErrorCode.PlanStateUnavailable,
      "Parent loop state is unavailable, cannot resume execution",
      timestamp
    );
    return loopId;
  }

  log.info("loop.launching", {
    loopId,
    command: loop.command,
    // commandId of the triggering desktop user-intent command (desktop loops
    // only; undefined for ECS), so the launch log can be stitched to the
    // browser-signed command that triggered it.
    commandId: options?.desktopUserIntentSignature?.commandId,
    repo: loop.repo,
    hasDocument: !!loop.documentId,
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
      parentInfo,
      options
    );
    // Pin the JTI atomically before dispatch so the token is visible from
    // second zero. This is the only non-CAS writer of active_token_jti; all
    // subsequent writers use the CAS-guarded enforceJtiOrPin path.
    await withDb((db) =>
      db.loop.updateMany({
        where: { id: loopId, organizationId },
        data: {
          activeTokenJti: launchCtx.tokenId,
          tokenExpiresAt: launchCtx.expiresAt,
          runnerCapabilities: launchCtx.runnerCapabilities,
        },
      })
    );
    prepared = await provider.prepareContext(launchCtx);
    result = await provider.dispatch(launchCtx, prepared);
    await claimOrPersistRunning(
      loopId,
      organizationId,
      result.containerId,
      result.s3StateKey
    );

    log.info("loop.launched", {
      loopId,
      containerId: result.containerId,
      // Mirror loop.launching so a launch-success event can be stitched
      // directly to the triggering desktop user-intent command without a
      // secondary lookup by loopId (desktop loops only; undefined for ECS).
      commandId: options?.desktopUserIntentSignature?.commandId,
      computeTargetId: loop.computeTargetId,
    });

    return result.containerId;
  } catch (error) {
    log.error("loop.launch_failed", {
      loopId,
      error,
      // Mirror loop.launching / loop.launched so an operator seeing a launch
      // failure can pivot straight back to the triggering desktop user-intent
      // command (desktop loops only; undefined for ECS) and compute target,
      // preserving the command→loop→incident trace.
      commandId: options?.desktopUserIntentSignature?.commandId,
      computeTargetId: loop.computeTargetId,
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

/**
 * Builds the one-shot Desktop execution body after a signed browser intent has
 * reached Desktop. Desktop must fetch this with its API key and existing PoP;
 * the browser never receives the loop runner JWT or inline context payload.
 */
export async function buildDesktopLoopExecutionCredentials(input: {
  loopId: string;
  organizationId: string;
  action?: "loop.launch" | "loop.kill";
}): Promise<JsonObject> {
  const loop = await loopsService.findById(input.loopId, input.organizationId);
  if (!loop) {
    throw new Error(`Loop not found: ${input.loopId}`);
  }
  if (!loop.computeTargetId) {
    throw new Error("Loop is not assigned to a Desktop compute target");
  }
  if (input.action === "loop.kill") {
    return { loopId: input.loopId };
  }
  const parentInfo = await resolveParentLoopInfo(
    input.loopId,
    loop.parentLoopId,
    input.organizationId
  );
  const pinnedToken = await withDb((db) =>
    db.loop.findUnique({
      where: { id: input.loopId, organizationId: input.organizationId },
      select: { activeTokenJti: true, tokenExpiresAt: true },
    })
  );
  const tokenOverrides: LoopRunnerTokenIssueOverrides | undefined =
    pinnedToken?.activeTokenJti
      ? {
          tokenJti: pinnedToken.activeTokenJti,
          expiresAt: pinnedToken.tokenExpiresAt
            ? Math.floor(pinnedToken.tokenExpiresAt.getTime() / 1000)
            : undefined,
        }
      : undefined;
  const launchCtx = await resolveLoopLaunchContext(
    loop,
    input.organizationId,
    parentInfo,
    { tokenOverrides }
  );
  const body = buildDesktopLoopExecutionBody({
    loopId: launchCtx.loopId,
    organizationId: launchCtx.organizationId,
    userId: launchCtx.userId,
    command: launchCtx.command,
    computeTargetId: loop.computeTargetId,
    closedLoopAuthToken: launchCtx.closedLoopAuthToken,
    apiBaseUrl: launchCtx.apiBaseUrl,
    contextPack: launchCtx.contextPack,
    documentSlug: launchCtx.documentSlug,
    parentLoopId: launchCtx.parentLoopId ?? undefined,
    parentBranchName: launchCtx.parentBranchName ?? undefined,
    parentSessionId: launchCtx.parentSessionId ?? undefined,
    localRepoPath: launchCtx.localRepoPath,
    additionalRepos: launchCtx.additionalRepos,
    branchMaterialization: launchCtx.branchMaterialization,
    documentId: launchCtx.documentId ?? undefined,
    s3StateKey: getStateKeyPrefix(launchCtx.organizationId, launchCtx.loopId),
    harness: launchCtx.harness,
  });
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Invalid Desktop loop execution body");
  }
  return body as JsonObject;
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
  log.info("loop.event_handling", {
    loopId,
    eventType: event.type,
  });

  // Pre-resolve the runner arg once. When replayContext is present, addEvent
  // uses the runner event unique key as the authoritative replay gate.
  const runner = replayRunner(replayContext);

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
        runner
      );
      // Delegate post-start hook to provider (ECS: scrub secrets, Desktop: no-op).
      const loop = await loopsService.findById(loopId, organizationId);
      if (loop) {
        const provider = resolveProvider(loop);
        try {
          await provider.onStarted(loop);
        } catch (onStartedError) {
          log.error("loop.on_started_hook_failed", {
            loopId,
            error: onStartedError,
            detail:
              "Provider onStarted hook failed — secrets may still be in S3",
          });
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
        runner
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
        runner
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
          },
        },
        runner
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
        runner
      );
      return [event];
    }

    case "completed": {
      return handleLoopCompleted(loopId, organizationId, event, runner);
    }

    case "error": {
      return handleLoopError(loopId, organizationId, event, runner);
    }

    default: {
      // Store unknown event types for forward compatibility
      await loopsService.addEvent(
        loopId,
        organizationId,
        {
          type: event.type,
          data: event as unknown as Record<string, unknown>,
        },
        runner
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
  if (loop.command === LoopCommand.Bootstrap) {
    await ingestBootstrapAgents(loop, organizationId);
    return;
  }
  if (!loop.documentId) {
    return;
  }
  // MANUAL loops have no S3 state or compute target artifacts to ingest.
  if (loop.command === LoopCommand.Manual) {
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

async function ingestBootstrapAgents(
  loop: NonNullable<Awaited<ReturnType<typeof loopsService.findById>>>,
  organizationId: string
): Promise<void> {
  const raw = loop.uploadedArtifacts as Record<string, unknown> | null;
  const bootstrapResult = raw?.bootstrapResult;
  const parsed = BootstrapLoopResultSchema.safeParse(bootstrapResult);
  if (!parsed.success) {
    log.warn("loop.bootstrap_artifacts_invalid", {
      loopId: loop.id,
      parseErrors: parsed.error.issues.map((i) => i.message),
    });
    return;
  }

  let totalCreated = 0;
  let totalUpdated = 0;
  for (const repo of parsed.data.repos) {
    if (!repo.success || repo.agents.length === 0) {
      continue;
    }
    try {
      const result = await bulkIngestAgents(organizationId, loop.userId, {
        agents: repo.agents.map((a) => ({
          name: a.name,
          role: a.role,
          description: a.description,
          prompt: a.prompt,
        })),
        bootstrapRunId: loop.id,
        sourceRepo: repo.fullName,
        criticGates: repo.criticGates ?? undefined,
      });
      totalCreated += result.created;
      totalUpdated += result.updated;
    } catch (err) {
      log.error("loop.bootstrap_ingestion_failed", {
        loopId: loop.id,
        repo: repo.fullName,
        error: err,
      });
    }
  }

  log.info("loop.bootstrap_agents_ingested", {
    loopId: loop.id,
    totalCreated,
    totalUpdated,
    repoCount: parsed.data.repos.filter((r) => r.success).length,
  });
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
 *
 * @param runner - Pre-resolved runner arg (with skipDuplicates when replaying).
 */
async function handleLoopCompleted(
  loopId: string,
  organizationId: string,
  event: LoopEventCompleted,
  runner: ReturnType<typeof replayRunner> | undefined
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
    return handleZeroTokenExecute(loopId, organizationId, loop, event);
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
    log.info("loop.completed_overriding_terminal_status", {
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
    log.warn("loop.terminal_status_overridden", {
      loopId: loop.id,
      previousStatus: loop.status,
      detail: "Overriding terminal status to COMPLETED, clearing stale error",
    });
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
        ...(event.results ? { results: event.results } : {}),
      },
    },
    runner
  );

  // Signal the loop owner via their inbox that their autonomous run finished —
  // the platform's core value moment is otherwise invisible when they step away.
  notifyLoopOwnerOfCompletion(loop, organizationId);

  // Also post to the org's connected Slack workspace (if any) so the team's
  // own channel — not just the global ops channel — sees the ship moment.
  notifyOrgSlackOfCompletion(loop, organizationId);

  log.info("loop.completed", {
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
 * Fire-and-forget inbox notification telling a Loop's owner their autonomous
 * run finished. No-ops when the loop record is absent. Extracted from
 * handleLoopCompleted so the guard branch stays out of that function's
 * cognitive-complexity budget. Gating/delivery happens in the dispatcher.
 */
function notifyLoopOwnerOfCompletion(
  loop:
    | NonNullable<Awaited<ReturnType<typeof loopsService.findById>>>
    | null
    | undefined,
  organizationId: string
): void {
  if (!loop) {
    return;
  }
  dispatchLoopCompletedNotification({
    userId: loop.userId,
    organizationId,
    loopId: loop.id,
    loopTitle: buildLoopNotificationTitle(loop),
  });
}

/**
 * Fire-and-forget engagement post to the org's connected Slack workspace
 * announcing that a Loop shipped. No-ops when the loop record is absent;
 * connection lookup, flag gating, and delivery all happen in the dispatcher.
 */
function notifyOrgSlackOfCompletion(
  loop:
    | NonNullable<Awaited<ReturnType<typeof loopsService.findById>>>
    | null
    | undefined,
  organizationId: string
): void {
  if (!loop) {
    return;
  }
  dispatchLoopCompletedSlackNotification({
    organizationId,
    loopLabel: humanizeLoopCommand(loop.command),
    projectLabel: loop.repo?.fullName ?? null,
  });
}

/**
 * Humanize a `LoopCommand` for display — e.g. `EXECUTE` → "Execute",
 * `PLAN_REVIEW` → "Plan Review".
 */
function humanizeLoopCommand(command: LoopCommand): string {
  return command
    .toLowerCase()
    .split("_")
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}

/**
 * Build a short, human-readable title for a completed-loop inbox notification.
 * Loops carry no stored title, so derive one from the command and (when set)
 * the target repo — e.g. "Execute · acme/widgets".
 */
function buildLoopNotificationTitle(
  loop: NonNullable<Awaited<ReturnType<typeof loopsService.findById>>>
): string {
  const label = humanizeLoopCommand(loop.command);
  return loop.repo?.fullName ? `${label} · ${loop.repo.fullName}` : label;
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
  runner: ReturnType<typeof replayRunner> | undefined
): Promise<LoopEvent[]> {
  if (event.code === LoopErrorCode.Cancelled) {
    const canonicalEvent: LoopEvent = {
      type: "cancelled",
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
      runner
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

    log.info("loop.cancelled", {
      loopId,
      reason: event.message,
    });
    return [canonicalEvent];
  }

  if (event.code === LoopErrorCode.TimedOut) {
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
      runner
    );

    log.info("loop.timed_out", {
      loopId,
      message: event.message,
    });
    return [canonical];
  }

  // Structured error codes from electron/runner with specific log levels.
  // Both map to LoopStatus.Failed -- no new status enum needed.
  if (event.code === LoopErrorCode.ContextLimitExceeded) {
    log.warn("loop.context_limit_exceeded", {
      loopId,
      message: event.message,
    });
  } else if (event.code === LoopErrorCode.NoWorkProduced) {
    log.error("loop.no_work_produced", {
      loopId,
      message: event.message,
    });
  } else if (event.code === LoopErrorCode.PlanStateUnavailable) {
    log.error("loop.plan_state_unavailable", {
      loopId,
      message: event.message,
    });
  }

  // Extract PR/session info from error event (harness includes these even on failure)
  const prSession = extractPrSessionInfo(event as Record<string, unknown>);
  const canonical = buildCanonicalErrorData(event);

  await loopsService.updateStatus(loopId, organizationId, LoopStatus.Failed, {
    completedAt: new Date(),
    error: {
      code: event.code,
      message: event.message,
      ...(event.result === undefined ? {} : { result: event.result }),
    },
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
    runner
  );

  // Skip generic log for codes that already logged above
  if (
    event.code !== LoopErrorCode.ContextLimitExceeded &&
    event.code !== LoopErrorCode.NoWorkProduced
  ) {
    log.error("loop.failed", {
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
    ...(event.result !== undefined && {
      result: event.result,
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
  event: LoopEventCompleted
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
    log.info("loop.no_work_produced_skipped", {
      loopId,
      status: loop?.status,
      detail: "Skipping NO_WORK_PRODUCED -- loop already terminal",
    });
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
        log.info("loop.no_work_produced_race_skipped", {
          loopId,
          from: err.from,
          detail: "NO_WORK_PRODUCED race to terminal -- skipping error event",
        });
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

  log.error("loop.execute_zero_tokens", {
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

  // Cloud/ECS: resolve a GitHub installation token per repo. Each resolution is
  // two sequential network round-trips (a DB installation lookup + a GitHub
  // installation-token API call), so resolve all repos concurrently rather than
  // serially — N is bounded by MAX_ADDITIONAL_REPOS but the serial latency would
  // otherwise be N×(DB+API). Promise.all preserves both input order (via map)
  // and fail-fast: if any token cannot be resolved it rejects immediately so the
  // loop fails before ECS dispatch rather than failing inside the container with
  // a cryptic auth error.
  return await Promise.all(
    cappedAdditionalRepos.map(async (repoRef) => ({
      fullName: repoRef.fullName,
      branch: repoRef.branch,
      githubToken: await resolveGitHubToken(organizationId, repoRef.fullName),
    }))
  );
}

/**
 * Read ComputeTarget capabilities for desktop loops.
 * ECS loops have no compute target — returns an empty object as default.
 */
async function resolveRunnerCapabilities(
  computeTargetId: string | null
): Promise<JsonObject> {
  if (!computeTargetId) {
    return {};
  }
  const computeTarget = await withDb((db) =>
    db.computeTarget.findUnique({
      where: { id: computeTargetId },
      select: { capabilities: true },
    })
  );
  if (
    computeTarget?.capabilities === null ||
    computeTarget?.capabilities === undefined
  ) {
    return {};
  }
  return parseJsonObject(computeTarget.capabilities) ?? {};
}
