/**
 * Tests for resolveLoopLaunchContext() token resolution behavior (via launchLoop),
 * and normalizeAdditionalRepos() pure function behavior.
 *
 * Covers:
 * - resolveLoopLaunchContext: resolves GitHub token for ECS launches with a repo
 * - resolveLoopLaunchContext: fails fast (throws) when token resolution fails
 * - resolveLoopLaunchContext: omits anthropicApiKey and githubToken for desktop launches
 * - resolveLoopLaunchContext: Zod metadata parsing — invalid entries are skipped
 * - normalizeAdditionalRepos: deduplicates by fullName (keeps first)
 * - normalizeAdditionalRepos: excludes primary repo
 * - normalizeAdditionalRepos: returns undefined for empty result
 */

import { vi } from "vitest";

// --- Mocks (must come before imports) ---

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
  isInvalidStatusTransitionError: vi.fn().mockReturnValue(false),
}));

vi.mock("@/app/settings/api-key-service", () => ({
  apiKeyService: { resolveApiKey: vi.fn() },
}));

vi.mock("@/lib/auth/loop-runner-jwt", () => ({
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
  const actual =
    await importActual<typeof import("@/lib/loops/loop-desktop")>();
  return {
    DispatchError: actual.DispatchError,
    isDispatchError: actual.isDispatchError,
    launchLoopOnDesktop: vi.fn().mockResolvedValue("cmd-desktop-1"),
    stopDesktopLoop: vi.fn().mockResolvedValue(undefined),
  };
});

// ECS provider mock — captured here so tests can inspect launch calls
const mockRunEcsTask = vi.fn().mockResolvedValue("ecs-task-arn");
vi.mock("@/lib/loops/loop-ecs", () => ({
  runEcsTask: (...args: unknown[]) => mockRunEcsTask(...args),
  stopLoopTask: vi.fn().mockResolvedValue(undefined),
}));

// --- Imports (after mocks) ---

import type { JsonObject } from "@repo/api/src/types/common";
import { withDb } from "@repo/database";
import { getInstallationAccessToken } from "@repo/github";
import { afterEach, beforeEach, describe, expect, it, type Mock } from "vitest";
import { normalizeAdditionalRepos } from "@/app/artifacts/[id]/run-loop/run-loop-helpers";
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
// normalizeAdditionalRepos — pure function tests
// ---------------------------------------------------------------------------

describe("normalizeAdditionalRepos — deduplication", () => {
  it("deduplicates by fullName and keeps the first occurrence", () => {
    const entries = [
      { fullName: "org/repo-a", branch: "main" },
      { fullName: "org/repo-a", branch: "develop" }, // duplicate — branch differs, still skipped
      { fullName: "org/repo-b", branch: "main" },
    ];

    const result = normalizeAdditionalRepos(entries, undefined);

    expect(result).toEqual([
      { fullName: "org/repo-a", branch: "main" },
      { fullName: "org/repo-b", branch: "main" },
    ]);
  });

  it("returns exactly one entry when all entries share the same fullName", () => {
    const entries = [
      { fullName: "org/same", branch: "main" },
      { fullName: "org/same", branch: "feat-1" },
      { fullName: "org/same", branch: "feat-2" },
    ];

    const result = normalizeAdditionalRepos(entries, undefined);

    expect(result).toEqual([{ fullName: "org/same", branch: "main" }]);
  });
});

describe("normalizeAdditionalRepos — primary repo exclusion", () => {
  it("excludes entries whose fullName matches the primary repo", () => {
    const entries = [
      { fullName: "org/primary", branch: "main" },
      { fullName: "org/secondary", branch: "main" },
    ];

    const result = normalizeAdditionalRepos(entries, "org/primary");

    expect(result).toEqual([{ fullName: "org/secondary", branch: "main" }]);
  });

  it("excludes all entries when they all match the primary repo", () => {
    const entries = [
      { fullName: "org/primary", branch: "main" },
      { fullName: "org/primary", branch: "develop" },
    ];

    const result = normalizeAdditionalRepos(entries, "org/primary");

    expect(result).toBeUndefined();
  });

  it("includes all entries when primaryFullName is undefined", () => {
    const entries = [
      { fullName: "org/repo-a", branch: "main" },
      { fullName: "org/repo-b", branch: "main" },
    ];

    const result = normalizeAdditionalRepos(entries, undefined);

    expect(result).toEqual(entries);
  });
});

describe("normalizeAdditionalRepos — returns undefined for empty result", () => {
  it("returns undefined when the input array is empty", () => {
    const result = normalizeAdditionalRepos([], undefined);

    expect(result).toBeUndefined();
  });

  it("returns undefined when all entries are filtered out", () => {
    const entries = [{ fullName: "org/primary", branch: "main" }];

    const result = normalizeAdditionalRepos(entries, "org/primary");

    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveLoopLaunchContext — token resolution (tested via launchLoop)
// ---------------------------------------------------------------------------

describe("resolveLoopLaunchContext — token resolution for ECS launches", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.API_BASE_URL = "https://api.test";

    // Default ECS setup — no computeTargetId means cloud/ECS path
    mockApiKeyService.resolveApiKey.mockResolvedValue("sk-anthropic-key");
    mockGithubService.findInstallationForRepoFullName.mockResolvedValue(
      "installation-123"
    );
    mockGetInstallationAccessToken.mockResolvedValue("ghs-github-token");
    mockRunEcsTask.mockResolvedValue("ecs-task-arn");
    mockLoopsService.updateStatus.mockResolvedValue(undefined);
    // withDb is used to fetch artifact slug
    mockWithDb.mockResolvedValue({ slug: "my-artifact" });
  });

  afterEach(() => {
    process.env.API_BASE_URL = originalEnv.API_BASE_URL;
  });

  it("resolves GitHub installation token for ECS launch when loop has a repo", async () => {
    const loop = buildLoop({
      status: "PENDING",
      computeTargetId: null, // ECS path
      repo: { fullName: "org/repo", branch: "main" },
    });
    mockLoopsService.findById.mockResolvedValue(loop);

    await launchLoop("loop-1", "org-1");

    expect(
      mockGithubService.findInstallationForRepoFullName
    ).toHaveBeenCalledWith("org-1", "org/repo");
    expect(mockGetInstallationAccessToken).toHaveBeenCalledWith(
      "installation-123"
    );
  });

  it("does not resolve GitHub token for ECS launch when loop has no repo", async () => {
    const loop = buildLoop({
      status: "PENDING",
      computeTargetId: null, // ECS path
      repo: null,
    });
    mockLoopsService.findById.mockResolvedValue(loop);

    await launchLoop("loop-1", "org-1");

    expect(
      mockGithubService.findInstallationForRepoFullName
    ).not.toHaveBeenCalled();
    expect(mockGetInstallationAccessToken).not.toHaveBeenCalled();
  });
});

describe("resolveLoopLaunchContext — fails fast when token resolution fails", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.API_BASE_URL = "https://api.test";

    mockApiKeyService.resolveApiKey.mockResolvedValue("sk-anthropic-key");
    mockLoopsService.cancel.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env.API_BASE_URL = originalEnv.API_BASE_URL;
  });

  it("throws and cancels loop when GitHub installation token resolution fails", async () => {
    const loop = buildLoop({
      status: "PENDING",
      computeTargetId: null, // ECS path
      repo: { fullName: "org/repo", branch: "main" },
    });
    mockLoopsService.findById.mockResolvedValue(loop);
    mockGithubService.findInstallationForRepoFullName.mockResolvedValue(
      "installation-123"
    );
    mockGetInstallationAccessToken.mockRejectedValue(
      new Error("GitHub App auth failed")
    );

    await expect(launchLoop("loop-1", "org-1")).rejects.toThrow(
      "GitHub App auth failed"
    );

    expect(mockLoopsService.cancel).toHaveBeenCalledWith("loop-1", "org-1");
  });

  it("throws and cancels loop when Anthropic API key is missing", async () => {
    const loop = buildLoop({
      status: "PENDING",
      computeTargetId: null, // ECS path
    });
    mockLoopsService.findById.mockResolvedValue(loop);
    mockApiKeyService.resolveApiKey.mockResolvedValue(null); // no key configured

    await expect(launchLoop("loop-1", "org-1")).rejects.toThrow(
      "No Anthropic API key configured"
    );

    expect(mockLoopsService.cancel).toHaveBeenCalledWith("loop-1", "org-1");
  });
});

