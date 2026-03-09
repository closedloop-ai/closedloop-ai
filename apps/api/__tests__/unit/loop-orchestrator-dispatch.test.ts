/**
 * Tests for handleLoopCompleted command dispatch behavior.
 *
 * Verifies that handleLoopEvent dispatches to the correct handler's
 * downloadArtifacts + ingest based on the loop's command.
 *
 * NOTE: fetchPrimaryArtifact / buildContextPack command branching is covered
 * in build-context-pack.test.ts — no need to duplicate here.
 */

import { vi } from "vitest";

// --- Mocks (must come before imports) ---
// These exist because loop-orchestrator.ts transitively imports them.

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

vi.mock("@/lib/loops/loop-state", () => ({
  downloadMetadata: vi.fn().mockResolvedValue(null),
  downloadArtifactFile: vi.fn().mockResolvedValue(null),
  downloadPromptSnapshotMarkdownEntries: vi.fn().mockResolvedValue([]),
  getStateKeyPrefix: vi.fn().mockReturnValue("org/loops/loop-1/run-1"),
  generateDownloadUrl: vi.fn().mockResolvedValue("https://mock-url"),
  scrubContextPackSecrets: vi.fn().mockResolvedValue(undefined),
  uploadContextPack: vi.fn().mockResolvedValue("s3://mock-key"),
}));

// Mock the command handlers with spy methods
const mockPlanDownloadAndIngest = vi.fn().mockResolvedValue(undefined);
const mockExecuteDownloadAndIngest = vi.fn().mockResolvedValue(undefined);
const mockDecomposeDownloadAndIngest = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/loops/loop-commands", () => {
  const planHandler = {
    requiresRepo: true,
    requiresParent: false,
    includePrimaryArtifact: false,
    downloadAndIngest: (...args: unknown[]) =>
      mockPlanDownloadAndIngest(...args),
  };
  const requestChangesHandler = {
    requiresRepo: true,
    requiresParent: true,
    includePrimaryArtifact: true,
    downloadAndIngest: (...args: unknown[]) =>
      mockPlanDownloadAndIngest(...args),
  };
  const executeHandler = {
    requiresRepo: true,
    requiresParent: true,
    includePrimaryArtifact: true,
    downloadAndIngest: (...args: unknown[]) =>
      mockExecuteDownloadAndIngest(...args),
  };
  const decomposeHandler = {
    requiresRepo: false,
    requiresParent: false,
    includePrimaryArtifact: false,
    downloadAndIngest: (...args: unknown[]) =>
      mockDecomposeDownloadAndIngest(...args),
  };

  const handlers: Record<string, unknown> = {
    PLAN: planHandler,
    REQUEST_CHANGES: requestChangesHandler,
    EXECUTE: executeHandler,
    DECOMPOSE: decomposeHandler,
  };

  return {
    getCommandHandler: (command: string) => handlers[command],
    COMMAND_HANDLERS: handlers,
  };
});

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
// handleLoopCompleted — command-specific artifact ingestion dispatch
// ---------------------------------------------------------------------------

describe("handleLoopCompleted command dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const completedEvent = {
    type: "completed" as const,
    result: {},
    tokensUsed: { input: 100, output: 50 },
    timestamp: new Date().toISOString(),
  };

  function setupLoopForCompleted(command: string) {
    const loop = buildLoop({
      command: command as "PLAN",
      s3StateKey: "org/loops/loop-1/run-1",
      artifactId: "artifact-1",
    });
    mockLoopsService.findById.mockResolvedValue(loop);
    mockLoopsService.updateStatus.mockResolvedValue(undefined);
    mockLoopsService.addEvent.mockResolvedValue(undefined);
  }

  it("PLAN command: calls plan handler", async () => {
    setupLoopForCompleted("PLAN");

    await handleLoopEvent("loop-1", "org-1", completedEvent);

    expect(mockPlanDownloadAndIngest).toHaveBeenCalledTimes(1);
    expect(mockExecuteDownloadAndIngest).not.toHaveBeenCalled();
  });

  it("REQUEST_CHANGES command: calls plan handler", async () => {
    setupLoopForCompleted("REQUEST_CHANGES");

    await handleLoopEvent("loop-1", "org-1", completedEvent);

    expect(mockPlanDownloadAndIngest).toHaveBeenCalledTimes(1);
    expect(mockExecuteDownloadAndIngest).not.toHaveBeenCalled();
  });

  it("EXECUTE command: calls execute handler", async () => {
    setupLoopForCompleted("EXECUTE");

    await handleLoopEvent("loop-1", "org-1", completedEvent);

    expect(mockExecuteDownloadAndIngest).toHaveBeenCalledTimes(1);
    expect(mockPlanDownloadAndIngest).not.toHaveBeenCalled();
  });

  it("DECOMPOSE command: calls decompose handler", async () => {
    setupLoopForCompleted("DECOMPOSE");

    await handleLoopEvent("loop-1", "org-1", completedEvent);

    expect(mockDecomposeDownloadAndIngest).toHaveBeenCalledTimes(1);
    expect(mockPlanDownloadAndIngest).not.toHaveBeenCalled();
    expect(mockExecuteDownloadAndIngest).not.toHaveBeenCalled();
  });

  it("unknown command: calls neither handler", async () => {
    setupLoopForCompleted("CHAT");

    await handleLoopEvent("loop-1", "org-1", completedEvent);

    expect(mockPlanDownloadAndIngest).not.toHaveBeenCalled();
    expect(mockExecuteDownloadAndIngest).not.toHaveBeenCalled();
    expect(mockDecomposeDownloadAndIngest).not.toHaveBeenCalled();
  });

  it("loop without s3StateKey: skips artifact ingestion entirely", async () => {
    const loop = buildLoop({
      command: "PLAN" as const,
      s3StateKey: null,
      artifactId: "artifact-1",
    });
    mockLoopsService.findById.mockResolvedValue(loop);

    await handleLoopEvent("loop-1", "org-1", completedEvent);

    expect(mockPlanDownloadAndIngest).not.toHaveBeenCalled();
  });

  it("loop without artifactId: skips artifact ingestion entirely", async () => {
    const loop = buildLoop({
      command: "PLAN" as const,
      s3StateKey: "org/loops/loop-1/run-1",
      artifactId: null,
    });
    mockLoopsService.findById.mockResolvedValue(loop);

    await handleLoopEvent("loop-1", "org-1", completedEvent);

    expect(mockPlanDownloadAndIngest).not.toHaveBeenCalled();
  });
});
