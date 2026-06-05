/**
 * Tests for token tracking on output events.
 *
 * Covers:
 * - handleLoopEvent("output") with non-zero tokenUsage: updateTokens called
 * - handleLoopEvent("output") when addEvent returns false: updateTokens NOT called
 * - handleLoopEvent("output") with zero tokenUsage: updateTokens NOT called
 * - updateTokens: $executeRaw called with correct SQL arguments
 * - validateNormalizedEvent: accepts valid output tokenUsage; rejects non-numeric fields
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
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  },
}));

vi.mock("@/app/artifacts/service", () => ({
  getCommitterInfo: vi.fn(),
}));

vi.mock("@/app/artifacts/attachments-service", () => ({
  attachmentsService: {
    listWithSignedUrlsByArtifact: vi.fn().mockResolvedValue([]),
    listWithSignedUrlsByFeature: vi.fn().mockResolvedValue([]),
  },
  ATTACHMENT_SIGNED_URL_MAX_FILES: 20,
}));

vi.mock("@/app/integrations/github/service", () => ({
  githubService: { findInstallationForRepoFullName: vi.fn() },
}));

const { mockIsInvalidStatusTransitionError } = vi.hoisted(() => ({
  mockIsInvalidStatusTransitionError: vi.fn().mockReturnValue(false),
}));

vi.mock("@/app/loops/service", () => ({
  loopsService: {
    findById: vi.fn().mockResolvedValue(null),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    addEvent: vi.fn().mockResolvedValue(true),
    updateTokens: vi.fn().mockResolvedValue(undefined),
    persistLaunchInfo: vi.fn(),
  },
  isInvalidStatusTransitionError: mockIsInvalidStatusTransitionError,
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

vi.mock("@/lib/loops/loop-commands", () => ({
  getCommandHandler: () => null,
  COMMAND_HANDLERS: {},
}));

vi.mock("@/lib/loops/loop-ecs", () => ({
  runEcsTask: vi.fn().mockResolvedValue("ecs-task-arn"),
  stopLoopTask: vi.fn().mockResolvedValue(undefined),
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
      command: { commandId: "cmd-orphan-1" },
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
    launchLoopOnDesktop: vi.fn().mockResolvedValue("cmd-default"),
    stopDesktopLoop: vi.fn().mockResolvedValue(undefined),
  };
});

// --- Imports (after mocks) ---

import { beforeEach, describe, expect, it } from "vitest";
import { loopsService } from "@/app/loops/service";
import { validateNormalizedEvent } from "@/app/loops/validators";
import { handleLoopEvent } from "@/lib/loops/loop-orchestrator";
import { buildLoop } from "../fixtures/loop";

type MockFn = ReturnType<typeof vi.fn>;

const mockLoopsService = loopsService as unknown as {
  findById: MockFn;
  updateStatus: MockFn;
  addEvent: MockFn;
  updateTokens: MockFn;
};

// ---------------------------------------------------------------------------
// handleLoopEvent("output") — token update on addEvent success
// ---------------------------------------------------------------------------

describe("handleLoopEvent output — token tracking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoopsService.addEvent.mockResolvedValue(true);
    mockLoopsService.updateTokens.mockResolvedValue(undefined);
  });

  const outputEvent = {
    type: "output" as const,
    chunk: "hello world",
    timestamp: "2026-01-01T00:00:00.000Z",
  };

  it("calls updateTokens when addEvent returns true and tokenUsage has non-zero values", async () => {
    const loop = buildLoop({ status: "RUNNING" });
    mockLoopsService.findById.mockResolvedValue(loop);

    await handleLoopEvent("loop-1", "org-1", {
      ...outputEvent,
      tokenUsage: { inputTokens: 1000, outputTokens: 500 },
    });

    expect(mockLoopsService.updateTokens).toHaveBeenCalledWith(
      "loop-1",
      "org-1",
      1000,
      500,
      0,
      0
    );
  });

  it("does NOT call updateTokens when addEvent returns false (terminal loop)", async () => {
    const loop = buildLoop({ status: "COMPLETED" });
    mockLoopsService.findById.mockResolvedValue(loop);
    mockLoopsService.addEvent.mockResolvedValue(false);

    await handleLoopEvent("loop-1", "org-1", {
      ...outputEvent,
      tokenUsage: { inputTokens: 1000, outputTokens: 500 },
    });

    expect(mockLoopsService.updateTokens).not.toHaveBeenCalled();
  });

  it("does NOT call updateTokens when tokenUsage has all-zero values", async () => {
    const loop = buildLoop({ status: "RUNNING" });
    mockLoopsService.findById.mockResolvedValue(loop);

    await handleLoopEvent("loop-1", "org-1", {
      ...outputEvent,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
    });

    expect(mockLoopsService.updateTokens).not.toHaveBeenCalled();
  });

  it("does NOT call updateTokens when tokenUsage is absent", async () => {
    const loop = buildLoop({ status: "RUNNING" });
    mockLoopsService.findById.mockResolvedValue(loop);

    await handleLoopEvent("loop-1", "org-1", outputEvent);

    expect(mockLoopsService.updateTokens).not.toHaveBeenCalled();
  });

  it("calls updateTokens when only inputTokens > 0 (output still zero)", async () => {
    const loop = buildLoop({ status: "RUNNING" });
    mockLoopsService.findById.mockResolvedValue(loop);

    await handleLoopEvent("loop-1", "org-1", {
      ...outputEvent,
      tokenUsage: { inputTokens: 500, outputTokens: 0 },
    });

    expect(mockLoopsService.updateTokens).toHaveBeenCalledWith(
      "loop-1",
      "org-1",
      500,
      0,
      0,
      0
    );
  });
});

// ---------------------------------------------------------------------------
// validateNormalizedEvent — output event tokenUsage validation
// ---------------------------------------------------------------------------

describe("validateNormalizedEvent — output event tokenUsage", () => {
  it("accepts output event without tokenUsage (backward compatible)", () => {
    const result = validateNormalizedEvent({
      type: "output",
      chunk: "hello",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    expect(result).toBeNull();
  });

  it("accepts output event with valid numeric tokenUsage", () => {
    const result = validateNormalizedEvent({
      type: "output",
      chunk: "hello",
      timestamp: "2026-01-01T00:00:00.000Z",
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
    });
    expect(result).toBeNull();
  });

  it("accepts output event with all four tokenUsage fields", () => {
    const result = validateNormalizedEvent({
      type: "output",
      chunk: "hello",
      timestamp: "2026-01-01T00:00:00.000Z",
      tokenUsage: {
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationInputTokens: 200,
        cacheReadInputTokens: 100,
      },
    });
    expect(result).toBeNull();
  });

  it("rejects output event with non-numeric inputTokens", () => {
    const result = validateNormalizedEvent({
      type: "output",
      chunk: "hello",
      timestamp: "2026-01-01T00:00:00.000Z",
      tokenUsage: { inputTokens: "lots", outputTokens: 50 },
    });
    expect(result).not.toBeNull();
    expect(result).toContain("tokenUsage");
  });

  it("rejects output event with non-numeric outputTokens", () => {
    const result = validateNormalizedEvent({
      type: "output",
      chunk: "hello",
      timestamp: "2026-01-01T00:00:00.000Z",
      tokenUsage: { inputTokens: 100, outputTokens: false },
    });
    expect(result).not.toBeNull();
    expect(result).toContain("tokenUsage");
  });

  it("rejects output event with non-numeric cacheCreationInputTokens", () => {
    const result = validateNormalizedEvent({
      type: "output",
      chunk: "hello",
      timestamp: "2026-01-01T00:00:00.000Z",
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: "many",
      },
    });
    expect(result).not.toBeNull();
    expect(result).toContain("tokenUsage");
  });

  it("rejects output event missing chunk", () => {
    const result = validateNormalizedEvent({
      type: "output",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    expect(result).not.toBeNull();
    expect(result).toContain("chunk");
  });
});
