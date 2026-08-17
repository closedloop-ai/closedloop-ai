/**
 * Tests for handleLoopCompleted command dispatch behavior.
 *
 * Verifies that handleLoopEvent dispatches to the correct handler's
 * downloadArtifacts + ingest based on the loop's command.
 *
 * NOTE: fetchPrimaryArtifact / buildContextPack command branching is covered
 * in build-context-pack.test.ts — no need to duplicate here.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

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

vi.mock("@/app/documents/document-service", () => ({
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
    updateMetadata: vi.fn().mockResolvedValue(1),
    persistLaunchInfo: vi.fn(),
    cancel: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/app/loops/loop-errors", () => ({
  isInvalidStatusTransitionError: vi.fn(),
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
  LoopCommand,
  LoopErrorCode,
  LoopStatus,
  type LoopWithUser,
} from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { isInvalidStatusTransitionError } from "@/app/loops/loop-errors";
import { loopsService } from "@/app/loops/service";
import { apiKeyService } from "@/app/settings/api-key-service";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { LaunchNotDispatchedError } from "@/lib/loops/launch-not-dispatched-error";
import {
  DispatchError,
  launchLoopOnDesktop,
  stopDesktopLoop,
} from "@/lib/loops/loop-desktop";
import { dispatchAndClassify } from "@/lib/loops/loop-dispatch-utils";
import { runEcsTask } from "@/lib/loops/loop-ecs";
import { handleLoopEvent, launchLoop } from "@/lib/loops/loop-orchestrator";
import { buildLoop } from "../fixtures/loop";

type MockFn = ReturnType<typeof vi.fn>;

const mockWithDb = withDb as unknown as Mock;

const mockIsInvalidStatusTransitionError =
  isInvalidStatusTransitionError as unknown as MockFn;

const mockLoopsService = loopsService as unknown as {
  findById: MockFn;
  updateStatus: MockFn;
  addEvent: MockFn;
  updateMetadata: MockFn;
  cancel: MockFn;
};

const mockDesktopCommandStore = desktopCommandStore as unknown as {
  markCommandExpired: MockFn;
};

const mockLog = log as unknown as { error: MockFn; warn: MockFn };

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

  function setupLoopForCompleted(command: LoopCommand) {
    const loop = buildLoop({
      command,
      s3StateKey: "org/loops/loop-1/run-1",
      documentId: "artifact-1",
    });
    mockLoopsService.findById.mockResolvedValue(loop);
    mockLoopsService.updateStatus.mockResolvedValue(undefined);
    mockLoopsService.addEvent.mockResolvedValue(undefined);
  }

  it("PLAN command: calls plan handler", async () => {
    setupLoopForCompleted(LoopCommand.Plan);

    await handleLoopEvent("loop-1", "org-1", completedEvent);

    expect(mockPlanDownloadAndIngest).toHaveBeenCalledTimes(1);
    expect(mockExecuteDownloadAndIngest).not.toHaveBeenCalled();
  });

  it("REQUEST_CHANGES command: calls plan handler", async () => {
    setupLoopForCompleted(LoopCommand.RequestChanges);

    await handleLoopEvent("loop-1", "org-1", completedEvent);

    expect(mockPlanDownloadAndIngest).toHaveBeenCalledTimes(1);
    expect(mockExecuteDownloadAndIngest).not.toHaveBeenCalled();
  });

  it("EXECUTE command: calls execute handler", async () => {
    setupLoopForCompleted(LoopCommand.Execute);

    await handleLoopEvent("loop-1", "org-1", completedEvent);

    expect(mockExecuteDownloadAndIngest).toHaveBeenCalledTimes(1);
    expect(mockPlanDownloadAndIngest).not.toHaveBeenCalled();
  });

  it("DECOMPOSE command: calls decompose handler", async () => {
    setupLoopForCompleted(LoopCommand.Decompose);

    await handleLoopEvent("loop-1", "org-1", completedEvent);

    expect(mockDecomposeDownloadAndIngest).toHaveBeenCalledTimes(1);
    expect(mockPlanDownloadAndIngest).not.toHaveBeenCalled();
    expect(mockExecuteDownloadAndIngest).not.toHaveBeenCalled();
  });

  it("MANUAL command: skips S3 ingestion entirely", async () => {
    setupLoopForCompleted(LoopCommand.Manual);

    await handleLoopEvent("loop-1", "org-1", completedEvent);

    expect(mockPlanDownloadAndIngest).not.toHaveBeenCalled();
    expect(mockExecuteDownloadAndIngest).not.toHaveBeenCalled();
    expect(mockDecomposeDownloadAndIngest).not.toHaveBeenCalled();
  });

  it("unknown command: calls neither handler", async () => {
    setupLoopForCompleted(LoopCommand.Chat);

    await handleLoopEvent("loop-1", "org-1", completedEvent);

    expect(mockPlanDownloadAndIngest).not.toHaveBeenCalled();
    expect(mockExecuteDownloadAndIngest).not.toHaveBeenCalled();
    expect(mockDecomposeDownloadAndIngest).not.toHaveBeenCalled();
  });

  it("loop without s3StateKey: skips artifact ingestion entirely", async () => {
    const loop = buildLoop({
      command: LoopCommand.Plan,
      s3StateKey: null,
      documentId: "artifact-1",
    });
    mockLoopsService.findById.mockResolvedValue(loop);

    await handleLoopEvent("loop-1", "org-1", completedEvent);

    expect(mockPlanDownloadAndIngest).not.toHaveBeenCalled();
  });

  it("loop without documentId: skips artifact ingestion entirely", async () => {
    const loop = buildLoop({
      command: LoopCommand.Plan,
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

  // `vi.clearAllMocks()` clears call records but NOT implementations or
  // `mockResolvedValueOnce` queues, so the durability tests below -- which make
  // `updateStatus` reject and queue two `findById` results -- would otherwise
  // leak into later describes and make unrelated suites fail. Restore the
  // module-mock defaults here rather than leave that trap set.
  afterEach(() => {
    process.env.API_BASE_URL = originalEnv.API_BASE_URL;
    mockLoopsService.findById.mockReset();
    mockLoopsService.updateStatus.mockReset();
    mockLoopsService.updateStatus.mockResolvedValue(undefined);
    mockLoopsService.addEvent.mockReset();
    mockLoopsService.addEvent.mockResolvedValue(undefined);
    mockIsInvalidStatusTransitionError.mockReset();
  });

  // ISS-5711: the relay-failure path expires the orphaned command and then
  // records the loop as FAILED. It used to record CANCELLED, which told the
  // user they had stopped a run that a relay outage killed.
  it("expires the orphaned command and fails the loop when launchLoopOnDesktop throws a DispatchError", async () => {
    const loop = buildLoop({
      status: LoopStatus.Pending,
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
    mockLoopsService.updateStatus.mockResolvedValue(undefined);

    await expect(launchLoop("loop-1", "org-1")).rejects.toThrow(
      "relay unreachable"
    );

    expect(mockDesktopCommandStore.markCommandExpired).toHaveBeenCalledWith(
      "cmd-orphan-1",
      expect.any(String),
      { computeTargetId: "target-1" }
    );

    expect(mockLoopsService.cancel).not.toHaveBeenCalled();
    expect(mockLoopsService.updateStatus).toHaveBeenCalledWith(
      "loop-1",
      "org-1",
      LoopStatus.Failed,
      expect.objectContaining({
        error: expect.objectContaining({ code: LoopErrorCode.LaunchFailed }),
      })
    );
  });

  // ISS-5708's durability claim, restated for the ISS-5711 verb. The failure
  // path no longer cancels-then-escalates-to-FAILED; FAILED *is* the write. But
  // the guarantee is unchanged: the launch routes answer on the strength of the
  // failure being durable server-side, so a terminal write that did not land
  // must be said out loud rather than swallowed, or the row keeps its active
  // tokens and its (artifactId, command) index slot and blocks the user's retry.
  it("reports the row as still active when the FAILED write itself fails", async () => {
    const loop = buildLoop({
      status: LoopStatus.Pending,
      computeTargetId: "target-1",
    });
    mockLoopsService.findById
      // getPendingLoopOrThrow
      .mockResolvedValueOnce(loop)
      // the durability probe's re-read: still non-terminal
      .mockResolvedValueOnce(loop);

    mockLaunchLoopOnDesktop.mockRejectedValue(
      new DispatchError("relay unreachable", "cmd-orphan-2")
    );
    mockStopDesktopLoop.mockResolvedValue(undefined);
    mockDesktopCommandStore.markCommandExpired.mockResolvedValue(undefined);
    // Not a status-transition race — a genuine failure, the case that must not
    // be swallowed.
    mockIsInvalidStatusTransitionError.mockReturnValue(false);
    mockLoopsService.updateStatus.mockRejectedValue(
      new Error("db connection lost")
    );

    await expect(launchLoop("loop-1", "org-1")).rejects.toThrow(
      "relay unreachable"
    );

    expect(mockLog.error).toHaveBeenCalledWith(
      "loop.launch_failure_not_durable",
      expect.objectContaining({
        loopId: "loop-1",
        status: LoopStatus.Pending,
      })
    );
  });

  it("stays quiet when the failed FAILED write raced another handler to terminal", async () => {
    // Positive control for the assertion above, and the reason the probe
    // re-reads instead of alarming on any write failure: the write can fail for
    // reasons unrelated to the row's state, and a row another handler already
    // drove to terminal is not stuck.
    const loop = buildLoop({
      status: LoopStatus.Pending,
      computeTargetId: "target-1",
    });
    mockLoopsService.findById
      // getPendingLoopOrThrow
      .mockResolvedValueOnce(loop)
      // the durability probe's re-read: already terminal
      .mockResolvedValueOnce(buildLoop({ status: LoopStatus.Completed }));

    mockLaunchLoopOnDesktop.mockRejectedValue(
      new DispatchError("relay unreachable", "cmd-orphan-3")
    );
    mockStopDesktopLoop.mockResolvedValue(undefined);
    mockDesktopCommandStore.markCommandExpired.mockResolvedValue(undefined);
    mockIsInvalidStatusTransitionError.mockReturnValue(false);
    mockLoopsService.updateStatus.mockRejectedValue(
      new Error("db connection lost")
    );

    await expect(launchLoop("loop-1", "org-1")).rejects.toThrow(
      "relay unreachable"
    );

    expect(mockLog.error).not.toHaveBeenCalledWith(
      "loop.launch_failure_not_durable",
      expect.anything()
    );
  });
});

// ---------------------------------------------------------------------------
// dispatchAndClassify + launchLoop — error-level ownership across the two
// layers. Both run for real here; only the provider edge is mocked. A route
// test that mocks `launchLoop` cannot see this, because the layer it stubs is
// the one that used to log the duplicate.
// ---------------------------------------------------------------------------

describe("dropped dispatch logging (dispatchAndClassify ∘ launchLoop)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.API_BASE_URL = "https://api.test";
  });

  afterEach(() => {
    process.env.API_BASE_URL = originalEnv.API_BASE_URL;
  });

  it("writes exactly one error-level entry for one dropped dispatch", async () => {
    // Alert-noise contract, not incidental logging: an offline desktop is a
    // common user state on the highest-traffic launch route. `launchLoop`
    // logged `loop.launch_failed` at error, rethrew, and `dispatchAndClassify`
    // logged again — two Datadog errors per outage, the exact duplication
    // `dispatchFailureResponse` refuses to add a third of. The entry that
    // survives must be the classified one, carrying the raw error.
    const loop = buildLoop({
      status: LoopStatus.Pending,
      computeTargetId: "target-1",
    });
    mockLoopsService.findById.mockResolvedValue(loop);

    mockLaunchLoopOnDesktop.mockRejectedValue(
      new DispatchError("relay unreachable", "cmd-log-1")
    );
    mockStopDesktopLoop.mockResolvedValue(undefined);
    mockDesktopCommandStore.markCommandExpired.mockResolvedValue(undefined);
    mockLoopsService.cancel.mockResolvedValue(undefined);

    const result = await dispatchAndClassify("loop-1", "org-1", "run-loop", {
      documentId: "artifact-1",
    });

    expect(result).toEqual({ ok: false, error: "launch_failed" });
    expect(mockLog.error).toHaveBeenCalledTimes(1);
    expect(mockLog.error).toHaveBeenCalledWith(
      "[run-loop] Failed to launch loop",
      expect.objectContaining({
        error: expect.any(DispatchError),
        launchError: "launch_failed",
        loopId: "loop-1",
      })
    );
    // Positive control on the same predicate: the orchestrator-layer trace
    // event still exists, it is just no longer error-level. Without this, a
    // change that deleted the entry outright would also pass the count above.
    expect(mockLog.warn).toHaveBeenCalledWith(
      "loop.launch_failed",
      expect.objectContaining({ computeTargetId: "target-1", loopId: "loop-1" })
    );
  });

  it("writes exactly one error-level entry when the pre-dispatch guard refuses", async () => {
    const childLoop = buildLoop({
      status: LoopStatus.Pending,
      command: "EXECUTE",
      parentLoopId: "parent-1",
      computeTargetId: null,
    });
    mockLoopsService.findById
      .mockResolvedValueOnce(childLoop)
      .mockResolvedValueOnce(null);

    const result = await dispatchAndClassify("loop-1", "org-1", "run-loop");

    expect(result).toEqual({ ok: false, error: "parent_state_unavailable" });
    expect(mockLog.error).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).toHaveBeenCalledWith(
      "loop.pre_dispatch_guard_failed",
      expect.objectContaining({ loopId: "loop-1" })
    );
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
      status: LoopStatus.Pending,
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

    // ISS-5708: the guard must not resolve. `dispatchAndClassify` reads any
    // resolve as a delivered launch, so a plain return here made the route
    // answer 200 for a loop it had just marked FAILED and never dispatched.
    await expect(launchLoop("loop-1", "org-1")).rejects.toBeInstanceOf(
      LaunchNotDispatchedError
    );

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

  // ISS-5711: `failLoopWithError` swallows an invalid transition ONLY when the
  // loop is already terminal (a benign race). From a NON-terminal status the
  // refusal is a real validation problem and must surface to the caller rather
  // than be silently absorbed. This guard path calls `failLoopWithError`
  // directly (no wrapper), so it is where that re-throw is observable.
  it("pre-dispatch guard: an invalid transition from a NON-terminal status is re-thrown, not swallowed", async () => {
    const childLoop = buildLoop({
      status: LoopStatus.Pending,
      command: "EXECUTE",
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

    mockIsInvalidStatusTransitionError.mockReturnValue(true);
    mockLoopsService.updateStatus.mockRejectedValue(
      Object.assign(new Error("invalid transition"), {
        from: LoopStatus.Pending,
        to: LoopStatus.Failed,
      })
    );

    await expect(launchLoop("loop-1", "org-1")).rejects.toThrow(
      "invalid transition"
    );
    expect(mockLoopsService.addEvent).not.toHaveBeenCalled();
  });

  // ISS-5711: the launch-failure cleanup kills the runner, which can answer
  // with a `cancelled` callback AFTER the loop already settled on FAILED.
  // Merely letting the FAILED -> CANCELLED transition be refused is not enough:
  // `handleLoopError` used to persist the `cancelled` event first, and
  // `deriveDisplayStatus` gives the last terminal EVENT priority over the
  // polled DB status (`loop-progress-panel.tsx:71-81`), so the panel reported
  // CANCELLED for a loop the database correctly recorded as FAILED. The event
  // has to be dropped before `addEvent` runs.
  it("drops a late cancelled event for an already-FAILED loop without persisting it", async () => {
    mockIsInvalidStatusTransitionError.mockReturnValue(false);
    mockLoopsService.updateStatus.mockResolvedValue(undefined);
    mockLoopsService.addEvent.mockResolvedValue(undefined);
    mockLoopsService.findById.mockResolvedValue(
      buildLoop({ status: LoopStatus.Failed })
    );

    const canonical = await handleLoopEvent("loop-1", "org-1", {
      type: "error",
      code: LoopErrorCode.Cancelled,
      message: "runner cancelled",
      timestamp: new Date().toISOString(),
    });

    // No cancelled event may reach the DB, and no CANCELLED transition may be
    // attempted -- the loop is already terminal on a different status.
    expect(mockLoopsService.addEvent).not.toHaveBeenCalled();
    expect(mockLoopsService.updateStatus).not.toHaveBeenCalled();
    // Nothing is broadcast either, so the panel never sees a cancelled event.
    expect(canonical).toEqual([]);
  });

  // Positive control for the assertion above: the SAME call on a still-running
  // loop must persist the cancelled event and drive the CANCELLED transition.
  // Without this, the three `not.toHaveBeenCalled()` assertions above would
  // pass just as well against a `handleLoopError` that never did anything.
  it("still records a genuine cancellation for a RUNNING loop (positive control)", async () => {
    // `vi.clearAllMocks()` clears call records but NOT implementations, so
    // reset the ones earlier tests in this block install.
    mockIsInvalidStatusTransitionError.mockReturnValue(false);
    mockLoopsService.updateStatus.mockResolvedValue(undefined);
    mockLoopsService.addEvent.mockResolvedValue(undefined);
    mockLoopsService.findById.mockResolvedValue(
      buildLoop({ status: LoopStatus.Running })
    );

    const canonical = await handleLoopEvent("loop-1", "org-1", {
      type: "error",
      code: LoopErrorCode.Cancelled,
      message: "user cancelled",
      timestamp: new Date().toISOString(),
    });

    expect(mockLoopsService.addEvent).toHaveBeenCalledWith(
      "loop-1",
      "org-1",
      expect.objectContaining({ type: "cancelled" }),
      undefined
    );
    expect(mockLoopsService.updateStatus).toHaveBeenCalledWith(
      "loop-1",
      "org-1",
      LoopStatus.Cancelled,
      expect.anything()
    );
    expect(canonical).toEqual([expect.objectContaining({ type: "cancelled" })]);
  });

  it("Desktop EXECUTE loop with parent s3StateKey: null and computeTargetId: 'ct-parent' — launchLoopOnDesktop IS called", async () => {
    const childLoop = buildLoop({
      status: LoopStatus.Pending,
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

    expect(mockLaunchLoopOnDesktop).toHaveBeenCalledOnce();
    expect(mockLaunchLoopOnDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        s3StateKey: "org/loops/loop-1/run-1",
      })
    );
    expect(mockLoopsService.updateStatus).toHaveBeenCalledWith(
      "loop-1",
      "org-1",
      LoopStatus.Claimed,
      expect.objectContaining({
        containerId: "cmd-desktop-1",
        s3StateKey: "org/loops/loop-1/run-1",
      })
    );
    expect(mockLoopsService.updateStatus).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      LoopStatus.Failed,
      expect.anything()
    );
  });

  it("EXECUTE loop with no parentLoopId — launches normally (ECS path, guard does not fire)", async () => {
    const childLoop = buildLoop({
      status: LoopStatus.Pending,
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
      status: LoopStatus.Pending,
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
      status: LoopStatus.Pending,
      command: "EXECUTE",
      parentLoopId: "parent-1",
      computeTargetId: null,
    });

    // First call: getPendingLoopOrThrow returns the child loop
    // Second call: resolveParentLoopInfo — parent not found
    mockLoopsService.findById
      .mockResolvedValueOnce(childLoop)
      .mockResolvedValueOnce(null);

    await expect(launchLoop("loop-1", "org-1")).rejects.toBeInstanceOf(
      LaunchNotDispatchedError
    );

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
    const cancelledLoop = buildLoop({
      status: LoopStatus.Cancelled,
      s3StateKey: null,
    });
    const completedLoop = buildLoop({ status: LoopStatus.Completed });

    const updateStatusSpy = vi
      .spyOn(loopsService, "updateStatus")
      .mockResolvedValue(completedLoop);
    vi.spyOn(loopsService, "findById").mockResolvedValue({
      ...(cancelledLoop as LoopWithUser),
      additionalRepos: null,
      primaryBranch: null,
      primaryPullRequest: null,
    });
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
      LoopStatus.Completed,
      expect.objectContaining({ error: null })
    );
  });
});
