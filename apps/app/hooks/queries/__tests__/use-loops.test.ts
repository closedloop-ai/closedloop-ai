import {
  type ComputeTarget,
  EXPLICIT_COMPUTE_SELECTION_FEATURE_FLAG_KEY,
} from "@repo/api/src/types/compute-target";
import {
  type InheritedAdditionalRepos,
  LoopCommand,
  LoopStatus,
  RunLoopCommand,
} from "@repo/api/src/types/loop";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  useInheritedAdditionalRepos,
  useResumeLoop,
  useRunLoop,
} from "../use-loops";
import { createWrapper } from "./test-utils";

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@/hooks/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const mockUseFeatureFlagEnabled = vi.fn((_key: string) => false);
vi.mock("@/hooks/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => mockUseFeatureFlagEnabled(key),
}));

vi.mock("@repo/auth/client", () => ({
  useUser: () => ({ user: { id: "clerk-user-1" } }),
}));

const mockResolveDesktopApiNamespaceHint = vi.fn(async () => null);
vi.mock("@/lib/engineer/local-gateway-api-namespace", () => ({
  resolveDesktopApiNamespaceHint: () => mockResolveDesktopApiNamespaceHint(),
}));

const mockSignDesktopCommand = vi.fn(async () => ({
  commandId: "signed-command-1",
  signature: "signature",
  signaturePayload: "payload",
  publicKeyFingerprint: "fingerprint",
}));
vi.mock("@/lib/crypto/command-signer", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/crypto/command-signer")>();
  return {
    ...original,
    signDesktopCommand: (...args: Parameters<typeof mockSignDesktopCommand>) =>
      mockSignDesktopCommand(...args),
  };
});

function makeComputeTarget(
  overrides: Partial<ComputeTarget> = {}
): ComputeTarget {
  return {
    id: "target-1",
    organizationId: "org-1",
    userId: "user-1",
    machineName: "Test-MBP",
    platform: "darwin",
    capabilities: { commandSigning: true },
    supportedOperations: [],
    lastSeenAt: new Date("2026-05-10T12:00:00.000Z"),
    isOnline: true,
    isSharedWithOrg: false,
    serverCapabilities: { computeTargetSigning: true },
    createdAt: new Date("2026-05-10T12:00:00.000Z"),
    updatedAt: new Date("2026-05-10T12:00:00.000Z"),
    ...overrides,
  };
}

describe("useResumeLoop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseFeatureFlagEnabled.mockReturnValue(false);
  });

  test("posts to /loops/:id/resume with body fields excluding id", async () => {
    const mockResponse = { loopId: "new-loop-456", status: LoopStatus.Pending };
    mockApiClient.post.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useResumeLoop(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({ id: "loop-123", prompt: "retry this" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.post).toHaveBeenCalledWith("/loops/loop-123/resume", {
      prompt: "retry this",
    });
    expect(result.current.data).toEqual(mockResponse);
  });

  test("posts to /loops/:id/resume with empty body when no optional fields provided", async () => {
    const mockResponse = { loopId: "new-loop-789", status: LoopStatus.Pending };
    mockApiClient.post.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useResumeLoop(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({ id: "loop-123" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/loops/loop-123/resume",
      {}
    );
  });

  test("returns error state when the API call fails", async () => {
    const mockError = new Error("Failed to resume loop");
    mockApiClient.post.mockRejectedValueOnce(mockError);

    const { result } = renderHook(() => useResumeLoop(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({ id: "loop-123" });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toEqual(mockError);
  });
});

describe("useRunLoop explicit compute selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(mockResolveDesktopApiNamespaceHint).toHaveBeenCalledOnce();
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
    expect(mockResolveDesktopApiNamespaceHint).not.toHaveBeenCalled();
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

// PLN-462: thin wrapper around the backend endpoint that resolves the
// inherited peer-repo set for the new-plan modal. The selection logic lives
// server-side; the hook just surfaces the small response payload.
describe("useInheritedAdditionalRepos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("hits /documents/:id/inherited-additional-repos with the target command and returns the response", async () => {
    const response: InheritedAdditionalRepos = {
      additionalRepos: [{ fullName: "org/peer-a", branch: "main" }],
      source: { loopId: "loop-1", command: LoopCommand.GeneratePrd },
    };
    mockApiClient.get.mockResolvedValueOnce(response);

    const { result } = renderHook(
      () => useInheritedAdditionalRepos("doc-1", LoopCommand.Plan),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.get).toHaveBeenCalledWith(
      `/documents/doc-1/inherited-additional-repos?command=${LoopCommand.Plan}`
    );
    expect(result.current.data).toEqual(response);
  });

  test("uses the EXECUTE command when launching execute", async () => {
    mockApiClient.get.mockResolvedValueOnce({
      additionalRepos: [],
      source: null,
    });

    const { result } = renderHook(
      () => useInheritedAdditionalRepos("doc-1", LoopCommand.Execute),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.get).toHaveBeenCalledWith(
      `/documents/doc-1/inherited-additional-repos?command=${LoopCommand.Execute}`
    );
  });

  test("returns empty additionalRepos and null source when nothing is inheritable", async () => {
    const response: InheritedAdditionalRepos = {
      additionalRepos: [],
      source: null,
    };
    mockApiClient.get.mockResolvedValueOnce(response);

    const { result } = renderHook(
      () => useInheritedAdditionalRepos("doc-1", LoopCommand.Plan),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(response);
  });

  test("hook is disabled when documentId is null", () => {
    const { result } = renderHook(
      () => useInheritedAdditionalRepos(null, LoopCommand.Plan),
      { wrapper: createWrapper() }
    );
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockApiClient.get).not.toHaveBeenCalled();
  });

  test("hook is disabled when documentId is an empty string", () => {
    const { result } = renderHook(
      () => useInheritedAdditionalRepos("", LoopCommand.Plan),
      { wrapper: createWrapper() }
    );
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockApiClient.get).not.toHaveBeenCalled();
  });
});
