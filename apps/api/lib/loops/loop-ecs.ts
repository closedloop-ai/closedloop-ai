/**
 * ECS infrastructure layer for loop orchestration.
 *
 * Manages the ECS client, configuration, task launching, and task stopping.
 * Pure AWS SDK wrapper — no business logic.
 */

import {
  ECSClient,
  RunTaskCommand,
  StopTaskCommand,
} from "@aws-sdk/client-ecs";
import { log } from "@repo/observability/log";
import { getAwsCredentials } from "@/lib/aws-credentials";

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
// Public API
// ---------------------------------------------------------------------------

export type RunEcsTaskOptions = {
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
