/**
 * T-6.2 — In-flight loop isolation from compute preference changes
 *
 * Verifies that launchLoop reads loop.computeTargetId from the DB record
 * (set at creation time), so a subsequent preference change does not affect
 * an already-created loop.
 *
 * T-6.2a (service.ts structural check) lives in loop-service-stores-compute-target.test.ts
 * which tests without mocking the loops service itself.
 *
 * This file covers T-6.2b:
 * - Loop created with computeTargetId: 'target-1' → dispatches to desktop (target-1)
 * - Loop created with computeTargetId: null → dispatches to ECS
 *   (demonstrating the dispatch is driven by the DB record, not a preference)
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
  withDb: Object.assign(
    vi.fn((fn: (db: unknown) => unknown) =>
      fn({
        artifact: { findUnique: vi.fn().mockResolvedValue(null) },
        loop: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      })
    ),
    { tx: vi.fn() }
  ),
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    PULL_REQUEST: "PULL_REQUEST",
    DEPLOYMENT: "DEPLOYMENT",
  },
  EvaluationReportType: { PLAN: "PLAN", CODE: "CODE" },
}));

vi.mock("@/app/loops/service", () => ({
  loopsService: {
    findById: vi.fn(),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    addEvent: vi.fn().mockResolvedValue(undefined),
    persistLaunchInfo: vi.fn(),
    cancel: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock("@/app/loops/loop-errors", () => ({
  isInvalidStatusTransitionError: vi.fn().mockReturnValue(false),
  InvalidStatusTransitionError: class extends Error {},
}));

vi.mock("@/app/documents/document-service", () => ({
  getCommitterInfo: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/app/integrations/github/service", () => ({
  githubService: {
    findInstallationForRepoFullName: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("@/app/settings/api-key-service", () => ({
  apiKeyService: { resolveApiKey: vi.fn().mockResolvedValue("sk-test-key") },
}));

vi.mock("@repo/auth/loop-runner-jwt", () => ({
  issueLoopRunnerToken: vi.fn().mockResolvedValue("mock-token"),
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
  getCommandHandler: vi.fn().mockReturnValue(null),
  COMMAND_HANDLERS: {},
}));

const mockLaunchLoopOnDesktop = vi.fn().mockResolvedValue("cmd-abc");
vi.mock("@/lib/loops/loop-desktop", () => ({
  launchLoopOnDesktop: (...args: unknown[]) => mockLaunchLoopOnDesktop(...args),
  stopDesktopLoop: vi.fn(),
  isDispatchError: () => false,
}));

const mockRunEcsTask = vi.fn().mockResolvedValue("arn:aws:ecs:task/abc");
vi.mock("@/lib/loops/loop-ecs", () => ({
  runEcsTask: (...args: unknown[]) => mockRunEcsTask(...args),
  stopLoopTask: vi.fn(),
}));

vi.mock("@/lib/loops/loop-context-pack", () => ({
  buildContextPack: vi.fn().mockResolvedValue("s3://context-key"),
  buildContextPackInMemory: vi.fn().mockResolvedValue({ command: "PLAN" }),
}));

vi.mock("@/lib/desktop-command-store", () => ({
  desktopCommandStore: { markCommandExpired: vi.fn() },
}));

// --- Imports (after mocks) ---

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loopsService } from "@/app/loops/service";
import { launchLoop } from "@/lib/loops/loop-orchestrator";
import { buildLoop } from "../fixtures/loop";

type MockFn = ReturnType<typeof vi.fn>;

// Typed access to the mocked loopsService methods
const mockLoopsService = loopsService as unknown as {
  findById: MockFn;
  updateStatus: MockFn;
};

const savedEnv = { ...process.env };

// ---------------------------------------------------------------------------
// T-6.2b: launchLoop reads computeTargetId from DB record (preference-isolated)
// ---------------------------------------------------------------------------

describe("launchLoop — dispatches based on loop.computeTargetId stored at creation, not user preference", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLaunchLoopOnDesktop.mockResolvedValue("cmd-abc");
    mockRunEcsTask.mockResolvedValue("arn:aws:ecs:task/abc");
    process.env.API_BASE_URL = "https://api.example.com";
  });

  afterEach(() => {
    process.env.API_BASE_URL = savedEnv.API_BASE_URL;
  });

  it("dispatches to target-1 (desktop) when loop.computeTargetId is 'target-1', ignoring any CLOUD preference change", async () => {
    // Arrange: loop was created with computeTargetId: 'target-1'.
    // Simulated preference change to CLOUD has already happened, but the loop
    // record is immutable — launchLoop must use loop.computeTargetId from DB.
    const pendingLoop = buildLoop({
      id: "loop-1",
      status: "PENDING",
      computeTargetId: "target-1",
      command: "PLAN",
      repo: null, // avoid github token resolution overhead
    });

    mockLoopsService.findById.mockResolvedValue(pendingLoop);
    mockLoopsService.updateStatus.mockResolvedValue(pendingLoop);

    // launchLoop does NOT accept a preference parameter — it reads exclusively
    // from the loop record fetched from DB
    const result = await launchLoop("loop-1", "org-1");

    // Desktop dispatch was used — computeTargetId 'target-1' drove the decision
    expect(mockLaunchLoopOnDesktop).toHaveBeenCalledOnce();
    expect(mockLaunchLoopOnDesktop).toHaveBeenCalledWith(
      expect.objectContaining({ computeTargetId: "target-1" })
    );
    expect(mockRunEcsTask).not.toHaveBeenCalled();
    expect(result).toBe("cmd-abc");
  });

  it("dispatches via ECS when loop.computeTargetId is null, regardless of any LOCAL preference", async () => {
    // Confirms the inverse: a loop with no compute target uses ECS even if
    // the user's LOCAL preference is set — launchLoop reads from the record
    const pendingLoop = buildLoop({
      id: "loop-2",
      status: "PENDING",
      computeTargetId: null,
      command: "PLAN",
      repo: null,
    });

    mockLoopsService.findById.mockResolvedValue(pendingLoop);
    mockLoopsService.updateStatus.mockResolvedValue(pendingLoop);

    const result = await launchLoop("loop-2", "org-1");

    expect(mockRunEcsTask).toHaveBeenCalledOnce();
    expect(mockLaunchLoopOnDesktop).not.toHaveBeenCalled();
    expect(result).toBe("arn:aws:ecs:task/abc");
  });
});
