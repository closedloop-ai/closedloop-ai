import {
  ECSClient,
  RunTaskCommand,
  StopTaskCommand,
} from "@aws-sdk/client-ecs";
import type {
  LoopEvent,
  LoopEventCompleted,
  TokensByModel,
} from "@repo/api/src/types/loop";
import { MODEL_PRICING } from "@repo/api/src/types/loop";
import { getInstallationAccessToken } from "@repo/github";
import { log } from "@repo/observability/log";
import { artifactVersionService } from "@/app/artifacts/artifact-version-service";
import { artifactsService } from "@/app/artifacts/service";
import { githubService } from "@/app/integrations/github/service";
import {
  isInvalidStatusTransitionError,
  loopsService,
} from "@/app/loops/service";
import { apiKeyService } from "@/app/settings/api-key-service";
import { issueLoopRunnerToken } from "@/lib/auth/loop-runner-jwt";
import { getAwsCredentials } from "@/lib/aws-credentials";
import {
  downloadLoopArtifacts,
  ingestExecutionArtifacts,
  ingestPlanArtifacts,
} from "./loop-artifact-ingestion";
import {
  type ContextPack,
  downloadMetadata,
  generateDownloadUrl,
  getStateKeyPrefix,
  scrubContextPackSecrets,
  uploadContextPack,
} from "./loop-state";

