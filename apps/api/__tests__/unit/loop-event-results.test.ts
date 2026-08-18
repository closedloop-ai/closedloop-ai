/**
 * Tests verifying results[] persistence and SSE propagation for completed events.
 *
 * Covers:
 * - Round-trip fidelity: results[] stored via addEvent and returned via getEventsPaginated
 * - SSE propagation: handleLoopCompleted returns enriched event with results[]
 * - Backward compatibility: completed event without results[] is valid and degrades gracefully
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (must come before imports) ---

vi.mock("@aws-sdk/client-ecs", () => ({
  ECSClient: vi.fn(),
  RunTaskCommand: vi.fn(),
  StopTaskCommand: vi.fn(),
}));

vi.mock("@repo/github", () => ({
  getInstallationAccessToken: vi.fn(),
}));

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import("../fixtures/mock-modules");
  return createLogMockModule();
});

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import("../fixtures/mock-modules");
  return createDatabaseMockModule();
});

vi.mock("@/app/documents/document-service", () => ({
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
  return createLoopRunnerJwtMockModule(importOriginal);
});

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

import {
  LoopEventCompletedSchema,
  LoopReconciliationStatus,
  LoopSessionOrigin,
} from "@closedloop-ai/loops-api/events";
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
});

// ---------------------------------------------------------------------------
// usageReconciliation round-trip: the authoritative accounting must survive the
// rebuild of loop_events.data, or none of PRD-538's provenance reaches a
// historical read (ISS-5349).
// ---------------------------------------------------------------------------

/** The full harness-stdout block, as the desktop finalizer emits it. */
const RECONCILIATION = {
  sessionOrigin: LoopSessionOrigin.HarnessStdout,
  authoritativeCostUsd: 1.2345,
  derivedCostUsd: 1.23,
  reconciliationStatus: LoopReconciliationStatus.Matched,
  reconciliationDeltaUsd: -0.0045,
  harnessNumTurns: 7,
  harnessDurationMs: 42_000,
  harnessDurationApiMs: 30_000,
  harnessStopReason: "end_turn",
  harnessUsage: {
    input: 100,
    output: 50,
    cacheRead: 900,
    cacheWrite: 200,
    webSearchRequests: 3,
  },
  harnessModelUsage: {
    "claude-opus-4-5": {
      input: 100,
      output: 50,
      cacheRead: 900,
      cacheCreation: 200,
      costUsd: 1.2345,
    },
  },
  harnessPermissionDenials: [{ toolName: "Bash", toolUseId: "toolu_01" }],
};

const BASE_COMPLETED_EVENT = {
  type: "completed" as const,
  result: {},
  tokensUsed: { input: 1000, output: 500 },
  timestamp: "2026-01-01T00:00:00.000Z",
};

/** The `data` payload the orchestrator handed to `addEvent`. */
function persistedEventData(): Record<string, unknown> {
  const addEventCall = mockLoopsService.addEvent.mock.calls[0];
  return addEventCall[2].data;
}

describe("usageReconciliation round-trip through the API persistence path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDownloadMetadata.mockResolvedValue(null);
  });

  it("persists the authoritative accounting block into loop_events.data", async () => {
    setupLoop();

    await handleLoopEvent("loop-1", "org-1", {
      ...BASE_COMPLETED_EVENT,
      usageReconciliation: RECONCILIATION,
    });

    // Without this the block reaches the POST and is then discarded when the
    // orchestrator rebuilds `data`, so no historical read ever sees it.
    expect(persistedEventData().usageReconciliation).toEqual(RECONCILIATION);
  });

  it("omits the key entirely when the event carries no accounting", async () => {
    setupLoop();

    await handleLoopEvent("loop-1", "org-1", BASE_COMPLETED_EVENT);

    // Absent must stay absent, never become a stored null that reads as
    // "we looked and there was nothing".
    expect(persistedEventData()).not.toHaveProperty("usageReconciliation");
  });

  it("persists the SCHEMA-PARSED value, stripping keys the contract does not declare", async () => {
    setupLoop();

    // Bound to a variable rather than written inline: the extra key is exactly
    // what a NEWER desktop build puts on the wire, which our in-process types
    // forbid but the runtime boundary must still survive.
    const fromNewerDesktopBuild = {
      ...RECONCILIATION,
      undeclaredField: { arbitrary: "payload" },
    };

    await handleLoopEvent("loop-1", "org-1", {
      ...BASE_COMPLETED_EVENT,
      usageReconciliation: fromNewerDesktopBuild,
    });

    // The route's validator throws away its safeParse output, so this is the
    // only gate that turns the raw wire object into the schema's output.
    expect(persistedEventData().usageReconciliation).toEqual(RECONCILIATION);
  });

  it("drops a corrupt aggregate while persisting the accounting that did validate", async () => {
    setupLoop();

    await handleLoopEvent("loop-1", "org-1", {
      ...BASE_COMPLETED_EVENT,
      usageReconciliation: {
        ...RECONCILIATION,
        harnessUsage: { ...RECONCILIATION.harnessUsage, input: -1 },
      },
    });

    const persisted = persistedEventData().usageReconciliation as Record<
      string,
      unknown
    >;
    expect(persisted).not.toHaveProperty("harnessUsage");
    expect(persisted.authoritativeCostUsd).toBe(1.2345);
    expect(persisted.sessionOrigin).toBe(LoopSessionOrigin.HarnessStdout);
  });

  it("persists a pre-PRD-538 desktop's usage block, reading its absent webSearchRequests as zero", async () => {
    setupLoop();
    // The in-process type declares `webSearchRequests` required, but this
    // payload arrives over HTTP from an already-installed peer build that
    // predates the field — a runtime shape the type cannot describe and the
    // cross-repo rule requires be exercised. Delete the key rather than cast.
    const preIss5368Usage = { ...RECONCILIATION.harnessUsage };
    Reflect.deleteProperty(preIss5368Usage, "webSearchRequests");

    await handleLoopEvent("loop-1", "org-1", {
      ...BASE_COMPLETED_EVENT,
      usageReconciliation: {
        ...RECONCILIATION,
        harnessUsage: preIss5368Usage,
      },
    });

    // ISS-5368: an already-installed desktop build that predates the field must
    // not lose four sound token counters to one additive omission. Absent is
    // KNOWN-ZERO for this per-request line item, so the block persists whole.
    expect(persistedEventData().usageReconciliation).toEqual({
      ...RECONCILIATION,
      harnessUsage: { ...preIss5368Usage, webSearchRequests: 0 },
    });
  });

  it("omits the whole block when a load-bearing figure is corrupt, without losing the completion", async () => {
    setupLoop();

    await handleLoopEvent("loop-1", "org-1", {
      ...BASE_COMPLETED_EVENT,
      usageReconciliation: { ...RECONCILIATION, authoritativeCostUsd: -1 },
    });

    const data = persistedEventData();
    // Valid-or-absent: never a half-trustworthy row...
    expect(data).not.toHaveProperty("usageReconciliation");
    // ...and never at the cost of the completion event itself.
    expect(data.tokensUsed).toEqual({ input: 1000, output: 500 });
    expect(mockLoopsService.updateStatus).toHaveBeenCalled();
  });
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
