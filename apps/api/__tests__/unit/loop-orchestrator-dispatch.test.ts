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

vi.mock("@/app/documents/service", () => ({
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
    cancel: vi.fn().mockResolvedValue(undefined),
  },
  isInvalidStatusTransitionError: vi.fn(),
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

import {
  LoopErrorCode,
  LoopStatus,
  type LoopWithUser,
} from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { afterEach, beforeEach, describe, expect, it, type Mock } from "vitest";
import { loopsService } from "@/app/loops/service";
import { apiKeyService } from "@/app/settings/api-key-service";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import {
  DispatchError,
  launchLoopOnDesktop,
  stopDesktopLoop,
} from "@/lib/loops/loop-desktop";
import { runEcsTask } from "@/lib/loops/loop-ecs";
import { handleLoopEvent, launchLoop } from "@/lib/loops/loop-orchestrator";
import { buildLoop } from "../fixtures/loop";

type MockFn = ReturnType<typeof vi.fn>;

const mockWithDb = withDb as unknown as Mock;

const mockLoopsService = loopsService as unknown as {
  findById: MockFn;
  updateStatus: MockFn;
  addEvent: MockFn;
  cancel: MockFn;
};

const mockDesktopCommandStore = desktopCommandStore as unknown as {
  markCommandExpired: MockFn;
};

const mockLaunchLoopOnDesktop = launchLoopOnDesktop as unknown as MockFn;
const mockStopDesktopLoop = stopDesktopLoop as unknown as MockFn;

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
      documentId: "artifact-1",
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

  it("MANUAL command: skips S3 ingestion entirely", async () => {
    setupLoopForCompleted("MANUAL");

    await handleLoopEvent("loop-1", "org-1", completedEvent);

    expect(mockPlanDownloadAndIngest).not.toHaveBeenCalled();
    expect(mockExecuteDownloadAndIngest).not.toHaveBeenCalled();
    expect(mockDecomposeDownloadAndIngest).not.toHaveBeenCalled();
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
      documentId: "artifact-1",
    });
    mockLoopsService.findById.mockResolvedValue(loop);

    await handleLoopEvent("loop-1", "org-1", completedEvent);

    expect(mockPlanDownloadAndIngest).not.toHaveBeenCalled();
  });

  it("loop without documentId: skips artifact ingestion entirely", async () => {
    const loop = buildLoop({
      command: "PLAN" as const,
      s3StateKey: "org/loops/loop-1/run-1",
      documentId: null,
    });
    mockLoopsService.findById.mockResolvedValue(loop);

    await handleLoopEvent("loop-1", "org-1", completedEvent);

    expect(mockPlanDownloadAndIngest).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// launchLoop — orphaned desktop command cleanup on relay failure
// ---------------------------------------------------------------------------

describe("launchLoop orphaned command cleanup on relay failure", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // launchLoopDesktop checks for API_BASE_URL before calling launchLoopOnDesktop
    process.env.API_BASE_URL = "https://api.test";
  });

  afterEach(() => {
    process.env.API_BASE_URL = originalEnv.API_BASE_URL;
  });

  it("expires the orphaned command and cancels the loop when launchLoopOnDesktop throws a DispatchError", async () => {
    const loop = buildLoop({
      status: "PENDING",
      computeTargetId: "target-1",
    });
    mockLoopsService.findById.mockResolvedValue(loop);

    // Configure launchLoopOnDesktop to throw a DispatchError carrying the orphaned commandId.
    // The mock's isDispatchError uses a structural check so this instance is recognized.
    const dispatchError = new DispatchError(
      "relay unreachable",
      "cmd-orphan-1"
    );
    mockLaunchLoopOnDesktop.mockRejectedValue(dispatchError);
    mockStopDesktopLoop.mockResolvedValue(undefined);
    mockDesktopCommandStore.markCommandExpired.mockResolvedValue(undefined);
    mockLoopsService.cancel.mockResolvedValue(undefined);

    await expect(launchLoop("loop-1", "org-1")).rejects.toThrow(
      "relay unreachable"
    );

    expect(mockDesktopCommandStore.markCommandExpired).toHaveBeenCalledWith(
      "cmd-orphan-1",
      expect.any(String),
      { computeTargetId: "target-1" }
    );

    expect(mockLoopsService.cancel).toHaveBeenCalledWith("loop-1", "org-1");
  });
});

