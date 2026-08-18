/**
 * ISS-5742 — RunTask must carry a per-launch idempotency token.
 *
 * The ECS client keeps the SDK's default retry policy, so a throttle, a 5xx, or
 * a response lost after AWS already accepted the request is retried
 * automatically. Without `clientToken` that retry starts a second
 * `claude-runner` container for the same loop, and because only the first task
 * ARN is kept as `containerId`, the duplicate is unreachable by `stopLoopTask`.
 *
 * Covers both halves of the fix:
 * - `runEcsTask` sends a clientToken that is stable per launch attempt, distinct
 *   across attempts, and inside ECS's 64-character / ASCII 33-126 contract.
 * - The ECS client is built with explicit connection/request timeouts so a hung
 *   RunTask cannot eat the launch route's whole request budget.
 * - `EcsComputeProvider.dispatch` — the production caller — actually threads the
 *   launch attempt id through, so deleting that wiring fails this suite.
 */

import { LoopCommand } from "@repo/api/src/types/loop";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LaunchContext,
  PreparedContext,
} from "@/lib/loops/compute-provider";

type EcsClientConfig = {
  requestHandler?: {
    connectionTimeout?: number;
    requestTimeout?: number;
  };
};

type RunTaskInput = {
  clientToken?: string;
};

const ecsClientConfigs: EcsClientConfig[] = [];
const runTaskInputs: RunTaskInput[] = [];
const sendMock = vi.fn();
const logWarnMock = vi.fn();

vi.mock("@aws-sdk/client-ecs", () => {
  class EcsClientMock {
    send = sendMock;
    constructor(config: EcsClientConfig) {
      ecsClientConfigs.push(config);
    }
  }

  class RunTaskCommandMock {
    constructor(input: RunTaskInput) {
      runTaskInputs.push(input);
    }
  }

  class StopTaskCommandMock {}

  return {
    ECSClient: EcsClientMock,
    RunTaskCommand: RunTaskCommandMock,
    StopTaskCommand: StopTaskCommandMock,
  };
});

vi.mock("@repo/aws/credentials", () => ({
  getAwsCredentials: vi.fn(() => undefined),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: logWarnMock, error: vi.fn() },
}));

const ECS_ENV: Record<string, string> = {
  ECS_CLUSTER_NAME: "test-cluster",
  ECS_TASK_DEFINITION: "test-task-def",
  ECS_SUBNETS: "subnet-a,subnet-b",
  ECS_SECURITY_GROUP_ID: "sg-test",
  ECS_CAPACITY_PROVIDER: "test-capacity-provider",
  API_BASE_URL: "https://api.test.invalid",
};

const originalEnv = new Map<string, string | undefined>();

// ECS accepts clientToken characters in the ASCII 33-126 range, up to 64 chars.
const ECS_CLIENT_TOKEN_PATTERN = /^[!-~]{1,64}$/;

const LOOP_ID = "loop-1111-2222-3333";
const LAUNCH_ATTEMPT_ID = "jti-aaaa-bbbb-cccc";

function baseRunEcsTaskOptions(overrides: Record<string, string> = {}) {
  return {
    loopId: LOOP_ID,
    launchAttemptId: LAUNCH_ATTEMPT_ID,
    organizationId: "org-1",
    command: LoopCommand.Execute,
    s3StateKey: "org-1/loops/loop-1/run-1",
    s3ContextKey: "org-1/loops/loop-1/run-1/context-pack.json",
    s3ContextUrl: "https://s3.test.invalid/context-pack.json",
    closedLoopAuthToken: "token",
    ...overrides,
  };
}

function launchContext(overrides: Partial<LaunchContext> = {}): LaunchContext {
  return {
    loopId: LOOP_ID,
    organizationId: "org-1",
    userId: "user-1",
    command: LoopCommand.Execute,
    contextPack: { command: LoopCommand.Execute, artifacts: [] },
    closedLoopAuthToken: "token",
    tokenId: LAUNCH_ATTEMPT_ID,
    expiresAt: new Date("2026-08-12T00:00:00.000Z"),
    apiBaseUrl: ECS_ENV.API_BASE_URL,
    anthropicApiKey: undefined,
    githubToken: undefined,
    committer: undefined,
    repo: null,
    documentId: null,
    documentSlug: undefined,
    parentLoopId: null,
    parentS3StateKey: null,
    parentBranchName: null,
    parentSessionId: null,
    localRepoPath: undefined,
    computeTargetId: null,
    runnerCapabilities: {},
    ...overrides,
  };
}

const PREPARED_CONTEXT: PreparedContext = {
  s3StateKey: "org-1/loops/loop-1/run-1",
  s3ContextKey: "org-1/loops/loop-1/run-1/context-pack.json",
  s3ContextUrl: "https://s3.test.invalid/context-pack.json",
};

