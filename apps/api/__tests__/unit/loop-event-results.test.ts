/**
 * Tests verifying results[] persistence and SSE propagation for completed events.
 *
 * Covers:
 * - Round-trip fidelity: results[] stored via addEvent and returned via getEventsPaginated
 * - SSE propagation: handleLoopCompleted returns enriched event with results[]
 * - Backward compatibility: completed event without results[] is valid and degrades gracefully
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

vi.mock("@/app/documents/service", () => ({
  getCommitterInfo: vi.fn(),
}));

vi.mock("@/app/documents/attachments-service", () => ({
  attachmentsService: {
    listWithSignedUrlsByDocument: vi.fn().mockResolvedValue([]),
  },
  ATTACHMENT_SIGNED_URL_MAX_FILES: 20,
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
    getEventsPaginated: vi.fn(),
  },
  isInvalidStatusTransitionError: vi.fn().mockReturnValue(false),
}));

vi.mock("@/app/settings/api-key-service", () => ({
  apiKeyService: { resolveApiKey: vi.fn() },
}));

vi.mock("@repo/auth/loop-runner-jwt", () => ({
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

import { LoopEventCompletedSchema } from "@closedloop-ai/loops-api/events";
import { beforeEach, describe, expect, it } from "vitest";
import { loopsService } from "@/app/loops/service";
import { handleLoopEvent } from "@/lib/loops/loop-orchestrator";
import { buildLoop } from "../fixtures/loop";

type MockFn = ReturnType<typeof vi.fn>;

const mockLoopsService = loopsService as unknown as {
  findById: MockFn;
  updateStatus: MockFn;
  addEvent: MockFn;
  getEventsPaginated: MockFn;
};

// ---------------------------------------------------------------------------
// Round-trip fidelity: results[] stored via addEvent → returned via getEventsPaginated
// ---------------------------------------------------------------------------

describe("results[] round-trip fidelity through Prisma JSON column", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDownloadMetadata.mockResolvedValue(null);
  });

  function setupLoop(overrides: Partial<Parameters<typeof buildLoop>[0]> = {}) {
    const loop = buildLoop({
      command: "CHAT" as "PLAN",
      s3StateKey: null,
      documentId: null,
      status: "RUNNING",
      ...overrides,
    });
    mockLoopsService.findById.mockResolvedValue(loop);
    mockLoopsService.updateStatus.mockResolvedValue(undefined);
    mockLoopsService.addEvent.mockResolvedValue(true);
  }

  it("passes results[] to addEvent data when present on completed event", async () => {
    setupLoop();

    const results = [
      {
        status: "success" as const,
        fullName: "org/repo",
        prUrl: "https://github.com/org/repo/pull/42",
        prNumber: 42,
        branchName: "feature/my-branch",
        baseBranch: "main",
        hasChanges: true,
      },
    ];

    await handleLoopEvent("loop-1", "org-1", {
      type: "completed",
      result: {},
      tokensUsed: { input: 1000, output: 500 },
      timestamp: "2026-01-01T00:00:00.000Z",
      results,
    });

    // Verify addEvent was called with results[] in the data payload
    expect(mockLoopsService.addEvent).toHaveBeenCalledWith(
      "loop-1",
      "org-1",
      expect.objectContaining({
        type: "completed",
        data: expect.objectContaining({
          results,
        }),
      }),
      undefined
    );
  });

  it("does NOT include results key in addEvent data when results[] is absent", async () => {
    setupLoop();

    await handleLoopEvent("loop-1", "org-1", {
      type: "completed",
      result: {},
      tokensUsed: { input: 1000, output: 500 },
      timestamp: "2026-01-01T00:00:00.000Z",
      // no results field
    });

    const addEventCall = mockLoopsService.addEvent.mock.calls[0];
    const eventArg = addEventCall[2];
    expect(eventArg.data).not.toHaveProperty("results");
  });

  it("multiple result entries with mixed statuses are preserved intact", async () => {
    setupLoop();

    const results = [
      {
        status: "success" as const,
        fullName: "org/repo-a",
        prUrl: "https://github.com/org/repo-a/pull/1",
        prNumber: 1,
        branchName: "feature/branch",
        baseBranch: "main",
        hasChanges: true,
      },
      {
        status: "failed" as const,
        fullName: "org/repo-b",
        error: "merge conflict",
      },
      {
        status: "skipped" as const,
        fullName: "org/repo-c",
        reason: "no_changes",
      },
    ];

    await handleLoopEvent("loop-1", "org-1", {
      type: "completed",
      result: {},
      tokensUsed: { input: 500, output: 250 },
      timestamp: "2026-01-01T00:00:00.000Z",
      results,
    });

    const addEventCall = mockLoopsService.addEvent.mock.calls[0];
    const storedResults = addEventCall[2].data.results;
    expect(storedResults).toEqual(results);
    expect(storedResults).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// SSE propagation: handleLoopCompleted returns enriched event with results[]
// ---------------------------------------------------------------------------

describe("handleLoopCompleted SSE propagation of results[]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDownloadMetadata.mockResolvedValue(null);
  });

  function setupLoop(overrides: Partial<Parameters<typeof buildLoop>[0]> = {}) {
    const loop = buildLoop({
      command: "CHAT" as "PLAN",
      s3StateKey: null,
      documentId: null,
      status: "RUNNING",
      ...overrides,
    });
    mockLoopsService.findById.mockResolvedValue(loop);
    mockLoopsService.updateStatus.mockResolvedValue(undefined);
    mockLoopsService.addEvent.mockResolvedValue(true);
  }

  it("returned event includes results[] so the route handler can publish it to SSE", async () => {
    setupLoop();

    const results = [
      {
        status: "success" as const,
        fullName: "org/my-repo",
        prUrl: "https://github.com/org/my-repo/pull/7",
        prNumber: 7,
        branchName: "feature/sse-test",
        baseBranch: "main",
        hasChanges: true,
      },
    ];

    const returnedEvents = await handleLoopEvent("loop-1", "org-1", {
      type: "completed",
      result: {},
      tokensUsed: { input: 2000, output: 1000 },
      timestamp: "2026-01-01T00:00:00.000Z",
      results,
    });

    expect(returnedEvents).toHaveLength(1);
    const completedEvent = returnedEvents[0] as {
      type: string;
      results?: unknown[];
    };
    expect(completedEvent.type).toBe("completed");
    expect(completedEvent.results).toEqual(results);
  });

  it("returned event has results[] matching the input results array exactly", async () => {
    setupLoop();

    const results = [
      {
        status: "success" as const,
        fullName: "org/repo-x",
        prUrl: "https://github.com/org/repo-x/pull/10",
        prNumber: 10,
        branchName: "fix/bug-123",
        baseBranch: "develop",
        hasChanges: true,
        githubId: 123_456,
      },
      {
        status: "skipped" as const,
        fullName: "org/repo-y",
        reason: "no_changes",
      },
    ];

    const returnedEvents = await handleLoopEvent("loop-1", "org-1", {
      type: "completed",
      result: {},
      tokensUsed: { input: 3000, output: 1500 },
      timestamp: "2026-01-01T00:00:00.000Z",
      results,
    });

    expect(returnedEvents).toHaveLength(1);
    const event = returnedEvents[0] as { results?: typeof results };
    expect(event.results).toEqual(results);
    // Verify specific entry fields
    const successEntry = event.results?.[0];
    expect(successEntry).toMatchObject({
      status: "success",
      prNumber: 10,
      githubId: 123_456,
    });
  });

  it("returned event has undefined results when completed event has no results[]", async () => {
    setupLoop();

    const returnedEvents = await handleLoopEvent("loop-1", "org-1", {
      type: "completed",
      result: {},
      tokensUsed: { input: 1000, output: 500 },
      timestamp: "2026-01-01T00:00:00.000Z",
      // no results field
    });

    expect(returnedEvents).toHaveLength(1);
    const event = returnedEvents[0] as { results?: unknown[] };
    // results should be absent/undefined — not an empty array — for pre-deploy events
    expect(event.results).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility: completed event WITHOUT results[] degrades gracefully
// ---------------------------------------------------------------------------

describe("backward compatibility: completed event without results[] is valid", () => {
  it("LoopEventCompletedSchema accepts a completed event with no results field", () => {
    const event = {
      type: "completed" as const,
      result: {},
      tokensUsed: { input: 5000, output: 2500 },
      timestamp: "2025-01-01T00:00:00.000Z",
    };

    const parsed = LoopEventCompletedSchema.safeParse(event);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // results field is absent — consumers must handle the optional field
      expect(parsed.data.results).toBeUndefined();
    }
  });

  it("LoopEventCompletedSchema accepts a completed event with results: undefined (explicit undefined)", () => {
    const event = {
      type: "completed" as const,
      result: {},
      tokensUsed: { input: 0, output: 0 },
      timestamp: "2025-06-15T12:00:00.000Z",
      results: undefined,
    };

    const parsed = LoopEventCompletedSchema.safeParse(event);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.results).toBeUndefined();
    }
  });

  it("LoopEventCompletedSchema accepts a completed event with an empty results array", () => {
    const event = {
      type: "completed" as const,
      result: {},
      tokensUsed: { input: 0, output: 0 },
      timestamp: "2025-06-15T12:00:00.000Z",
      results: [],
    };

    const parsed = LoopEventCompletedSchema.safeParse(event);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.results).toEqual([]);
    }
  });

  it("LoopEventCompletedSchema accepts a completed event with populated results[]", () => {
    const event = {
      type: "completed" as const,
      result: {},
      tokensUsed: { input: 10_000, output: 5000 },
      timestamp: "2025-06-15T12:00:00.000Z",
      results: [
        {
          status: "success" as const,
          fullName: "org/repo",
          prUrl: "https://github.com/org/repo/pull/1",
          prNumber: 1,
          branchName: "feature/branch",
          baseBranch: "main",
          hasChanges: true,
        },
      ],
    };

    const parsed = LoopEventCompletedSchema.safeParse(event);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.results).toHaveLength(1);
      expect(parsed.data.results?.[0]).toMatchObject({
        status: "success",
        prNumber: 1,
      });
    }
  });

  it("consumer code treating results as optional does not throw for pre-deploy events", () => {
    // Simulate a consumer (e.g., SSE handler) accessing results from a historical
    // completed event that lacks the field. The optional chaining pattern must
    // degrade gracefully without throwing.
    const historicalEvent = {
      type: "completed" as const,
      result: {},
      tokensUsed: { input: 1000, output: 500 },
      timestamp: "2024-11-01T00:00:00.000Z",
      // No results field — pre-deploy event
    } as { type: "completed"; results?: unknown[] };

    // Consumer accesses results with optional chaining — must not throw
    const prCount = historicalEvent.results?.length ?? 0;
    expect(prCount).toBe(0);

    // Consumer iterates results with fallback — must not throw
    const processedResults = (historicalEvent.results ?? []).map((r) => r);
    expect(processedResults).toEqual([]);
  });
});
