/**
 * Tests that runner output token updates remain behind the event insert gate.
 *
 * A duplicate runner event is rejected by the `LoopEvent` unique key. The
 * orchestrator must not continue to cumulative token updates after that replay
 * is detected, otherwise concurrent retries can double-apply side effects.
 *
 * Co-located with the other `loop-orchestrator-*.test.ts` files so the
 * transitive mock surface for `handleLoopEvent` is amortised across orchestrator
 * tests rather than reproduced inside `loops-service-replay.test.ts`.
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

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

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

vi.mock("@/app/loops/loop-errors", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/app/loops/loop-errors")>();
  return {
    ...actual,
    isInvalidStatusTransitionError: vi.fn().mockReturnValue(false),
  };
});

vi.mock("@/app/loops/service", () => ({
  loopsService: {
    findById: vi.fn().mockResolvedValue(null),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    updateTokens: vi.fn().mockResolvedValue(undefined),
    addEvent: vi.fn().mockResolvedValue(true),
  },
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

import { LoopStatus } from "@repo/api/src/types/loop";
import { ReplayDetectedError } from "@/app/loops/loop-errors";
import { loopsService } from "@/app/loops/service";
import { handleLoopEvent } from "@/lib/loops/loop-orchestrator";
import { buildLoop } from "../fixtures/loop";

type MockFn = ReturnType<typeof vi.fn>;

// Relax the type to access vi.fn handles directly (the module mock above
// stubs every method with a vi.fn(), so the strict service signatures don't
// apply at the call site).
const mockLoopsService = loopsService as unknown as {
  findById: MockFn;
  updateStatus: MockFn;
  updateTokens: MockFn;
  addEvent: MockFn;
};

const LOOP_ID = "loop-abc-123";
const ORG_ID = "org-xyz-456";
const TOKEN_JTI = "jti-runner-001";
const NONCE = "11111111-1111-4111-8111-111111111111";

describe("handleLoopEvent — runner output token updates respect replay gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoopsService.findById.mockResolvedValue(
      buildLoop({ status: LoopStatus.Running })
    );
    mockLoopsService.updateStatus.mockResolvedValue(undefined);
    mockLoopsService.updateTokens.mockResolvedValue(undefined);
    mockLoopsService.addEvent.mockResolvedValue(true);
  });

  it("throws replay and does not call updateTokens when the runner event insert is duplicate", async () => {
    mockLoopsService.addEvent.mockRejectedValue(new ReplayDetectedError());

    const outputEvent = {
      type: "output" as const,
      chunk: "hello replay",
      timestamp: "2026-02-17T00:00:00.000Z",
      tokenUsage: { inputTokens: 1000, outputTokens: 500 },
    };

    await expect(
      handleLoopEvent(LOOP_ID, ORG_ID, outputEvent, {
        tokenJti: TOKEN_JTI,
        nonce: NONCE,
      })
    ).rejects.toBeInstanceOf(ReplayDetectedError);

    expect(mockLoopsService.updateTokens).not.toHaveBeenCalled();
  });

  it("does NOT call updateTokens when addEvent returns false and no replay context is provided", async () => {
    // System event path: a late event arrived for a terminal loop, so the
    // row was ignored. With no runner context, the event should be a true
    // no-op — no token-usage side-effects.
    mockLoopsService.addEvent.mockResolvedValue(false);

    const outputEvent = {
      type: "output" as const,
      chunk: "late output",
      timestamp: "2026-02-17T00:00:00.000Z",
      tokenUsage: { inputTokens: 1000, outputTokens: 500 },
    };

    await handleLoopEvent(LOOP_ID, ORG_ID, outputEvent);

    expect(mockLoopsService.updateTokens).not.toHaveBeenCalled();
  });

  it("calls updateTokens on the happy path (addEvent returns true with replay context)", async () => {
    mockLoopsService.addEvent.mockResolvedValue(true);

    const outputEvent = {
      type: "output" as const,
      chunk: "fresh output",
      timestamp: "2026-02-17T00:00:00.000Z",
      tokenUsage: { inputTokens: 200, outputTokens: 100 },
    };

    await handleLoopEvent(LOOP_ID, ORG_ID, outputEvent, {
      tokenJti: TOKEN_JTI,
      nonce: NONCE,
    });

    expect(mockLoopsService.updateTokens).toHaveBeenCalledWith(
      LOOP_ID,
      ORG_ID,
      200,
      100,
      0,
      0
    );
  });
});