beforeEach(() => {
  vi.resetModules();
  ecsClientConfigs.length = 0;
  runTaskInputs.length = 0;
  sendMock.mockReset();
  logWarnMock.mockReset();
  sendMock.mockResolvedValue({
    tasks: [
      {
        taskArn: "arn:aws:ecs:us-east-1:1:task/abc",
        lastStatus: "PROVISIONING",
      },
    ],
  });

  for (const [key, value] of Object.entries(ECS_ENV)) {
    originalEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
});

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  originalEnv.clear();
});

describe("ISS-5742: runEcsTask idempotency token", () => {
  it("sends a clientToken that satisfies the ECS format contract", async () => {
    const { runEcsTask } = await import("@/lib/loops/loop-ecs");

    await runEcsTask(baseRunEcsTaskOptions());

    expect(runTaskInputs).toHaveLength(1);
    expect(runTaskInputs[0].clientToken).toMatch(ECS_CLIENT_TOKEN_PATTERN);
  });

  it("reuses the same clientToken for the same loop and launch attempt", async () => {
    const { runEcsTask } = await import("@/lib/loops/loop-ecs");

    await runEcsTask(baseRunEcsTaskOptions());
    await runEcsTask(baseRunEcsTaskOptions());

    expect(runTaskInputs[0].clientToken).toBe(runTaskInputs[1].clientToken);
  });

  it("issues a different clientToken for a later launch attempt of the same loop", async () => {
    const { runEcsTask } = await import("@/lib/loops/loop-ecs");

    await runEcsTask(baseRunEcsTaskOptions());
    await runEcsTask(
      baseRunEcsTaskOptions({ launchAttemptId: "jti-dddd-eeee-ffff" })
    );

    expect(runTaskInputs[0].clientToken).not.toBe(runTaskInputs[1].clientToken);
  });

  it("issues a different clientToken for a different loop on the same attempt id", async () => {
    const { runEcsTask } = await import("@/lib/loops/loop-ecs");

    await runEcsTask(baseRunEcsTaskOptions());
    await runEcsTask(baseRunEcsTaskOptions({ loopId: "loop-9999" }));

    expect(runTaskInputs[0].clientToken).not.toBe(runTaskInputs[1].clientToken);
  });

  it("builds the ECS client with explicit connection and request timeouts", async () => {
    const { runEcsTask } = await import("@/lib/loops/loop-ecs");

    await runEcsTask(baseRunEcsTaskOptions());

    expect(ecsClientConfigs).toHaveLength(1);
    const { requestHandler } = ecsClientConfigs[0];
    expect(requestHandler?.connectionTimeout).toBeGreaterThan(0);
    expect(requestHandler?.requestTimeout).toBeGreaterThan(0);
    // Three SDK attempts must still fit inside the launch route's 60s ceiling.
    // Worst case per attempt is a hung socket followed by a hung request, so
    // the budget is (connectionTimeout + requestTimeout), not requestTimeout alone.
    const worstCaseAttemptMs =
      (requestHandler?.connectionTimeout ?? 0) +
      (requestHandler?.requestTimeout ?? 0);
    expect(worstCaseAttemptMs * 3).toBeLessThan(60_000);
  });

  it("rethrows a failed send after logging the loop id a started task would be tagged with", async () => {
    const { runEcsTask } = await import("@/lib/loops/loop-ecs");
    sendMock.mockRejectedValue(new Error("socket hang up"));

    await expect(runEcsTask(baseRunEcsTaskOptions())).rejects.toThrow(
      "socket hang up"
    );
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("a task may have started"),
      expect.objectContaining({ loopId: LOOP_ID })
    );
  });
});

describe("ISS-5742: EcsComputeProvider threads the launch attempt id", () => {
  it("derives the clientToken from the launch context token id", async () => {
    const { EcsComputeProvider } = await import(
      "@/lib/loops/ecs-compute-provider"
    );
    const { runEcsTask } = await import("@/lib/loops/loop-ecs");
    const provider = new EcsComputeProvider();

    await provider.dispatch(launchContext(), PREPARED_CONTEXT);
    await provider.dispatch(
      launchContext({ tokenId: "jti-dddd-eeee-ffff" }),
      PREPARED_CONTEXT
    );
    // Same loop, same JTI as the first dispatch: the token must match it.
    await runEcsTask(baseRunEcsTaskOptions());

    expect(runTaskInputs).toHaveLength(3);
    expect(runTaskInputs[0].clientToken).not.toBe(runTaskInputs[1].clientToken);
    expect(runTaskInputs[0].clientToken).toBe(runTaskInputs[2].clientToken);
  });
});
