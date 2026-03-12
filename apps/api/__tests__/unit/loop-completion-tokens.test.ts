/**
 * Tests that token data flows through handleLoopCompleted to updateStatus.
 *
 * Covers:
 * - Event tokensUsed is written to DB via updateStatus
 * - Event tokensUsed takes precedence over S3 metadata with zero values
 * - S3 metadata tokens used as fallback when event has no token data
 * - tokensByModel and estimatedCost are calculated and persisted
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
  getCommitterInfo: vi.fn(),
}));

vi.mock("@/app/integrations/github/service", () => ({
  githubService: { findInstallationForRepoFullName: vi.fn() },
}));

vi.mock("@/app/loops/service", () => ({
  loopsService: {
    findById: vi.fn().mockResolvedValue(null),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    addEvent: vi.fn().mockResolvedValue(undefined),
    persistLaunchInfo: vi.fn(),
  },
  isInvalidStatusTransitionError: vi.fn(),
}));

vi.mock("@/app/settings/api-key-service", () => ({
  apiKeyService: { resolveApiKey: vi.fn() },
}));

vi.mock("@/lib/auth/loop-runner-jwt", () => ({
  issueLoopRunnerToken: vi.fn(),
}));

vi.mock("@/lib/aws-credentials", () => ({
  getAwsCredentials: vi.fn(),
}));

const mockDownloadMetadata = vi.fn().mockResolvedValue(null);

vi.mock("@/lib/loops/loop-state", () => ({
  downloadMetadata: (...args: unknown[]) => mockDownloadMetadata(...args),
  downloadArtifactFile: vi.fn().mockResolvedValue(null),
  downloadPromptSnapshotMarkdownEntries: vi.fn().mockResolvedValue([]),
  getStateKeyPrefix: vi.fn().mockReturnValue("org/loops/loop-1/run-1"),
  generateDownloadUrl: vi.fn().mockResolvedValue("https://mock-url"),
  scrubContextPackSecrets: vi.fn().mockResolvedValue(undefined),
  uploadContextPack: vi.fn().mockResolvedValue("s3://mock-key"),
}));

vi.mock("@/lib/loops/loop-commands", () => ({
  getCommandHandler: () => null,
  COMMAND_HANDLERS: {},
}));

// --- Imports (after mocks) ---

import { beforeEach, describe, expect, it } from "vitest";
import { loopsService } from "@/app/loops/service";
import { handleLoopEvent } from "@/lib/loops/loop-orchestrator";
import { buildLoop } from "../fixtures/loop";

type MockFn = ReturnType<typeof vi.fn>;

const mockLoopsService = loopsService as unknown as {
  findById: MockFn;
  updateStatus: MockFn;
  addEvent: MockFn;
};

// ---------------------------------------------------------------------------
// handleLoopCompleted — token data persistence
// ---------------------------------------------------------------------------

describe("handleLoopCompleted token persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDownloadMetadata.mockResolvedValue(null);
  });

  function setupLoop(overrides: Partial<Parameters<typeof buildLoop>[0]> = {}) {
    const loop = buildLoop({
      command: "CHAT" as "PLAN",
      s3StateKey: null,
      artifactId: null,
      ...overrides,
    });
    mockLoopsService.findById.mockResolvedValue(loop);
    mockLoopsService.updateStatus.mockResolvedValue(undefined);
    mockLoopsService.addEvent.mockResolvedValue(undefined);
  }

  it("writes event tokensUsed to updateStatus when no metadata exists", async () => {
    setupLoop();

    await handleLoopEvent("loop-1", "org-1", {
      type: "completed",
      result: {},
      tokensUsed: { input: 50_000, output: 30_000 },
      timestamp: new Date().toISOString(),
    });

    expect(mockLoopsService.updateStatus).toHaveBeenCalledWith(
      "loop-1",
      "org-1",
      "COMPLETED",
      expect.objectContaining({
        tokensInput: 50_000,
        tokensOutput: 30_000,
      })
    );
  });

  it("uses event tokensUsed over S3 metadata with zero values", async () => {
    setupLoop({ s3StateKey: "org/loops/loop-1/run-1" });
    mockDownloadMetadata.mockResolvedValue({
      loopId: "loop-1",
      command: "CHAT",
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      tokensInput: 0,
      tokensOutput: 0,
      filesRead: [],
      filesWritten: [],
      toolCalls: 0,
    });

    await handleLoopEvent("loop-1", "org-1", {
      type: "completed",
      result: {},
      tokensUsed: { input: 75_000, output: 45_000 },
      timestamp: new Date().toISOString(),
    });

    expect(mockLoopsService.updateStatus).toHaveBeenCalledWith(
      "loop-1",
      "org-1",
      "COMPLETED",
      expect.objectContaining({
        tokensInput: 75_000,
        tokensOutput: 45_000,
      })
    );
  });

  it("falls back to S3 metadata tokens when event has zero values", async () => {
    setupLoop({ s3StateKey: "org/loops/loop-1/run-1" });
    mockDownloadMetadata.mockResolvedValue({
      loopId: "loop-1",
      command: "CHAT",
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      tokensInput: 60_000,
      tokensOutput: 40_000,
      filesRead: [],
      filesWritten: [],
      toolCalls: 5,
    });

    await handleLoopEvent("loop-1", "org-1", {
      type: "completed",
      result: {},
      tokensUsed: { input: 0, output: 0 },
      timestamp: new Date().toISOString(),
    });

    expect(mockLoopsService.updateStatus).toHaveBeenCalledWith(
      "loop-1",
      "org-1",
      "COMPLETED",
      expect.objectContaining({
        tokensInput: 60_000,
        tokensOutput: 40_000,
      })
    );
  });

  it("calculates estimatedCost from token counts", async () => {
    setupLoop();

    await handleLoopEvent("loop-1", "org-1", {
      type: "completed",
      result: {},
      tokensUsed: { input: 1_000_000, output: 500_000 },
      timestamp: new Date().toISOString(),
    });

    const updateCall = mockLoopsService.updateStatus.mock.calls[0];
    const data = updateCall[3];
    expect(data.estimatedCost).toBeGreaterThan(0);
  });

  it("persists tokensByModel from event", async () => {
    setupLoop();
    const tokensByModel = {
      "claude-sonnet-4-5-20250514": { input: 50_000, output: 30_000 },
    };

    await handleLoopEvent("loop-1", "org-1", {
      type: "completed",
      result: {},
      tokensUsed: { input: 50_000, output: 30_000 },
      tokensByModel,
      timestamp: new Date().toISOString(),
    });

    expect(mockLoopsService.updateStatus).toHaveBeenCalledWith(
      "loop-1",
      "org-1",
      "COMPLETED",
      expect.objectContaining({
        tokensByModel,
      })
    );
  });

  it("persists tokensByModel from metadata when event lacks it", async () => {
    setupLoop({ s3StateKey: "org/loops/loop-1/run-1" });
    const metadataTokensByModel = {
      "claude-opus-4-20250514": { input: 80_000, output: 50_000 },
    };
    mockDownloadMetadata.mockResolvedValue({
      loopId: "loop-1",
      command: "CHAT",
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      tokensInput: 80_000,
      tokensOutput: 50_000,
      tokensByModel: metadataTokensByModel,
      filesRead: [],
      filesWritten: [],
      toolCalls: 3,
    });

    await handleLoopEvent("loop-1", "org-1", {
      type: "completed",
      result: {},
      tokensUsed: { input: 80_000, output: 50_000 },
      timestamp: new Date().toISOString(),
    });

    expect(mockLoopsService.updateStatus).toHaveBeenCalledWith(
      "loop-1",
      "org-1",
      "COMPLETED",
      expect.objectContaining({
        tokensByModel: metadataTokensByModel,
      })
    );
  });

  it("records completedAt timestamp", async () => {
    setupLoop();

    await handleLoopEvent("loop-1", "org-1", {
      type: "completed",
      result: {},
      tokensUsed: { input: 100, output: 50 },
      timestamp: new Date().toISOString(),
    });

    const updateCall = mockLoopsService.updateStatus.mock.calls[0];
    const data = updateCall[3];
    expect(data.completedAt).toBeInstanceOf(Date);
  });
});