describe("resolveLoopLaunchContext — omits tokens for desktop launches", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.API_BASE_URL = "https://api.test";

    mockWithDb.mockResolvedValue({ slug: "my-artifact" });
    mockRunEcsTask.mockResolvedValue("ecs-task-arn");
  });

  afterEach(() => {
    process.env.API_BASE_URL = originalEnv.API_BASE_URL;
  });

  it("does not call resolveApiKey or findInstallationForRepoFullName for desktop loops", async () => {
    const loop = buildLoop({
      status: "PENDING",
      computeTargetId: "target-desktop-1", // desktop path
      repo: { fullName: "org/repo", branch: "main" },
    });
    mockLoopsService.findById.mockResolvedValue(loop);
    mockLoopsService.updateStatus.mockResolvedValue(undefined);

    // Desktop dispatch succeeds — mock is set in top-level mock
    await launchLoop("loop-1", "org-1");

    expect(mockApiKeyService.resolveApiKey).not.toHaveBeenCalled();
    expect(
      mockGithubService.findInstallationForRepoFullName
    ).not.toHaveBeenCalled();
    expect(mockGetInstallationAccessToken).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resolveLoopLaunchContext — Zod metadata parsing validation
// ---------------------------------------------------------------------------

describe("resolveLoopLaunchContext — Zod metadata parsing skips invalid entries", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.API_BASE_URL = "https://api.test";

    mockApiKeyService.resolveApiKey.mockResolvedValue("sk-anthropic-key");
    mockGithubService.findInstallationForRepoFullName.mockResolvedValue(
      "installation-123"
    );
    mockGetInstallationAccessToken.mockResolvedValue("ghs-token");
    mockRunEcsTask.mockResolvedValue("ecs-task-arn");
    mockLoopsService.updateStatus.mockResolvedValue(undefined);
    mockWithDb.mockResolvedValue({ slug: "my-artifact" });
  });

  afterEach(() => {
    process.env.API_BASE_URL = originalEnv.API_BASE_URL;
  });

  it("treats loop with invalid metadata (non-object additionalRepos) as having no additional repos", async () => {
    const loop = buildLoop({
      status: "PENDING",
      computeTargetId: null, // ECS path
      repo: { fullName: "org/repo", branch: "main" },
      metadata: { additionalRepos: "not-an-array" } as JsonObject,
    });
    mockLoopsService.findById.mockResolvedValue(loop);

    // Should launch without throwing — invalid metadata treated as empty
    await launchLoop("loop-1", "org-1");

    // GitHub token resolution: once for the primary repo, but NOT for any additional
    // repos (because invalid metadata means no additional repos were parsed)
    expect(mockGetInstallationAccessToken).toHaveBeenCalledTimes(1);
  });

  it("treats loop with missing fullName in additionalRepos entry as having no additional repos", async () => {
    const loop = buildLoop({
      status: "PENDING",
      computeTargetId: null, // ECS path
      repo: { fullName: "org/repo", branch: "main" },
      metadata: {
        additionalRepos: [{ noFullName: "org/extra", branch: "main" }],
      } as JsonObject,
    });
    mockLoopsService.findById.mockResolvedValue(loop);

    await launchLoop("loop-1", "org-1");

    // Only the primary repo token call — extra repo with invalid shape is ignored
    expect(mockGetInstallationAccessToken).toHaveBeenCalledTimes(1);
  });

  it("resolves additional repo tokens for valid metadata", async () => {
    const loop = buildLoop({
      status: "PENDING",
      computeTargetId: null, // ECS path
      repo: { fullName: "org/repo", branch: "main" },
      metadata: {
        additionalRepos: [{ fullName: "org/extra-repo", branch: "main" }],
      },
    });
    mockLoopsService.findById.mockResolvedValue(loop);

    await launchLoop("loop-1", "org-1");

    // Token called for primary repo AND additional repo
    expect(mockGetInstallationAccessToken).toHaveBeenCalledTimes(2);
    expect(
      mockGithubService.findInstallationForRepoFullName
    ).toHaveBeenCalledWith("org-1", "org/extra-repo");
  });
});
