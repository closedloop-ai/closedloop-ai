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
import { artifactsService } from "@/app/artifacts/service";
import { githubService } from "@/app/integrations/github/service";
import { loopsService } from "@/app/loops/service";
import { apiKeyService } from "@/app/settings/api-key-service";
import { issueLoopRunnerToken } from "@/lib/auth/loop-runner-jwt";
import {
  type ContextPack,
  downloadMetadata,
  getStateKeyPrefix,
  uploadContextPack,
} from "./loop-state";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function getEcsConfig() {
  const cluster = process.env.ECS_CLUSTER_NAME;
  const taskDefinition = process.env.ECS_TASK_DEFINITION;
  const subnets = process.env.ECS_SUBNETS; // comma-separated
  const securityGroupId = process.env.ECS_SECURITY_GROUP_ID;

  if (!(cluster && taskDefinition && subnets && securityGroupId)) {
    throw new Error(
      "Missing ECS configuration. Required env vars: ECS_CLUSTER_NAME, ECS_TASK_DEFINITION, ECS_SUBNETS, ECS_SECURITY_GROUP_ID"
    );
  }

  return {
    cluster,
    taskDefinition,
    subnets: subnets.split(",").map((s) => s.trim()),
    securityGroupId,
  };
}

// Lazy-init ECS client
let _ecsClient: ECSClient | null = null;
function getEcsClient(): ECSClient {
  if (!_ecsClient) {
    _ecsClient = new ECSClient({
      region: process.env.AWS_REGION ?? "us-east-1",
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
async function resolveGitHubToken(
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
  return [
    {
      id: artifact.id,
      type: String(artifact.subtype ?? artifact.type),
      title: artifact.title,
      content: artifact.content ?? "",
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

      return {
        id: artifact.id,
        type: String(artifact.subtype ?? artifact.type),
        title: artifact.title,
        content:
          ref.include === "summary"
            ? truncateForSummary(artifact.content ?? "")
            : (artifact.content ?? ""),
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

  const metadata = await downloadMetadata(organizationId, parentLoop.id);
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
  organizationId: string
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
  };

  const s3Key = await uploadContextPack(organizationId, loop.id, contextPack);
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
    // Match model name to pricing — try exact match, then prefix match, then default
    const pricing =
      MODEL_PRICING[model] ??
      Object.entries(MODEL_PRICING).find(([key]) => model.includes(key))?.[1] ??
      MODEL_PRICING.default;

    totalCost +=
      (usage.input / 1_000_000) * pricing.input +
      (usage.output / 1_000_000) * pricing.output;
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

// ---------------------------------------------------------------------------
// ECS task launch
// ---------------------------------------------------------------------------

/**
 * Launch a Loop as an ECS Fargate task.
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
  // 1. Fetch loop record
  const loop = await loopsService.findById(loopId, organizationId);
  if (!loop) {
    throw new Error(`Loop not found: ${loopId}`);
  }

  if (loop.status !== "PENDING") {
    throw new Error(
      `Cannot launch loop in ${loop.status} status. Only PENDING loops can be launched.`
    );
  }

  log.info("[loop-orchestrator] Launching loop", {
    loopId,
    command: loop.command,
    repo: loop.repo,
    hasArtifact: !!loop.artifactId,
    hasParent: !!loop.parentLoopId,
  });

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

    // 4. Build context pack and upload to S3
    const s3ContextKey = await buildContextPack(loop, organizationId);
    const s3StateKey = getStateKeyPrefix(organizationId, loopId);

    // 5. Launch ECS task
    const closedLoopAuthToken = await issueLoopRunnerToken({
      loopId,
      organizationId,
    });
    const taskArn = await runEcsTask({
      loopId,
      organizationId,
      command: loop.command,
      s3StateKey,
      s3ContextKey,
      anthropicApiKey,
      githubToken,
      repo: loop.repo ?? undefined,
      closedLoopAuthToken,
    });

    // 6. Update loop status to CLAIMED
    await loopsService.updateStatus(loopId, organizationId, "CLAIMED", {
      containerId: taskArn,
      s3StateKey,
    });

    log.info("[loop-orchestrator] Loop launched successfully", {
      loopId,
      taskArn,
    });

    return taskArn;
  } catch (error) {
    // Mark loop as FAILED if launch fails
    const errorMessage =
      error instanceof Error ? error.message : "Unknown launch error";

    log.error("[loop-orchestrator] Failed to launch loop", {
      loopId,
      error: errorMessage,
    });

    // Transition PENDING -> CANCELLED (not FAILED, since it never ran)
    try {
      await loopsService.cancel(loopId, organizationId);
    } catch (cancelError) {
      log.error(
        "[loop-orchestrator] Failed to cancel loop after launch error",
        {
          loopId,
          cancelError,
        }
      );
    }

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
 * Run an ECS Fargate task with the given configuration.
 * Returns the task ARN.
 */
async function runEcsTask(opts: {
  loopId: string;
  organizationId: string;
  command: string;
  s3StateKey: string;
  s3ContextKey: string;
  anthropicApiKey: string;
  githubToken?: string;
  repo?: { fullName: string; branch: string };
  closedLoopAuthToken: string;
}): Promise<string> {
  const ecs = getEcsClient();
  const config = getEcsConfig();

  // Build environment variable overrides for the container
  const environment = [
    { name: "LOOP_ID", value: opts.loopId },
    { name: "ORGANIZATION_ID", value: opts.organizationId },
    { name: "COMMAND", value: opts.command },
    { name: "S3_STATE_KEY", value: opts.s3StateKey },
    { name: "S3_CONTEXT_KEY", value: opts.s3ContextKey },
    { name: "ANTHROPIC_API_KEY", value: opts.anthropicApiKey },
    { name: "CLOSEDLOOP_AUTH_TOKEN", value: opts.closedLoopAuthToken },
  ];

  if (opts.githubToken) {
    environment.push({ name: "GITHUB_TOKEN", value: opts.githubToken });
  }

  if (opts.repo) {
    environment.push({ name: "TARGET_REPO", value: opts.repo.fullName });
    environment.push({ name: "TARGET_BRANCH", value: opts.repo.branch });
  }

  // Add callback URL so the harness can report events back
  const apiBaseUrl = process.env.API_BASE_URL ?? process.env.LOOP_CALLBACK_URL;
  if (apiBaseUrl) {
    environment.push({ name: "API_BASE_URL", value: apiBaseUrl });
    environment.push({ name: "CALLBACK_URL", value: apiBaseUrl });
  }

  const command = new RunTaskCommand({
    cluster: config.cluster,
    taskDefinition: config.taskDefinition,
    launchType: "FARGATE",
    count: 1,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: config.subnets,
        securityGroups: [config.securityGroupId],
        assignPublicIp: "ENABLED",
      },
    },
    overrides: {
      containerOverrides: [
        {
          name: "harness-agent",
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
  event: LoopEvent
): Promise<void> {
  log.info("[loop-orchestrator] Handling loop event", {
    loopId,
    eventType: event.type,
  });

  switch (event.type) {
    case "started": {
      await loopsService.updateStatus(loopId, organizationId, "RUNNING", {
        startedAt: new Date(),
      });
      await loopsService.addEvent(loopId, {
        type: event.type,
        data: { loopId: event.loopId, timestamp: event.timestamp },
      });
      break;
    }

    case "output": {
      await loopsService.addEvent(loopId, {
        type: event.type,
        data: { chunk: event.chunk, timestamp: event.timestamp },
      });
      break;
    }

    case "progress": {
      await loopsService.addEvent(loopId, {
        type: event.type,
        data: {
          percent: event.percent,
          stage: event.stage,
          timestamp: event.timestamp,
        },
      });
      break;
    }

    case "tool_call": {
      await loopsService.addEvent(loopId, {
        type: event.type,
        data: {
          tool: event.tool,
          status: event.status,
          input: event.input,
          output: event.output,
          timestamp: event.timestamp,
        } as Record<string, unknown>,
      });
      break;
    }

    case "artifact_created": {
      await loopsService.addEvent(loopId, {
        type: event.type,
        data: {
          artifactId: event.artifactId,
          artifactType: event.artifactType,
          timestamp: event.timestamp,
        },
      });
      break;
    }

    case "completed": {
      await handleLoopCompleted(loopId, organizationId, event);
      break;
    }

    case "error": {
      await handleLoopError(loopId, organizationId, event);
      break;
    }

    default: {
      // Store unknown event types for forward compatibility
      await loopsService.addEvent(loopId, {
        type: (event as LoopEvent).type,
        data: event as unknown as Record<string, unknown>,
      });
      break;
    }
  }
}

/**
 * Handle loop completion: download metadata from S3, update token counts.
 */
async function handleLoopCompleted(
  loopId: string,
  organizationId: string,
  event: LoopEventCompleted
): Promise<void> {
  // Store the completion event
  await loopsService.addEvent(loopId, {
    type: event.type,
    data: {
      result: event.result,
      tokensUsed: event.tokensUsed,
      timestamp: event.timestamp,
    } as Record<string, unknown>,
  });

  // Try to download metadata from S3 for detailed token counts
  const metadata = await downloadMetadata(organizationId, loopId);

  const tokensInput = metadata?.tokensInput ?? event.tokensUsed.input;
  const tokensOutput = metadata?.tokensOutput ?? event.tokensUsed.output;
  const tokensByModel: TokensByModel | null =
    event.tokensByModel ?? metadata?.tokensByModel ?? null;

  // Calculate cost per model if we have breakdown, otherwise fall back to Opus pricing
  const estimatedCost = calculateCost(tokensInput, tokensOutput, tokensByModel);

  await loopsService.updateStatus(loopId, organizationId, "COMPLETED", {
    completedAt: new Date(),
    tokensInput,
    tokensOutput,
    tokensByModel: tokensByModel ?? undefined,
    estimatedCost,
  });

  log.info("[loop-orchestrator] Loop completed", {
    loopId,
    tokensInput,
    tokensOutput,
    tokensByModel,
    estimatedCost,
  });
}

/**
 * Handle loop error: mark as FAILED with error details.
 */
async function handleLoopError(
  loopId: string,
  organizationId: string,
  event: { type: "error"; code: string; message: string; timestamp: string }
): Promise<void> {
  if (event.code === "CANCELLED") {
    await loopsService.addEvent(loopId, {
      type: "cancelled",
      data: {
        reason: event.message,
        timestamp: event.timestamp,
      },
    });

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
    return;
  }

  // Store the error event
  await loopsService.addEvent(loopId, {
    type: event.type,
    data: {
      code: event.code,
      message: event.message,
      timestamp: event.timestamp,
    },
  });

  await loopsService.updateStatus(loopId, organizationId, "FAILED", {
    completedAt: new Date(),
    error: { code: event.code, message: event.message },
  });

  log.error("[loop-orchestrator] Loop failed", {
    loopId,
    errorCode: event.code,
    errorMessage: event.message,
  });
}
