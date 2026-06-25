/**
 * Tests for resolveLoopLaunchContext() token resolution behavior (via launchLoop).
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import type * as LoopDesktop from "@/lib/loops/loop-desktop";

vi.mock("@aws-sdk/client-ecs", () => ({
  ECSClient: vi.fn(),
  RunTaskCommand: vi.fn(),
  StopTaskCommand: vi.fn(),
}));

vi.mock("@repo/github", () => ({
  getInstallationAccessToken: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  EvaluationReportType: { PLAN: "PLAN", CODE: "CODE" },
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    DEPLOYMENT: "DEPLOYMENT",
  },
}));

vi.mock("@/app/artifacts/service", () => ({
  getCommitterInfo: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/app/documents/document-service", () => ({
  getCommitterInfo: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/app/integrations/github/service", () => ({
  githubService: { findInstallationForRepoFullName: vi.fn() },
}));

vi.mock("@/app/loops/service", () => ({
  loopsService: {
    findById: vi.fn().mockResolvedValue(null),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    addEvent: vi.fn().mockResolvedValue(undefined),
    persistLaunchInfo: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/app/loops/loop-errors", () => ({
  isInvalidStatusTransitionError: vi.fn().mockReturnValue(false),
}));

vi.mock("@/app/settings/api-key-service", () => ({
  apiKeyService: { resolveApiKey: vi.fn() },
}));

vi.mock("@repo/auth/loop-runner-jwt", async (importOriginal) => {
  const { createLoopRunnerJwtMockModule } = await import(
    "../fixtures/mock-modules"
  );
  return createLoopRunnerJwtMockModule(importOriginal, {
    token: "runner-jwt-token",
  });
});

vi.mock("@/lib/aws-credentials", () => ({
  getAwsCredentials: vi.fn(),
}));

vi.mock("@/lib/loops/loop-state", () => ({
  downloadMetadata: vi.fn().mockResolvedValue(null),
  downloadArtifactFile: vi.fn().mockResolvedValue(null),
  downloadPromptSnapshotMarkdownEntries: vi.fn().mockResolvedValue([]),
  getStateKeyPrefix: vi.fn().mockReturnValue("org/loops/loop-1/run-1"),
  generateDownloadUrl: vi.fn().mockResolvedValue("https://mock-url"),
  scrubContextPackSecrets: vi.fn().mockResolvedValue(undefined),
  uploadContextPack: vi.fn().mockResolvedValue("s3://mock-key"),
}));

vi.mock("@/lib/loops/loop-commands", () => ({
  getCommandHandler: () => ({
    requiresRepo: true,
    requiresParent: false,
    includePrimaryArtifact: false,
    downloadAndIngest: vi.fn(),
  }),
  COMMAND_HANDLERS: {},
}));

vi.mock("@/lib/loops/loop-context-pack", () => ({
  buildContextPack: vi.fn().mockResolvedValue("s3://mock-context-key"),
  buildContextPackInMemory: vi.fn().mockResolvedValue({
    artifacts: [],
    prompt: null,
    repoInfo: null,
    committer: null,
  }),
}));

vi.mock("@/lib/desktop-command-store", () => ({
  desktopCommandStore: {
    createCommand: vi.fn().mockResolvedValue({
      command: { commandId: "cmd-desktop-1" },
    }),
    markCommandExpired: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/loops/loop-desktop", async (importActual) => {
  const actual = await importActual<typeof LoopDesktop>();
  return {
    buildDesktopLoopExecutionBody: actual.buildDesktopLoopExecutionBody,
    DispatchError: actual.DispatchError,
    isDispatchError: actual.isDispatchError,
    launchLoopOnDesktop: vi.fn().mockResolvedValue("cmd-desktop-1"),
    stopDesktopLoop: vi.fn().mockResolvedValue(undefined),
  };
});

const mockRunEcsTask = vi.fn().mockResolvedValue("ecs-task-arn");
vi.mock("@/lib/loops/loop-ecs", () => ({
  runEcsTask: (...args: unknown[]) => mockRunEcsTask(...args),
  stopLoopTask: vi.fn().mockResolvedValue(undefined),
}));

import { HarnessType } from "@repo/api/src/types/compute-target";
import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import { issueLoopRunnerToken } from "@repo/auth/loop-runner-jwt";
import { withDb } from "@repo/database";
import { getInstallationAccessToken } from "@repo/github";
import { githubService } from "@/app/integrations/github/service";
import { loopsService } from "@/app/loops/service";
import { apiKeyService } from "@/app/settings/api-key-service";
import { buildContextPackInMemory } from "@/lib/loops/loop-context-pack";
import {
  buildDesktopLoopExecutionCredentials,
  launchLoop,
} from "@/lib/loops/loop-orchestrator";
import { uploadContextPack } from "@/lib/loops/loop-state";
import { buildLoop } from "../fixtures/loop";

type MockFn = ReturnType<typeof vi.fn>;

const mockLoopsService = loopsService as unknown as {
  findById: MockFn;
  updateStatus: MockFn;
  addEvent: MockFn;
  cancel: MockFn;
};

const mockApiKeyService = apiKeyService as unknown as { resolveApiKey: MockFn };
const mockGithubService = githubService as unknown as {
  findInstallationForRepoFullName: MockFn;
};
const mockGetInstallationAccessToken = getInstallationAccessToken as MockFn;
const mockWithDb = withDb as unknown as Mock;
const mockBuildContextPackInMemory =
  buildContextPackInMemory as unknown as MockFn;
const mockUploadContextPack = uploadContextPack as unknown as MockFn;
const mockIssueLoopRunnerToken = issueLoopRunnerToken as unknown as MockFn;

function restoreEnvVar(name: string, value: string | undefined) {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
    return;
  }
  process.env[name] = value;
}

// ---------------------------------------------------------------------------
// resolveLoopLaunchContext — token resolution via launchLoop
// ---------------------------------------------------------------------------

describe("resolveLoopLaunchContext — token resolution for ECS launches", () => {
  const originalApiBaseUrl = process.env.API_BASE_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.API_BASE_URL = "https://api.test";

    mockApiKeyService.resolveApiKey.mockResolvedValue("sk-anthropic-key");
    mockGithubService.findInstallationForRepoFullName.mockResolvedValue(
      "installation-123"
    );
    mockGetInstallationAccessToken.mockResolvedValue("ghs-github-token");
    mockRunEcsTask.mockResolvedValue("ecs-task-arn");
    mockLoopsService.updateStatus.mockResolvedValue(undefined);
    mockWithDb.mockResolvedValue({ slug: "my-artifact" });
  });

  afterEach(() => {
    restoreEnvVar("API_BASE_URL", originalApiBaseUrl);
  });

  it.each<{
    scenario: string;
    additionalRepos?: { fullName: string; branch: string }[] | null;
    tokenOverride?: () => void;
    expectedError?: string;
    assert: (ctx: typeof expect) => void;
  }>([
    {
      scenario: "token resolution failure cancels the loop",
      tokenOverride: () =>
        mockGetInstallationAccessToken.mockRejectedValue(
          new Error("GitHub App auth failed")
        ),
      expectedError: "GitHub App auth failed",
      assert: (expect) => {
        expect(mockLoopsService.cancel).toHaveBeenCalledWith("loop-1", "org-1");
      },
    },
    {
      scenario: "valid additionalRepos resolves extra installation tokens",
      additionalRepos: [{ fullName: "org/extra-repo", branch: "main" }],
      assert: (expect) => {
        expect(mockGetInstallationAccessToken).toHaveBeenCalledTimes(2);
        expect(
          mockGithubService.findInstallationForRepoFullName
        ).toHaveBeenCalledWith("org-1", "org/extra-repo");
      },
    },
  ])("$scenario", async ({
    additionalRepos,
    tokenOverride,
    expectedError,
    assert,
  }) => {
    tokenOverride?.();
    const loop = buildLoop({
      status: LoopStatus.Pending,
      computeTargetId: null,
      repo: { fullName: "org/repo", branch: "main" },
      additionalRepos: additionalRepos ?? null,
    });
    mockLoopsService.findById.mockResolvedValue(loop);

    if (expectedError) {
      await expect(launchLoop("loop-1", "org-1")).rejects.toThrow(
        expectedError
      );
    } else {
      await launchLoop("loop-1", "org-1");
    }

    assert(expect);
  });
});

describe("launchLoop — ECS EVALUATE_CODE context simulation", () => {
  const originalApiBaseUrl = process.env.API_BASE_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.API_BASE_URL = "https://api.test";

    mockApiKeyService.resolveApiKey.mockResolvedValue("sk-anthropic-key");
    mockGithubService.findInstallationForRepoFullName.mockResolvedValue(
      "installation-123"
    );
    mockGetInstallationAccessToken.mockResolvedValue("ghs-github-token");
    mockRunEcsTask.mockResolvedValue("arn:aws:ecs:task/mock-task");
    mockLoopsService.updateStatus.mockResolvedValue(undefined);
    mockWithDb.mockResolvedValue({ slug: "fea-585-evaluation" });
  });

  afterEach(() => {
    restoreEnvVar("API_BASE_URL", originalApiBaseUrl);
  });

  it("launches EVALUATE_CODE on ECS with uploaded context and parent state", async () => {
    const contextPack = {
      artifacts: [],
      prompt: "evaluate this implementation",
      repoInfo: { fullName: "closedloop/symphony-alpha", branch: "fea-585" },
      committer: null,
      codeEvaluationContext: {
        schemaVersion: 1,
        pullRequest: {
          number: 585,
          url: "https://github.com/closedloop/symphony-alpha/pull/585",
          headBranch: "fea-585",
          baseBranch: "main",
          headSha: "abc123",
          repositoryFullName: "closedloop/symphony-alpha",
        },
      },
    };
    const loop = buildLoop({
      status: LoopStatus.Pending,
      command: LoopCommand.EvaluateCode,
      documentId: "doc-fea-585",
      parentLoopId: "parent-loop-1",
      computeTargetId: null,
      repo: { fullName: "closedloop/symphony-alpha", branch: "fea-585" },
    });
    const parentLoop = buildLoop({
      id: "parent-loop-1",
      s3StateKey: "org/loops/parent-loop-1/run-1",
      branchName: "parent-branch",
      sessionId: "parent-session-1",
    });

    mockBuildContextPackInMemory.mockResolvedValue(contextPack);
    mockLoopsService.findById
      .mockResolvedValueOnce(loop)
      .mockResolvedValueOnce(parentLoop);

    await launchLoop("loop-1", "org-1");

    expect(mockBuildContextPackInMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        command: LoopCommand.EvaluateCode,
        documentId: "doc-fea-585",
        computeTargetId: null,
      }),
      "org-1",
      expect.objectContaining({
        anthropicApiKey: "sk-anthropic-key",
        githubToken: "ghs-github-token",
      }),
      undefined,
      undefined
    );
    expect(mockUploadContextPack).toHaveBeenCalledWith(
      "org/loops/loop-1/run-1",
      contextPack
    );
    expect(mockRunEcsTask).toHaveBeenCalledOnce();
    expect(mockRunEcsTask).toHaveBeenCalledWith(
      expect.objectContaining({
        command: LoopCommand.EvaluateCode,
        documentId: "doc-fea-585",
        s3StateKey: "org/loops/loop-1/run-1",
        s3ContextKey: "s3://mock-key",
        s3ContextUrl: "https://mock-url",
        repo: { fullName: "closedloop/symphony-alpha", branch: "fea-585" },
        parentS3StateKey: "org/loops/parent-loop-1/run-1",
        parentBranchName: "parent-branch",
        parentSessionId: "parent-session-1",
      })
    );
    expect(mockLoopsService.updateStatus).toHaveBeenCalledWith(
      "loop-1",
      "org-1",
      LoopStatus.Claimed,
      expect.objectContaining({
        containerId: "arn:aws:ecs:task/mock-task",
        s3StateKey: "org/loops/loop-1/run-1",
      })
    );
  });
});

describe("buildDesktopLoopExecutionCredentials", () => {
  const originalApiBaseUrl = process.env.API_BASE_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.API_BASE_URL = "https://api.test";

    mockApiKeyService.resolveApiKey.mockResolvedValue("sk-anthropic-key");
    mockBuildContextPackInMemory.mockResolvedValue({
      artifacts: [],
      prompt: null,
      repoInfo: null,
      committer: null,
    });
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        loop: {
          findUnique: vi.fn().mockResolvedValue({
            activeTokenJti: "jti-existing",
            tokenExpiresAt: new Date("2026-06-09T01:00:00.000Z"),
          }),
        },
        computeTarget: {
          findUnique: vi.fn().mockResolvedValue({ capabilities: {} }),
        },
      })
    );
  });

  afterEach(() => {
    restoreEnvVar("API_BASE_URL", originalApiBaseUrl);
  });

  it("includes the loop harness in the signed Desktop credential body", async () => {
    mockLoopsService.findById.mockResolvedValue(
      buildLoop({
        status: LoopStatus.Claimed,
        computeTargetId: "target-1",
        documentId: null,
        harness: HarnessType.Codex,
        repo: null,
      })
    );

    const body = await buildDesktopLoopExecutionCredentials({
      loopId: "loop-1",
      organizationId: "org-1",
      action: "loop.launch",
    });

    expect(body).toEqual(
      expect.objectContaining({ harness: HarnessType.Codex })
    );
  });
});

// ---------------------------------------------------------------------------
// launchLoop — db.loop.update JTI pin (AC-006 / scenarios 15-16)
// ---------------------------------------------------------------------------

describe("launchLoop — db.loop.updateMany JTI pin before dispatch", () => {
  const originalApiBaseUrl = process.env.API_BASE_URL;

  let mockLoopUpdateMany: MockFn;
  let mockArtifactFindUnique: MockFn;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.API_BASE_URL = "https://api.test";

    mockApiKeyService.resolveApiKey.mockResolvedValue("sk-anthropic-key");
    mockGithubService.findInstallationForRepoFullName.mockResolvedValue(
      "installation-123"
    );
    mockGetInstallationAccessToken.mockResolvedValue("ghs-github-token");
    mockRunEcsTask.mockResolvedValue("ecs-task-arn");
    mockLoopsService.updateStatus.mockResolvedValue(undefined);

    mockLoopUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    mockArtifactFindUnique = vi.fn().mockResolvedValue({ slug: "my-artifact" });

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        loop: { updateMany: mockLoopUpdateMany },
        artifact: { findUnique: mockArtifactFindUnique },
        computeTarget: { findUnique: vi.fn().mockResolvedValue(null) },
      })
    );
  });

  afterEach(() => {
    restoreEnvVar("API_BASE_URL", originalApiBaseUrl);
  });

  it("calls db.loop.updateMany exactly once with activeTokenJti, tokenExpiresAt, and runnerCapabilities scoped by organizationId before dispatch (scenario 15 — ECS loop)", async () => {
    const loop = buildLoop({
      status: LoopStatus.Pending,
      computeTargetId: null,
      repo: { fullName: "org/repo", branch: "main" },
    });
    mockLoopsService.findById.mockResolvedValue(loop);

    await launchLoop("loop-1", "org-1");

    const tokenResult = await mockIssueLoopRunnerToken.mock.results[0].value;

    expect(mockLoopUpdateMany).toHaveBeenCalledOnce();
    expect(mockLoopUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "loop-1", organizationId: "org-1" },
        data: expect.objectContaining({
          activeTokenJti: tokenResult.tokenId,
          tokenExpiresAt: tokenResult.expiresAt,
          runnerCapabilities: {},
        }),
      })
    );
  });

  it("calls db.loop.updateMany before provider dispatch — not after (scenario 16)", async () => {
    const callOrder: string[] = [];

    mockLoopUpdateMany.mockImplementation(() => {
      callOrder.push("db.loop.updateMany");
      return Promise.resolve({ count: 1 });
    });
    mockRunEcsTask.mockImplementation((..._args: unknown[]) => {
      callOrder.push("runEcsTask");
      return Promise.resolve("ecs-task-arn");
    });

    const loop = buildLoop({
      status: LoopStatus.Pending,
      computeTargetId: null,
      repo: { fullName: "org/repo", branch: "main" },
    });
    mockLoopsService.findById.mockResolvedValue(loop);

    await launchLoop("loop-1", "org-1");

    const dbUpdateIdx = callOrder.indexOf("db.loop.updateMany");
    const dispatchIdx = callOrder.indexOf("runEcsTask");
    expect(dbUpdateIdx).toBeGreaterThanOrEqual(0);
    expect(dispatchIdx).toBeGreaterThanOrEqual(0);
    expect(dbUpdateIdx).toBeLessThan(dispatchIdx);
  });
});
