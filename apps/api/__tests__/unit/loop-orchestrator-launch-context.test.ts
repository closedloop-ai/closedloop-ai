/**
 * Tests for resolveLoopLaunchContext() token resolution behavior (via launchLoop).
 */

import { vi } from "vitest";
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
}));

vi.mock("@/app/artifacts/service", () => ({
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

vi.mock("@repo/auth/loop-runner-jwt", () => ({
  issueLoopRunnerToken: vi.fn().mockResolvedValue("runner-jwt-token"),
}));

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

import { LoopStatus } from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { getInstallationAccessToken } from "@repo/github";
import { afterEach, beforeEach, describe, expect, it, type Mock } from "vitest";
import { githubService } from "@/app/integrations/github/service";
import { loopsService } from "@/app/loops/service";
import { apiKeyService } from "@/app/settings/api-key-service";
import { launchLoop } from "@/lib/loops/loop-orchestrator";
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

// ---------------------------------------------------------------------------
// resolveLoopLaunchContext — token resolution via launchLoop
// ---------------------------------------------------------------------------

describe("resolveLoopLaunchContext — token resolution for ECS launches", () => {
  const originalEnv = { ...process.env };

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
    process.env.API_BASE_URL = originalEnv.API_BASE_URL;
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
