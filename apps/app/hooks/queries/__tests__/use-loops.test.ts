import {
  COMMAND_SIGNING_CAPABILITY_KEY,
  type ComputeTarget,
  EXPLICIT_COMPUTE_SELECTION_FEATURE_FLAG_KEY,
  HarnessType,
} from "@repo/api/src/types/compute-target";
import { LoopStatus, RunLoopCommand } from "@repo/api/src/types/loop";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { cacheComputeTargetsForSigning } from "@/lib/desktop-command-signing/compute-target-signing-cache";
import { useCancelLoop, useRunLoop } from "../use-loops";
import { createWrapper } from "./test-utils";

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const mockUseFeatureFlagEnabled = vi.fn((_key: string) => false);
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => mockUseFeatureFlagEnabled(key),
}));

vi.mock("@repo/auth/client", () => ({
  useUser: () => ({ user: { id: "clerk-user-1" } }),
}));

const mockSignDesktopCommand = vi.fn(async () => ({
  commandId: "signed-command-1",
  signature: "signature",
  signaturePayload: "payload",
  publicKeyFingerprint: "fingerprint",
}));
vi.mock(
  "@/lib/desktop-command-signing/command-signer",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@/lib/desktop-command-signing/command-signer")
      >();
    return {
      ...original,
      signDesktopCommand: (
        ...args: Parameters<typeof mockSignDesktopCommand>
      ) => mockSignDesktopCommand(...args),
    };
  }
);

function makeComputeTarget(
  overrides: Partial<ComputeTarget> = {}
): ComputeTarget {
  return {
    id: "target-1",
    organizationId: "org-1",
    userId: "user-1",
    machineName: "Test-MBP",
    platform: "darwin",
    capabilities: { [COMMAND_SIGNING_CAPABILITY_KEY]: true },
    supportedOperations: [],
    lastSeenAt: new Date("2026-05-10T12:00:00.000Z"),
    isOnline: true,
    isSharedWithOrg: false,
    serverCapabilities: { computeTargetSigning: true },
    selectedHarness: HarnessType.Claude,
    createdAt: new Date("2026-05-10T12:00:00.000Z"),
    updatedAt: new Date("2026-05-10T12:00:00.000Z"),
    ...overrides,
  };
}