type RunnerReplayContext = {
  tokenJti: string;
  nonce: string;
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function getEcsConfig() {
  const cluster = process.env.ECS_CLUSTER_NAME;
  const taskDefinition = process.env.ECS_TASK_DEFINITION;
  const subnets = process.env.ECS_SUBNETS; // comma-separated
  const securityGroupId = process.env.ECS_SECURITY_GROUP_ID;
  const capacityProvider = process.env.ECS_CAPACITY_PROVIDER;
  const apiBaseUrl = process.env.API_BASE_URL ?? process.env.LOOP_CALLBACK_URL;

  if (
    !(
      cluster &&
      taskDefinition &&
      subnets &&
      securityGroupId &&
      capacityProvider
    )
  ) {
    throw new Error(
      "Missing ECS configuration. Required env vars: ECS_CLUSTER_NAME, ECS_TASK_DEFINITION, ECS_SUBNETS, ECS_SECURITY_GROUP_ID, ECS_CAPACITY_PROVIDER"
    );
  }

  if (!apiBaseUrl) {
    throw new Error(
      "API_BASE_URL (or LOOP_CALLBACK_URL) is not configured. " +
        "The container will not be able to report events back."
    );
  }

  return {
    cluster,
    taskDefinition,
    subnets: subnets.split(",").map((s) => s.trim()),
    securityGroupId,
    capacityProvider,
    apiBaseUrl,
  };
}

// Lazy-init ECS client
let _ecsClient: ECSClient | null = null;
function getEcsClient(): ECSClient {
  if (!_ecsClient) {
    _ecsClient = new ECSClient({
      region: process.env.AWS_REGION ?? "us-east-1",
      credentials: getAwsCredentials(),
    });
  }
  return _ecsClient;
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
  parentLoopId: string,
  organizationId: string
): Promise<
  | { s3StateKey: string; sessionId: string | null; branchName: string | null }
  | undefined
> {
  const parent = await loopsService.findById(parentLoopId, organizationId);
  if (!parent?.s3StateKey) {
    log.warn("[loop-orchestrator] Parent loop has no s3StateKey", {
      parentLoopId,
    });
    return undefined;
  }
  return {
    s3StateKey: parent.s3StateKey,
    sessionId: parent.sessionId ?? null,
    branchName: parent.branchName ?? null,
  };
}

// ---------------------------------------------------------------------------
// Context pack assembly
// ---------------------------------------------------------------------------

/**
 * Build and upload a ContextPack for the given loop.
 *
 * Assembles:
 * - The loop's command and prompt
 * - Primary artifact content (if artifactId is set)
 * - Prior loop summary (if parentLoopId is set)
 * - Repository info from the loop record
 *
 * Returns the S3 key where the context pack was stored.
 */
type LoopForContextPack = {
  id: string;
  command: string;
  prompt: string | null;
  artifactId: string | null;
  parentLoopId: string | null;
  repo: { fullName: string; branch: string } | null;
  contextRefs: Array<{
    artifactId: string;
    include: "full" | "summary";
  }> | null;
};

async function fetchPrimaryArtifact(
  loop: LoopForContextPack,
  organizationId: string
): Promise<ContextPack["artifacts"]> {
  if (!loop.artifactId) {
    return [];
  }

  const artifact = await artifactsService.findByIdSimple(
    loop.artifactId,
    organizationId
  );
  if (!artifact) {
    log.warn("[loop-orchestrator] Primary artifact not found", {
      loopId: loop.id,
      artifactId: loop.artifactId,
    });
    return [];
  }

  const latestVersion = await artifactVersionService.getLatest(artifact.id);

  return [
    {
      id: artifact.id,
      type: String(artifact.type),
      title: artifact.title,
      content: latestVersion?.content ?? "",
    },
  ];
}

async function fetchContextRefArtifacts(
  loop: LoopForContextPack,
  organizationId: string
): Promise<ContextPack["artifacts"]> {
  if (!loop.contextRefs || loop.contextRefs.length === 0) {
    return [];
  }

  const refs = loop.contextRefs.filter(
    (ref) => ref.artifactId !== loop.artifactId
  );

  const artifacts = await Promise.all(
    refs.map(async (ref) => {
      const artifact = await artifactsService.findByIdSimple(
        ref.artifactId,
        organizationId
      );
      if (!artifact) {
        return null;
      }

      const latestVersion = await artifactVersionService.getLatest(artifact.id);
      const content = latestVersion?.content ?? "";

      return {
        id: artifact.id,
        type: String(artifact.type),
        title: artifact.title,
        content:
          ref.include === "summary" ? truncateForSummary(content) : content,
      };
    })
  );

  return artifacts.filter(
    (artifact): artifact is NonNullable<typeof artifact> => Boolean(artifact)
  );
}

async function fetchParentLoopSummary(
  loop: LoopForContextPack,
  organizationId: string
): Promise<NonNullable<ContextPack["priorLoopSummaries"]>> {
  if (!loop.parentLoopId) {
    return [];
  }

  const parentLoop = await loopsService.findById(
    loop.parentLoopId,
    organizationId
  );
  if (!parentLoop) {
    return [];
  }

  const metadata = parentLoop.s3StateKey
    ? await downloadMetadata(parentLoop.s3StateKey)
    : null;
  return [
    {
      loopId: parentLoop.id,
      command: parentLoop.command,
      summary: metadata
        ? `Completed with ${metadata.tokensInput + metadata.tokensOutput} tokens. ` +
          `Files written: ${metadata.filesWritten.join(", ") || "none"}.`
        : `Parent loop (${parentLoop.status}).`,
    },
  ];
}

export async function buildContextPack(
  loop: LoopForContextPack,
  organizationId: string,
  stateKeyPrefix: string,
  secrets?: { anthropicApiKey: string; githubToken?: string }
): Promise<string> {
  const [primaryArtifacts, refArtifacts, priorLoopSummaries] =
    await Promise.all([
      fetchPrimaryArtifact(loop, organizationId),
      fetchContextRefArtifacts(loop, organizationId),
      fetchParentLoopSummary(loop, organizationId),
    ]);

  const artifacts = [...primaryArtifacts, ...refArtifacts];

  const contextPack: ContextPack = {
    command: loop.command,
    prompt: loop.prompt ?? undefined,
    artifacts,
    repoInfo: loop.repo ?? undefined,
    priorLoopSummaries:
      priorLoopSummaries.length > 0 ? priorLoopSummaries : undefined,
    secrets,
  };

  const s3Key = await uploadContextPack(stateKeyPrefix, contextPack);
  return s3Key;
}

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

/**
 * Truncate content to a reasonable summary length.
 * Used when contextRefs specify include: "summary".
 */
function truncateForSummary(content: string, maxLength = 2000): string {
  if (content.length <= maxLength) {
    return content;
  }
  return `${content.slice(0, maxLength)}\n\n[... truncated for summary ...]`;
}

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

async function claimOrPersistRunning(
  loopId: string,
  organizationId: string,
  taskArn: string,
  s3StateKey: string
): Promise<void> {
  try {
    await loopsService.updateStatus(loopId, organizationId, "CLAIMED", {
      containerId: taskArn,
      s3StateKey,
    });
    return;
  } catch (claimError) {
    if (isInvalidStatusTransitionError(claimError)) {
      const currentLoop = await loopsService.findById(loopId, organizationId);
      if (currentLoop && currentLoop.status === "RUNNING") {
        await loopsService.persistLaunchInfo(loopId, organizationId, {
          containerId: taskArn,
          s3StateKey,
        });
        // The started-event handler scrubs secrets based on loop.s3StateKey,
        // but it likely already fired before persistLaunchInfo wrote the key.
        // Scrub now to close the window.
        try {
          await scrubContextPackSecrets(s3StateKey);
        } catch (scrubError) {
          log.error(
            "[loop-orchestrator] Failed to scrub secrets in runner-race path",
            {
              loopId,
              s3StateKey,
              error:
                scrubError instanceof Error
                  ? scrubError.message
                  : String(scrubError),
            }
          );
          await recordScrubFailureWarning(loopId, organizationId);
        }
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
 * Launch a Loop as an ECS task via EC2 capacity provider.
 *
 * This is the main entry point called after loop creation.
 * Steps:
 * 1. Fetch the loop record
 * 2. Resolve Anthropic API key (user > org > throw)
 * 3. Resolve GitHub token for target repo (if repo is set)
 * 4. Build and upload context pack to S3
 * 5. Launch ECS RunTask with container overrides
 * 6. Update loop status to CLAIMED with containerId
 *
 * @returns The ECS task ARN
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
  });

  // Track taskArn in outer scope so catch block can stop an orphaned task
  let taskArn: string | undefined;
  let s3StateKey: string | undefined;

  try {
    // 2. Resolve Anthropic API key
    const anthropicApiKey = await resolveAnthropicApiKey(
      loop.userId,
      organizationId
    );

    // 3. Resolve GitHub token (if repo is set)
    let githubToken: string | undefined;
    if (loop.repo?.fullName) {
      githubToken = await resolveGitHubToken(
        organizationId,
        loop.repo.fullName
      );
    }

    // 4. Build context pack (including secrets) and upload to S3
    s3StateKey = getStateKeyPrefix(organizationId, loopId);
    const s3ContextKey = await buildContextPack(
      loop,
      organizationId,
      s3StateKey,
      { anthropicApiKey, githubToken }
    );

    // 5. Generate pre-signed GET URL for context pack so the container can
    // download it without direct S3 credentials (multi-tenant isolation).
    // Use a moderate TTL to tolerate ECS startup delays.
    // This limits the exposure window for secrets in the context pack.
    const CONTEXT_PACK_URL_TTL_SECONDS = 1800; // 30 minutes
    const s3ContextUrl = await generateDownloadUrl(
      s3ContextKey,
      CONTEXT_PACK_URL_TTL_SECONDS
    );

    // 6. Resolve parent state info for resume (if this is a child loop)
    const parentInfo = loop.parentLoopId
      ? await resolveParentLoopInfo(loop.parentLoopId, organizationId)
      : undefined;

    // 7. Launch ECS task
    // CLOSEDLOOP_AUTH_TOKEN is intentionally passed as an env var, not in the
    // context pack. The harness reads it but the sandboxed child process (Claude)
    // cannot access parent env vars, making this more secure than the context
    // pack which is fully visible to the child process via S3.
    const closedLoopAuthToken = await issueLoopRunnerToken({
      loopId,
      organizationId,
    });
    taskArn = await runEcsTask({
      loopId,
      organizationId,
      command: loop.command,
      s3StateKey,
      s3ContextKey,
      s3ContextUrl,
      repo: loop.repo ?? undefined,
      closedLoopAuthToken,
      artifactId: loop.artifactId ?? undefined,
      parentS3StateKey: parentInfo?.s3StateKey,
      parentSessionId: parentInfo?.sessionId ?? undefined,
      parentBranchName: parentInfo?.branchName ?? undefined,
    });

    // 7. Update loop status to CLAIMED (or persist metadata if runner raced ahead).
    await claimOrPersistRunning(loopId, organizationId, taskArn, s3StateKey);

    log.info("[loop-orchestrator] Loop launched successfully", {
      loopId,
      taskArn,
    });

    return taskArn;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown launch error";

    log.error("[loop-orchestrator] Failed to launch loop", {
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

/**
 * Stop a running ECS task for a loop (best-effort).
 */
export async function stopLoopTask(
  taskArn: string,
  reason = "Loop cancelled"
): Promise<void> {
  const ecs = getEcsClient();
  const config = getEcsConfig();

  await ecs.send(
    new StopTaskCommand({
      cluster: config.cluster,
      task: taskArn,
      reason,
    })
  );
}

/**
 * Run an ECS task via capacity provider with the given configuration.
 * Returns the task ARN.
 */
async function runEcsTask(opts: {
  loopId: string;
  organizationId: string;
  command: string;
  s3StateKey: string;
  s3ContextKey: string;
  s3ContextUrl: string;
  repo?: { fullName: string; branch: string };
  closedLoopAuthToken: string;
  artifactId?: string;
  parentS3StateKey?: string;
  parentSessionId?: string;
  parentBranchName?: string;
}): Promise<string> {
  const ecs = getEcsClient();
  const config = getEcsConfig();

  // Build environment variable overrides for the container.
  // Auth tokens (CLOSEDLOOP_AUTH_TOKEN) are passed here as env vars because the
  // harness process reads them directly while the sandboxed child process (Claude)
  // cannot access parent env vars. This is more secure than the context pack,
  // which the child process can read via S3. API keys and GitHub tokens still
  // travel via the context pack since the child process needs them directly.
  const environment = [
    { name: "LOOP_ID", value: opts.loopId },
    { name: "ORGANIZATION_ID", value: opts.organizationId },
    { name: "COMMAND", value: opts.command },
    { name: "S3_STATE_KEY", value: opts.s3StateKey },
    { name: "S3_CONTEXT_KEY", value: opts.s3ContextKey },
    { name: "S3_CONTEXT_URL", value: opts.s3ContextUrl },
    { name: "CLOSEDLOOP_AUTH_TOKEN", value: opts.closedLoopAuthToken },
    { name: "CORRELATION_ID", value: opts.loopId },
  ];

  if (opts.artifactId) {
    environment.push({ name: "ARTIFACT_ID", value: opts.artifactId });
  }

  if (opts.repo) {
    environment.push({ name: "TARGET_REPO", value: opts.repo.fullName });
    environment.push({ name: "TARGET_BRANCH", value: opts.repo.branch });
  }

  // Parent state for resume: lets the container download prior run state
  if (opts.parentS3StateKey) {
    environment.push({
      name: "S3_PARENT_STATE_KEY",
      value: opts.parentS3StateKey,
    });
  }
  if (opts.parentSessionId) {
    environment.push({
      name: "PARENT_SESSION_ID",
      value: opts.parentSessionId,
    });
  }
  if (opts.parentBranchName) {
    environment.push({
      name: "PARENT_BRANCH_NAME",
      value: opts.parentBranchName,
    });
  }

  // Add callback URL so the harness can report events back.
  // Validated early in getEcsConfig() to fail fast before side effects.
  environment.push({ name: "API_BASE_URL", value: config.apiBaseUrl });

  const command = new RunTaskCommand({
    cluster: config.cluster,
    taskDefinition: config.taskDefinition,
    // Use EC2 capacity provider (not Fargate) — matches IaC warm pool config
    capacityProviderStrategy: [
      {
        capacityProvider: config.capacityProvider,
        weight: 1,
      },
    ],
    count: 1,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: config.subnets,
        securityGroups: [config.securityGroupId],
        // DISABLED: tasks run in private subnets with NAT gateway for outbound
        assignPublicIp: "DISABLED",
      },
    },
    overrides: {
      containerOverrides: [
        {
          // Must match the container name in the ECS task definition
          name: "claude-runner",
          environment,
        },
      ],
    },
    tags: [
      { key: "loop-id", value: opts.loopId },
      { key: "organization-id", value: opts.organizationId },
      { key: "command", value: opts.command },
    ],
  });

  const result = await ecs.send(command);

  const task = result.tasks?.[0];
  if (!task?.taskArn) {
    const failureReason =
      result.failures?.[0]?.reason ?? "No task returned from RunTask";
    throw new Error(`ECS RunTask failed: ${failureReason}`);
  }

  log.info("[loop-orchestrator] ECS task started", {
    loopId: opts.loopId,
    taskArn: task.taskArn,
    lastStatus: task.lastStatus,
  });

  return task.taskArn;
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

  const tokensInput = metadata?.tokensInput ?? event.tokensUsed?.input ?? 0;
  const tokensOutput = metadata?.tokensOutput ?? event.tokensUsed?.output ?? 0;
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
  if (loop?.s3StateKey && loop.artifactId) {
    const loopArtifacts = await downloadLoopArtifacts(loop.s3StateKey);

    if (loop.command === "PLAN" || loop.command === "REQUEST_CHANGES") {
      await ingestPlanArtifacts(loop, organizationId, loopArtifacts);
    }

    if (loop.command === "EXECUTE") {
      await ingestExecutionArtifacts(loop, loopArtifacts);
    }
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
      return result[field] as string;
    }
    if (typeof event[field] === "string") {
      return event[field] as string;
    }
    return undefined;
  }
  function pickNumber(field: string): number | undefined {
    if (typeof result[field] === "number") {
      return result[field] as number;
    }
    if (typeof event[field] === "number") {
      return event[field] as number;
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
