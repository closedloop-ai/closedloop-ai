/**
 * ISS-5711: a loop whose LAUNCH failed must be recorded as FAILED with an
 * error code and an error event — never as CANCELLED, which reads to every
 * consumer (terminal label, status badge, progress panel, and the
 * `ghost-loop-ux` recovery affordance) as "the user cancelled this run".
 *
 * The regression risk runs in both directions, so this file pins both:
 *   - a failed launch is NOT recorded as a user cancellation, and
 *   - the launch-failure path never reaches `loopsService.cancel`, which stays
 *     reserved for genuine user cancellation (covered end-to-end by
 *     `loop-cancel-routes.test.ts` and `loops-service-transitions.test.ts`).
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
import type * as LoopDesktop from "@/lib/loops/loop-desktop";

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
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    DEPLOYMENT: "DEPLOYMENT",
  },
}));

vi.mock("@/app/artifacts/service", () => ({
  getCommitterInfo: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/app/documents/document-service", () => ({
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
    updateMetadata: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
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
  return createLoopRunnerJwtMockModule(importOriginal, {
    token: "runner-jwt-token",
  });
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
  const actual = await importActual<typeof LoopDesktop>();
  return {
    buildDesktopLoopExecutionBody: actual.buildDesktopLoopExecutionBody,
    DispatchError: actual.DispatchError,
    isDispatchError: actual.isDispatchError,
    launchLoopOnDesktop: vi.fn().mockResolvedValue("cmd-desktop-1"),
    stopDesktopLoop: vi.fn().mockResolvedValue(undefined),
  };
});

const mockRunEcsTask = vi.fn().mockResolvedValue("ecs-task-arn");
vi.mock("@/lib/loops/loop-ecs", () => ({
  runEcsTask: (...args: unknown[]) => mockRunEcsTask(...args),
  stopLoopTask: vi.fn().mockResolvedValue(undefined),
}));

import { LoopErrorCode, LoopStatus } from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { getInstallationAccessToken } from "@repo/github";
import { githubService } from "@/app/integrations/github/service";
import { isInvalidStatusTransitionError } from "@/app/loops/loop-errors";
import { loopsService } from "@/app/loops/service";
import { apiKeyService } from "@/app/settings/api-key-service";
import {
  DispatchError,
  launchLoopOnDesktop,
  stopDesktopLoop,
} from "@/lib/loops/loop-desktop";
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
const mockIsInvalidStatusTransitionError =
  isInvalidStatusTransitionError as unknown as MockFn;

const LAUNCH_ERROR_MESSAGE = "GitHub App auth failed";

function restoreEnvVar(name: string, value: string | undefined) {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
    return;
  }
  process.env[name] = value;
}

describe("launchLoop — a failed launch is recorded as FAILED, not CANCELLED", () => {
  const originalApiBaseUrl = process.env.API_BASE_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.API_BASE_URL = "https://api.test";

    mockApiKeyService.resolveApiKey.mockResolvedValue("sk-anthropic-key");
    mockGithubService.findInstallationForRepoFullName.mockResolvedValue(
      "installation-123"
    );
    mockGetInstallationAccessToken.mockRejectedValue(
      new Error(LAUNCH_ERROR_MESSAGE)
    );
    mockRunEcsTask.mockResolvedValue("ecs-task-arn");
    mockLoopsService.updateStatus.mockResolvedValue(undefined);
    mockIsInvalidStatusTransitionError.mockReturnValue(false);
    mockWithDb.mockResolvedValue({ slug: "my-artifact" });
    mockLoopsService.findById.mockResolvedValue(
      buildLoop({
        status: LoopStatus.Pending,
        computeTargetId: null,
        repo: { fullName: "org/repo", branch: "main" },
      })
    );
  });

  afterEach(() => {
    restoreEnvVar("API_BASE_URL", originalApiBaseUrl);
  });

  it("records FAILED with the LAUNCH_FAILED error code and rethrows the launch error", async () => {
    await expect(launchLoop("loop-1", "org-1")).rejects.toThrow(
      LAUNCH_ERROR_MESSAGE
    );

    expect(mockLoopsService.updateStatus).toHaveBeenCalledWith(
      "loop-1",
      "org-1",
      LoopStatus.Failed,
      expect.objectContaining({
        error: expect.objectContaining({ code: LoopErrorCode.LaunchFailed }),
      })
    );
  });

  it("keeps startedAt null so a run that never began shows no start time or duration", async () => {
    await expect(launchLoop("loop-1", "org-1")).rejects.toThrow(
      LAUNCH_ERROR_MESSAGE
    );

    // `updateStatus` backfills `startedAt` on every terminal transition unless
    // the caller explicitly passes null. Without this, the loop detail surface
    // renders a fabricated "Started" timestamp and duration that contradict the
    // LAUNCH_FAILED copy saying the run never began (ISS-5711).
    expect(mockLoopsService.updateStatus).toHaveBeenCalledWith(
      "loop-1",
      "org-1",
      LoopStatus.Failed,
      expect.objectContaining({ startedAt: null })
    );
  });

  it("never routes a launch failure through the user-cancellation path", async () => {
    await expect(launchLoop("loop-1", "org-1")).rejects.toThrow(
      LAUNCH_ERROR_MESSAGE
    );

    expect(mockLoopsService.cancel).not.toHaveBeenCalled();
    expect(mockLoopsService.updateStatus).not.toHaveBeenCalledWith(
      "loop-1",
      "org-1",
      LoopStatus.Cancelled,
      expect.anything()
    );
  });

  it("appends an error event so the durable trace carries a code and message", async () => {
    await expect(launchLoop("loop-1", "org-1")).rejects.toThrow(
      LAUNCH_ERROR_MESSAGE
    );

    expect(mockLoopsService.addEvent).toHaveBeenCalledWith("loop-1", "org-1", {
      type: "error",
      data: expect.objectContaining({
        code: LoopErrorCode.LaunchFailed,
        message: expect.any(String),
        timestamp: expect.any(String),
      }),
    });
  });

  it("still surfaces the original launch error when the FAILED bookkeeping write itself throws", async () => {
    mockLoopsService.updateStatus.mockRejectedValue(
      new Error("database unavailable")
    );

    await expect(launchLoop("loop-1", "org-1")).rejects.toThrow(
      LAUNCH_ERROR_MESSAGE
    );
  });

  // ISS-5711: `cleanupOnLaunchFailure` dispatches a kill to the compute target,
  // and the runner can answer `cancelled` fast enough to land while cleanup is
  // still in flight. From PENDING that is a LEGAL transition to CANCELLED,
  // after which the FAILED write is refused from a terminal source and
  // swallowed as a benign race -- the loop would settle as CANCELLED and
  // reintroduce the exact bug this PR fixes. Claiming FAILED first makes the
  // loop terminal before any kill goes out, so the race is closed by ordering
  // rather than by luck. Pinned with invocation order (no wall clock).
  it("records FAILED before cleanup dispatches the kill to the compute target", async () => {
    mockLoopsService.findById.mockResolvedValue(
      buildLoop({
        status: LoopStatus.Pending,
        computeTargetId: "ct-1",
        repo: { fullName: "org/repo", branch: "main" },
      })
    );
    // Reach dispatch (so cleanup has an orphaned commandId to kill) and fail
    // there with a DispatchError, which is what carries the commandId.
    mockGetInstallationAccessToken.mockResolvedValue("gh-token");
    (launchLoopOnDesktop as unknown as MockFn).mockRejectedValue(
      new DispatchError("desktop refused the dispatch", "cmd-desktop-1")
    );

    await expect(launchLoop("loop-1", "org-1")).rejects.toThrow(
      "desktop refused the dispatch"
    );

    const failOrder = (
      mockLoopsService.updateStatus as unknown as MockFn
    ).mock.invocationCallOrder.at(0);
    const killOrder = (
      stopDesktopLoop as unknown as MockFn
    ).mock.invocationCallOrder.at(0);

    // Both must actually have happened, or the ordering claim is vacuous.
    expect(failOrder).toBeDefined();
    expect(killOrder).toBeDefined();
    expect(failOrder as number).toBeLessThan(killOrder as number);
  });

  it("tolerates the terminal race where another handler already finished the loop", async () => {
    mockIsInvalidStatusTransitionError.mockReturnValue(true);
    mockLoopsService.updateStatus.mockRejectedValue(
      Object.assign(new Error("invalid transition"), {
        from: LoopStatus.Completed,
        to: LoopStatus.Failed,
      })
    );

    await expect(launchLoop("loop-1", "org-1")).rejects.toThrow(
      LAUNCH_ERROR_MESSAGE
    );

    expect(mockLoopsService.addEvent).not.toHaveBeenCalled();
  });
});
