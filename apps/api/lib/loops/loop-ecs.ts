/**
 * ECS infrastructure layer for loop orchestration.
 *
 * Manages the ECS client, configuration, task launching, and task stopping.
 * Pure AWS SDK wrapper — no business logic.
 */

import { createHash } from "node:crypto";
import {
  ECSClient,
  RunTaskCommand,
  StopTaskCommand,
} from "@aws-sdk/client-ecs";
import { getAwsCredentials } from "@repo/aws/credentials";
import { log } from "@repo/observability/log";

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

// RunTask and StopTask are control-plane calls that normally answer in well
// under a second. Since the launch routes await dispatch on the request path
// under a 60s ceiling, bound each attempt explicitly: with the SDK default of 3
// attempts a hung socket would otherwise eat the whole request budget.
const ECS_CONNECTION_TIMEOUT_MS = 3000;
const ECS_REQUEST_TIMEOUT_MS = 10_000;

// Lazy-init ECS client
let _ecsClient: ECSClient | null = null;
function getEcsClient(): ECSClient {
  if (!_ecsClient) {
    _ecsClient = new ECSClient({
      region: process.env.AWS_REGION ?? "us-east-1",
      credentials: getAwsCredentials(),
      requestHandler: {
        connectionTimeout: ECS_CONNECTION_TIMEOUT_MS,
        requestTimeout: ECS_REQUEST_TIMEOUT_MS,
      },
    });
  }
  return _ecsClient;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type RunEcsTaskOptions = {
  loopId: string;
  /**
   * Identifier unique to this launch attempt — the runner token's JTI, which the
   * orchestrator issues fresh per launch. Feeds the RunTask idempotency token;
   * see `buildRunTaskClientToken`.
   */
  launchAttemptId: string;
  organizationId: string;
  command: string;
  s3StateKey: string;
  s3ContextKey: string;
  s3ContextUrl: string;
  repo?: { fullName: string; branch: string };
  closedLoopAuthToken: string;
  documentId?: string;
  parentS3StateKey?: string;
  parentSessionId?: string;
  parentBranchName?: string;
};

/**
 * Run an ECS task via capacity provider with the given configuration.
 * Returns the task ARN.
 */
export async function runEcsTask(opts: RunEcsTaskOptions): Promise<string> {
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

  if (opts.documentId) {
    environment.push({ name: "ARTIFACT_ID", value: opts.documentId });
  }

  if (opts.repo) {
    environment.push(
      { name: "TARGET_REPO", value: opts.repo.fullName },
      { name: "TARGET_BRANCH", value: opts.repo.branch }
    );
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
    // Makes the SDK's own retry idempotent — without it a retried throttle or
    // 5xx starts a second container for the same loop (ISS-5742).
    clientToken: buildRunTaskClientToken(opts.loopId, opts.launchAttemptId),
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

  // A send can fail after AWS already accepted the request (per-attempt
  // timeout, socket error). The clientToken keeps that from becoming a second
  // task, but the caller never learns the ARN, so `cleanupOnLaunchFailure` has
  // nothing to stop. Leave the operator a pointer: any such task carries the
  // `loop-id` tag set above. `warn`, not `error`, for the same reason as
  // `loop.launch_failed` — `dispatchAndClassify` owns the one error-level entry
  // per dropped dispatch.
  const result = await ecs.send(command).catch((error: unknown) => {
    log.warn("[loop-ecs] ECS RunTask failed; a task may have started", {
      loopId: opts.loopId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  });

  const task = result.tasks?.[0];
  if (!task?.taskArn) {
    const failureReason =
      result.failures?.[0]?.reason ?? "No task returned from RunTask";
    throw new Error(`ECS RunTask failed: ${failureReason}`);
  }

  log.info("[loop-ecs] ECS task started", {
    loopId: opts.loopId,
    taskArn: task.taskArn,
    lastStatus: task.lastStatus,
  });

  return task.taskArn;
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
 * Build the RunTask idempotency token for one launch attempt.
 *
 * The client keeps the SDK's default retry policy, so a throttle, a 5xx, or a
 * response lost after AWS already accepted the request is retried
 * automatically. Without a `clientToken` that retry starts a SECOND
 * `claude-runner` container for the same loop, and since only the first task
 * ARN is kept as `containerId`, the duplicate is unreachable by `stopLoopTask`.
 *
 * Derived from the loop id plus the launch attempt id so the token is stable
 * across every retry of one launch but distinct for a genuine relaunch of the
 * same loop. The pair is hashed rather than concatenated because two ids
 * together can exceed ECS's cap: a sha256 hex digest is exactly the 64
 * characters ECS allows, and every hex character is inside the ASCII 33-126
 * range it requires.
 */
function buildRunTaskClientToken(
  loopId: string,
  launchAttemptId: string
): string {
  return createHash("sha256")
    .update(`${loopId}:${launchAttemptId}`)
    .digest("hex");
}