describe("useRunLoop explicit compute selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheComputeTargetsForSigning([]);
    mockUseFeatureFlagEnabled.mockReturnValue(true);
  });

  test("preserves legacy launch behavior when explicit compute selection is disabled", async () => {
    mockUseFeatureFlagEnabled.mockReturnValue(false);
    mockApiClient.post.mockResolvedValueOnce({
      loopId: "loop-legacy",
      status: LoopStatus.Pending,
    });

    const { result } = renderHook(() => useRunLoop(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({
      documentId: "doc-1",
      command: RunLoopCommand.Plan,
      prompt: "Plan the work",
      repo: { fullName: "closedloop-ai/symphony-alpha", branch: "main" },
      additionalRepos: [{ fullName: "closedloop-ai/peer", branch: "main" }],
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockUseFeatureFlagEnabled).toHaveBeenCalledWith(
      EXPLICIT_COMPUTE_SELECTION_FEATURE_FLAG_KEY
    );
    expect(mockApiClient.get).not.toHaveBeenCalled();
    expect(mockSignDesktopCommand).not.toHaveBeenCalled();
    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/documents/doc-1/run-loop",
      {
        command: RunLoopCommand.Plan,
        prompt: "Plan the work",
        repo: { fullName: "closedloop-ai/symphony-alpha", branch: "main" },
        additionalRepos: [{ fullName: "closedloop-ai/peer", branch: "main" }],
      }
    );
  });

  test("blocks missing explicit preference before namespace resolution, signing, or POST", async () => {
    mockApiClient.get.mockResolvedValueOnce({
      preferredComputeMode: "CLOUD",
      isExplicit: false,
    });

    const { result } = renderHook(() => useRunLoop(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({
      documentId: "doc-1",
      command: RunLoopCommand.Plan,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(mockApiClient.get).toHaveBeenCalledWith(
      "/settings/compute-preference"
    );
    expect(mockSignDesktopCommand).not.toHaveBeenCalled();
    expect(mockApiClient.post).not.toHaveBeenCalled();
  });

  test("allows explicit Cloud override without reading persisted preference", async () => {
    mockApiClient.post.mockResolvedValueOnce({
      loopId: "loop-1",
      status: LoopStatus.Pending,
    });

    const { result } = renderHook(() => useRunLoop(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({
      documentId: "doc-1",
      command: RunLoopCommand.Plan,
      computeTargetId: null,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.get).not.toHaveBeenCalled();
    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/documents/doc-1/run-loop",
      { command: RunLoopCommand.Plan, computeTargetId: null }
    );
  });

  test("resolves explicit Local to an online target before signing and POST", async () => {
    mockApiClient.get
      .mockResolvedValueOnce({
        preferredComputeMode: "LOCAL",
        isExplicit: true,
        computeTargetId: "target-1",
      })
      .mockResolvedValueOnce([makeComputeTarget()]);
    mockApiClient.post.mockResolvedValueOnce({
      loopId: "loop-1",
      status: LoopStatus.Pending,
    });

    const { result } = renderHook(() => useRunLoop(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({
      documentId: "doc-1",
      command: RunLoopCommand.GeneratePrd,
      additionalRepos: [{ fullName: "org/peer", branch: "main" }],
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockSignDesktopCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          documentId: "doc-1",
          command: RunLoopCommand.GeneratePrd,
          computeTargetId: "target-1",
          additionalRepos: [{ fullName: "org/peer", branch: "main" }],
        }),
      }),
      expect.objectContaining({ id: "target-1" })
    );
    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/documents/doc-1/run-loop",
      expect.objectContaining({
        command: RunLoopCommand.GeneratePrd,
        computeTargetId: "target-1",
        additionalRepos: [{ fullName: "org/peer", branch: "main" }],
        userIntentSignature: expect.objectContaining({
          body: expect.objectContaining({
            documentId: "doc-1",
            command: RunLoopCommand.GeneratePrd,
            computeTargetId: "target-1",
          }),
        }),
      })
    );
  });
});

describe("useCancelLoop command signing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheComputeTargetsForSigning([]);
  });

  test("signs cancel requests for the current eligible cached target", async () => {
    cacheComputeTargetsForSigning([makeComputeTarget()]);
    mockApiClient.post.mockResolvedValueOnce({
      id: "loop-1",
      status: LoopStatus.Cancelled,
    });

    const { result } = renderHook(() => useCancelLoop(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({ id: "loop-1", computeTargetId: "target-1" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockSignDesktopCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        pathWithQuery: "/api/gateway/symphony/loop/kill",
        body: {
          loopId: "loop-1",
          computeTargetId: "target-1",
          action: "cancel_loop",
        },
      }),
      expect.objectContaining({ id: "target-1" })
    );
    expect(mockApiClient.post).toHaveBeenCalledWith("/loops/loop-1/cancel", {
      userIntentSignature: expect.objectContaining({
        commandId: "signed-command-1",
        body: {
          loopId: "loop-1",
          computeTargetId: "target-1",
          action: "cancel_loop",
        },
      }),
    });
    expect(mockApiClient.delete).not.toHaveBeenCalled();
  });

  test("omits signing and uses the legacy delete path after refreshed ineligible state", async () => {
    cacheComputeTargetsForSigning([makeComputeTarget()]);
    cacheComputeTargetsForSigning([
      makeComputeTarget({ serverCapabilities: {} }),
    ]);
    mockApiClient.delete.mockResolvedValueOnce({
      id: "loop-1",
      status: LoopStatus.Cancelled,
    });

    const { result } = renderHook(() => useCancelLoop(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({ id: "loop-1", computeTargetId: "target-1" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockSignDesktopCommand).not.toHaveBeenCalled();
    expect(mockApiClient.delete).toHaveBeenCalledWith("/loops/loop-1");
    expect(mockApiClient.post).not.toHaveBeenCalled();
  });
});
