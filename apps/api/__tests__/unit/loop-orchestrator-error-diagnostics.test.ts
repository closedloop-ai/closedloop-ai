/**
 * Tests that diagnostic fields (logTail, tokenUsage, diagnosticsVersion) flow
 * through handleLoopError to addEvent correctly.
 *
 * Covers:
 * - Error event with logTail within 8KB: addEvent called with full logTail
 * - Error event with logTail exceeding 8KB: addEvent called with truncated logTail
 * - Error event without diagnostics: addEvent data has only code, message, timestamp
 * - Error event with tokenUsage: persisted and returned correctly
 * - Error event with diagnosticsVersion: persisted and returned correctly
 * - TIMED_OUT error with logTail: truncated and persisted correctly
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

const { mockIsInvalidStatusTransitionError } = vi.hoisted(() => ({
  mockIsInvalidStatusTransitionError: vi.fn().mockReturnValue(false),
}));

vi.mock("@/app/loops/service", () => ({
  loopsService: {
    findById: vi.fn().mockResolvedValue(null),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    addEvent: vi.fn().mockResolvedValue(undefined),
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
import {
  handleLoopEvent,
  LOG_TAIL_MAX_BYTES_ERROR_EVENT,
  truncateLogTail,
} from "@/lib/loops/loop-orchestrator";
import { buildLoop } from "../fixtures/loop";

type MockFn = ReturnType<typeof vi.fn>;

const mockLoopsService = loopsService as unknown as {
  findById: MockFn;
  updateStatus: MockFn;
  addEvent: MockFn;
};

// ---------------------------------------------------------------------------
// truncateLogTail unit tests
// ---------------------------------------------------------------------------

describe("truncateLogTail", () => {
  it("returns the original string when within 8KB", () => {
    const short = "a".repeat(100);
    expect(truncateLogTail(short)).toBe(short);
  });

  it("truncates to exactly 8KB for ASCII input", () => {
    const long = "x".repeat(LOG_TAIL_MAX_BYTES_ERROR_EVENT + 100);
    const result = truncateLogTail(long);
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(
      LOG_TAIL_MAX_BYTES_ERROR_EVENT
    );
    expect(result.length).toBe(LOG_TAIL_MAX_BYTES_ERROR_EVENT);
  });

  it("does not split a multi-byte UTF-8 character", () => {
    // Build a string just over 8KB ending with a 3-byte UTF-8 character (U+4E2D "中")
    const base = "a".repeat(LOG_TAIL_MAX_BYTES_ERROR_EVENT - 2);
    const twoByteChar = "\u00e9"; // é — 2 bytes in UTF-8
    const threeByteChar = "\u4e2d"; // 中 — 3 bytes in UTF-8
    // position the 3-byte char so it straddles the cutoff
    const input = base + twoByteChar + threeByteChar;
    const result = truncateLogTail(input);
    // Result must be valid UTF-8 (no partial sequences) — TextDecoder would throw on invalid
    expect(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(
        new TextEncoder().encode(result)
      )
    ).not.toThrow();
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(
      LOG_TAIL_MAX_BYTES_ERROR_EVENT
    );
  });
});

// ---------------------------------------------------------------------------
// handleLoopEvent — error diagnostics persistence
// ---------------------------------------------------------------------------

describe("handleLoopEvent error diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDownloadMetadata.mockResolvedValue(null);
  });

  function setupLoop(overrides: Partial<Parameters<typeof buildLoop>[0]> = {}) {
    const loop = buildLoop({
      status: "RUNNING",
      command: "EXECUTE" as "PLAN",
      s3StateKey: null,
      artifactId: null,
      ...overrides,
    });
    mockLoopsService.findById.mockResolvedValue(loop);
    mockLoopsService.updateStatus.mockResolvedValue(undefined);
    mockLoopsService.addEvent.mockResolvedValue(undefined);
  }

  it("persists logTail within 8KB without truncation", async () => {
    setupLoop();
    const logTail = "log line\n".repeat(100); // well under 8KB

    await handleLoopEvent("loop-1", "org-1", {
      type: "error",
      code: "SOME_ERROR",
      message: "Something went wrong",
      timestamp: "2026-01-01T00:00:00.000Z",
      logTail,
    });

    expect(mockLoopsService.addEvent).toHaveBeenCalledWith(
      "loop-1",
      "org-1",
      expect.objectContaining({
        type: "error",
        data: expect.objectContaining({ logTail }),
      }),
      undefined
    );
  });

  it("truncates logTail exceeding 8KB before persisting", async () => {
    setupLoop();
    // Build a string that encodes to more than 8KB
    const oversized = "x".repeat(LOG_TAIL_MAX_BYTES_ERROR_EVENT + 1000);

    await handleLoopEvent("loop-1", "org-1", {
      type: "error",
      code: "SOME_ERROR",
      message: "Something went wrong",
      timestamp: "2026-01-01T00:00:00.000Z",
      logTail: oversized,
    });

    const addEventCall = mockLoopsService.addEvent.mock.calls[0];
    const persistedData = addEventCall[2].data as Record<string, unknown>;
    const persistedLogTail = persistedData.logTail as string;

    expect(
      new TextEncoder().encode(persistedLogTail).length
    ).toBeLessThanOrEqual(LOG_TAIL_MAX_BYTES_ERROR_EVENT);
    expect(persistedLogTail.length).toBeLessThan(oversized.length);
  });

  it("persists error event without diagnostic fields when none provided", async () => {
    setupLoop();

    await handleLoopEvent("loop-1", "org-1", {
      type: "error",
      code: "SOME_ERROR",
      message: "Something went wrong",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const addEventCall = mockLoopsService.addEvent.mock.calls[0];
    const persistedData = addEventCall[2].data as Record<string, unknown>;

    expect(persistedData).toHaveProperty("code", "SOME_ERROR");
    expect(persistedData).toHaveProperty("message", "Something went wrong");
    expect(persistedData).toHaveProperty(
      "timestamp",
      "2026-01-01T00:00:00.000Z"
    );
    expect(persistedData).not.toHaveProperty("logTail");
    expect(persistedData).not.toHaveProperty("tokenUsage");
    expect(persistedData).not.toHaveProperty("diagnosticsVersion");
  });

  it("persists tokenUsage when provided", async () => {
    setupLoop();
    const tokenUsage = { inputTokens: 1500, outputTokens: 800 };

    await handleLoopEvent("loop-1", "org-1", {
      type: "error",
      code: "CONTEXT_LIMIT_EXCEEDED",
      message: "Context limit hit",
      timestamp: "2026-01-01T00:00:00.000Z",
      tokenUsage,
    });

    const addEventCall = mockLoopsService.addEvent.mock.calls[0];
    const persistedData = addEventCall[2].data as Record<string, unknown>;
    expect(persistedData.tokenUsage).toEqual(tokenUsage);
  });

  it("persists diagnosticsVersion when provided", async () => {
    setupLoop();

    await handleLoopEvent("loop-1", "org-1", {
      type: "error",
      code: "SOME_ERROR",
      message: "Something went wrong",
      timestamp: "2026-01-01T00:00:00.000Z",
      diagnosticsVersion: "1.2.3",
    });

    const addEventCall = mockLoopsService.addEvent.mock.calls[0];
    const persistedData = addEventCall[2].data as Record<string, unknown>;
    expect(persistedData.diagnosticsVersion).toBe("1.2.3");
  });

  it("persists all three diagnostic fields together", async () => {
    setupLoop();
    const logTail = "some log output";
    const tokenUsage = { inputTokens: 500, outputTokens: 200 };

    await handleLoopEvent("loop-1", "org-1", {
      type: "error",
      code: "SOME_ERROR",
      message: "Something went wrong",
      timestamp: "2026-01-01T00:00:00.000Z",
      logTail,
      tokenUsage,
      diagnosticsVersion: "2.0.0",
    });

    const addEventCall = mockLoopsService.addEvent.mock.calls[0];
    const persistedData = addEventCall[2].data as Record<string, unknown>;
    expect(persistedData.logTail).toBe(logTail);
    expect(persistedData.tokenUsage).toEqual(tokenUsage);
    expect(persistedData.diagnosticsVersion).toBe("2.0.0");
  });

  it("TIMED_OUT error with logTail: truncated and persisted correctly", async () => {
    setupLoop();
    const oversized = "y".repeat(LOG_TAIL_MAX_BYTES_ERROR_EVENT + 500);

    await handleLoopEvent("loop-1", "org-1", {
      type: "error",
      code: "TIMED_OUT",
      message: "Loop timed out",
      timestamp: "2026-01-01T00:00:00.000Z",
      logTail: oversized,
    });

    const addEventCall = mockLoopsService.addEvent.mock.calls[0];
    const persistedData = addEventCall[2].data as Record<string, unknown>;
    const persistedLogTail = persistedData.logTail as string;

    expect(
      new TextEncoder().encode(persistedLogTail).length
    ).toBeLessThanOrEqual(LOG_TAIL_MAX_BYTES_ERROR_EVENT);
    expect(persistedLogTail.length).toBeLessThan(oversized.length);
  });

  it("TIMED_OUT error without diagnostics: data has only core fields", async () => {
    setupLoop();

    await handleLoopEvent("loop-1", "org-1", {
      type: "error",
      code: "TIMED_OUT",
      message: "Loop timed out",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const addEventCall = mockLoopsService.addEvent.mock.calls[0];
    const persistedData = addEventCall[2].data as Record<string, unknown>;

    expect(persistedData).toHaveProperty("code", "TIMED_OUT");
    expect(persistedData).not.toHaveProperty("logTail");
    expect(persistedData).not.toHaveProperty("tokenUsage");
    expect(persistedData).not.toHaveProperty("diagnosticsVersion");
  });
});