// ---------------------------------------------------------------------------
// PLAN_STATE_UNAVAILABLE pre-dispatch guard
// ---------------------------------------------------------------------------

describe("PLAN_STATE_UNAVAILABLE pre-dispatch guard", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.API_BASE_URL = "https://api.test";
  });

  afterEach(() => {
    process.env.API_BASE_URL = originalEnv.API_BASE_URL;
  });

  const mockRunEcsTask = runEcsTask as unknown as MockFn;
  const mockResolveApiKey = (
    apiKeyService as unknown as { resolveApiKey: MockFn }
  ).resolveApiKey;

  it("ECS EXECUTE loop with parent s3StateKey: null and computeTargetId: null — fails with PlanStateUnavailable, runEcsTask not called", async () => {
    const childLoop = buildLoop({
      status: "PENDING",
      command: "EXECUTE",
      parentLoopId: "parent-1",
      computeTargetId: null,
    });
    const parentLoop = buildLoop({
      id: "parent-1",
      s3StateKey: null,
      computeTargetId: null,
    });

    // First findById call: getPendingLoopOrThrow (child loop)
    // Second findById call: resolveParentLoopInfo (parent loop)
    mockLoopsService.findById
      .mockResolvedValueOnce(childLoop)
      .mockResolvedValueOnce(parentLoop);

    await launchLoop("loop-1", "org-1");

    expect(mockLoopsService.updateStatus).toHaveBeenCalledWith(
      "loop-1",
      "org-1",
      LoopStatus.Failed,
      expect.objectContaining({
        error: expect.objectContaining({
          code: LoopErrorCode.PlanStateUnavailable,
        }),
      })
    );
    expect(mockRunEcsTask).not.toHaveBeenCalled();
  });

  it("Desktop EXECUTE loop with parent s3StateKey: null and computeTargetId: 'ct-parent' — launchLoopOnDesktop IS called", async () => {
    const childLoop = buildLoop({
      status: "PENDING",
      command: "EXECUTE",
      parentLoopId: "parent-1",
      computeTargetId: "ct-child",
    });
    const parentLoop = buildLoop({
      id: "parent-1",
      s3StateKey: null,
      computeTargetId: "ct-parent",
    });

    mockLoopsService.findById
      .mockResolvedValueOnce(childLoop)
      .mockResolvedValueOnce(parentLoop);

    mockLaunchLoopOnDesktop.mockResolvedValue("cmd-desktop-1");
    mockLoopsService.updateStatus.mockResolvedValue(undefined);

    await launchLoop("loop-1", "org-1");

    expect(mockLaunchLoopOnDesktop).toHaveBeenCalledTimes(1);
    expect(mockLoopsService.updateStatus).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      LoopStatus.Failed,
      expect.anything()
    );
  });

  it("EXECUTE loop with no parentLoopId — launches normally (ECS path, guard does not fire)", async () => {
    const childLoop = buildLoop({
      status: "PENDING",
      command: "EXECUTE",
      parentLoopId: null,
      computeTargetId: null,
    });

    mockLoopsService.findById.mockResolvedValue(childLoop);
    mockRunEcsTask.mockResolvedValue("ecs-task-arn");
    mockLoopsService.updateStatus.mockResolvedValue(undefined);

    // The ECS launch may fail downstream (API key not configured) but the
    // pre-dispatch guard must NOT have fired with PlanStateUnavailable.
    await launchLoop("loop-1", "org-1").catch(() => undefined);

    expect(mockLoopsService.updateStatus).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      LoopStatus.Failed,
      expect.objectContaining({
        error: expect.objectContaining({
          code: LoopErrorCode.PlanStateUnavailable,
        }),
      })
    );
  });

  it("PLAN loop with parentLoopId and parent s3StateKey: null — launches normally (requiresParent: false, guard does not fire)", async () => {
    const childLoop = buildLoop({
      status: "PENDING",
      command: "PLAN",
      parentLoopId: "parent-1",
      computeTargetId: null,
    });
    const parentLoop = buildLoop({
      id: "parent-1",
      s3StateKey: null,
      computeTargetId: null,
    });

    mockLoopsService.findById
      .mockResolvedValueOnce(childLoop)
      .mockResolvedValueOnce(parentLoop);
    mockRunEcsTask.mockResolvedValue("ecs-task-arn");
    mockLoopsService.updateStatus.mockResolvedValue(undefined);

    // The ECS launch may fail downstream (API key not configured) but the
    // pre-dispatch guard must NOT have fired with PlanStateUnavailable.
    await launchLoop("loop-1", "org-1").catch(() => undefined);

    expect(mockLoopsService.updateStatus).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      LoopStatus.Failed,
      expect.objectContaining({
        error: expect.objectContaining({
          code: LoopErrorCode.PlanStateUnavailable,
        }),
      })
    );
  });

  it("parent findById returns null — PLAN_STATE_UNAVAILABLE triggered, no call to apiKeyService.resolveApiKey", async () => {
    const childLoop = buildLoop({
      status: "PENDING",
      command: "EXECUTE",
      parentLoopId: "parent-1",
      computeTargetId: null,
    });

    // First call: getPendingLoopOrThrow returns the child loop
    // Second call: resolveParentLoopInfo — parent not found
    mockLoopsService.findById
      .mockResolvedValueOnce(childLoop)
      .mockResolvedValueOnce(null);

    await launchLoop("loop-1", "org-1");

    expect(mockLoopsService.updateStatus).toHaveBeenCalledWith(
      "loop-1",
      "org-1",
      LoopStatus.Failed,
      expect.objectContaining({
        error: expect.objectContaining({
          code: LoopErrorCode.PlanStateUnavailable,
        }),
      })
    );
    expect(mockResolveApiKey).not.toHaveBeenCalled();
    expect(mockRunEcsTask).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleLoopEvent — isOverridingFailure for CANCELLED loops
// ---------------------------------------------------------------------------

describe("handleLoopEvent isOverridingFailure for CANCELLED loops", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Safety net: ensure withDb resolves without hanging if called unexpectedly
    // NOTE: vi.spyOn below depends on object reference equality — loopsService
    // must be the same object instance imported here and in loop-orchestrator.ts.
    // Because @/app/loops/service is vi.mock'd at the top of this file, the
    // imported loopsService IS the mock object used by the module under test.
    mockWithDb.mockResolvedValue(undefined);
  });

  it("passes error: null to updateStatus when overriding a CANCELLED loop with a completed event", async () => {
    const cancelledLoop = buildLoop({ status: "CANCELLED", s3StateKey: null });
    const completedLoop = buildLoop({ status: "COMPLETED" });

    const updateStatusSpy = vi
      .spyOn(loopsService, "updateStatus")
      .mockResolvedValue(completedLoop);
    vi.spyOn(loopsService, "findById").mockResolvedValue(
      cancelledLoop as LoopWithUser
    );
    vi.spyOn(loopsService, "addEvent").mockResolvedValue(true);

    const completedEvent = {
      type: "completed" as const,
      loopId: "loop-1",
      timestamp: "2026-02-17T00:00:00.000Z",
      result: {},
      tokensUsed: { input: 0, output: 0 },
    };

    await handleLoopEvent("loop-1", "org-1", completedEvent);

    expect(updateStatusSpy).toHaveBeenCalledWith(
      "loop-1",
      "org-1",
      "COMPLETED",
      expect.objectContaining({ error: null })
    );
  });
});
