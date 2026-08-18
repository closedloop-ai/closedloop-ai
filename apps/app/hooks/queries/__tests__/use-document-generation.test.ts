import {
  COMMAND_SIGNING_CAPABILITY_KEY,
  HarnessType,
} from "@repo/api/src/types/compute-target";
import { DocumentType } from "@repo/api/src/types/document";
import { RunLoopCommand } from "@repo/api/src/types/loop";
import { ApiError } from "@repo/app/shared/api/api-error";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  useCreateAndGenerateDocument,
  useGeneratePrdFromDocument,
  useGeneratePrdLaunch,
} from "../use-document-generation";
import { createWrapper } from "./test-utils";

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};
const mockToastError = vi.hoisted(() => vi.fn());

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: mockToastError,
  },
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

describe("useCreateAndGenerateDocument", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("selectTarget retry includes additionalRepos from the original mutateAsync call", async () => {
    const mockArtifact = createMockDocument({
      id: "artifact-456",
      projectId: "project-123",
    });

    const additionalRepos = [
      { fullName: "org/extra-repo", branch: "main" },
      { fullName: "org/another-repo", branch: "develop" },
    ];

    // First call: POST /artifacts → success
    // Second call: POST /documents/artifact-456/run-loop → 409 multiple_targets conflict
    const conflictError = new ApiError("Multiple targets", 409, undefined, {
      data: {
        error: "multiple_targets",
        message: "Multiple compute targets available",
        availableTargets: [
          { id: "target-1", machineName: "machine-1", status: "online" },
          { id: "target-2", machineName: "machine-2", status: "online" },
        ],
      },
    });

    mockApiClient.post
      .mockResolvedValueOnce(mockArtifact)
      .mockRejectedValueOnce(conflictError)
      .mockResolvedValueOnce({ loopId: "loop-789", status: "PENDING" });
    mockApiClient.get.mockResolvedValueOnce([
      makeComputeTargetWire("target-1"),
    ]);

    const { result } = renderHook(() => useCreateAndGenerateDocument(), {
      wrapper: createWrapper(),
    });

    // Trigger the initial mutation with additionalRepos
    act(() => {
      result.current.mutate({
        input: {
          title: "Test Plan",
          type: DocumentType.ImplementationPlan,
          content: "",
          projectId: "project-123",
        },
        additionalRepos,
      });
    });

    // Wait for multiTargetState to be populated from the 409 conflict
    await waitFor(() => {
      expect(result.current.multiTargetState).not.toBeNull();
    });

    expect(result.current.data?.status).toBe("pending_target_selection");
    expect(result.current.multiTargetState?.availableTargets).toHaveLength(2);

    // Simulate the user selecting a target — this triggers the retry POST
    await act(async () => {
      await result.current.selectTarget("target-1");
    });

    // The retry call is the third post call (index 2)
    const retryCallBody = mockApiClient.post.mock.calls[2][1];
    expect(retryCallBody).toMatchObject({
      command: RunLoopCommand.Plan,
      computeTargetId: "target-1",
      additionalRepos,
    });
  });

  test("includes additionalRepos in the initial run-loop POST body when provided", async () => {
    const mockArtifact = createMockDocument({
      id: "artifact-101",
      projectId: "project-123",
    });

    const additionalRepos = [
      { fullName: "org/extra-repo", branch: "main" },
      { fullName: "org/another-repo", branch: "develop" },
    ];

    // First call: POST /artifacts → success
    // Second call: POST /documents/artifact-101/run-loop → success (no conflict)
    mockApiClient.post
      .mockResolvedValueOnce(mockArtifact)
      .mockResolvedValueOnce({ loopId: "loop-001", status: "PENDING" });

    const { result } = renderHook(() => useCreateAndGenerateDocument(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.mutate({
        input: {
          title: "Test Plan",
          type: DocumentType.ImplementationPlan,
          content: "",
          projectId: "project-123",
        },
        additionalRepos,
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const runLoopCallBody = mockApiClient.post.mock.calls[1][1];
    expect(runLoopCallBody).toMatchObject({
      command: RunLoopCommand.Plan,
      additionalRepos,
    });
    expect(mockApiClient.post).toHaveBeenNthCalledWith(
      2,
      `/documents/${mockArtifact.id}/run-loop`,
      expect.objectContaining({ additionalRepos })
    );
  });

  test("rejects the mutation when post-create run-loop launch fails with an unhandled error", async () => {
    const mockArtifact = createMockDocument({
      id: "artifact-500",
      projectId: "project-123",
    });
    const launchError = new Error("launch failed");

    mockApiClient.post
      .mockResolvedValueOnce(mockArtifact)
      .mockRejectedValueOnce(launchError);

    const { result } = renderHook(() => useCreateAndGenerateDocument(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.mutate({
        input: {
          title: "Test Plan",
          type: DocumentType.ImplementationPlan,
          content: "",
          projectId: "project-123",
        },
      });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBe(launchError);
  });

  test("surfaces document creation errors even though launch errors are handled by the mutation", async () => {
    const createError = new Error("document create failed");
    mockApiClient.post.mockRejectedValueOnce(createError);

    const { result } = renderHook(() => useCreateAndGenerateDocument(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.mutate({
        input: {
          title: "Test Plan",
          type: DocumentType.ImplementationPlan,
          content: "",
          projectId: "project-123",
        },
      });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(mockToastError).toHaveBeenCalledWith("document create failed");
    expect(mockApiClient.post).toHaveBeenCalledOnce();
  });

  test("surfaces a toast when post-create run-loop launch fails with a backend mismatch", async () => {
    const mockArtifact = createMockDocument({
      id: "artifact-bm",
      projectId: "project-123",
    });
    const conflictError = new ApiError("Backend mismatch", 409, undefined, {
      data: {
        error: "backend_mismatch",
        message: "Resolved target differs from the artifact backend",
        originalComputeTargetId: "target-1",
        originalComputeTargetName: "machine-1",
        preferredComputeTargetId: "target-2",
        documentId: "artifact-bm",
      },
    });

    mockApiClient.post
      .mockResolvedValueOnce(mockArtifact)
      .mockRejectedValueOnce(conflictError);

    const { result } = renderHook(() => useCreateAndGenerateDocument(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.mutate({
        input: {
          title: "Test Plan",
          type: DocumentType.ImplementationPlan,
          content: "",
          projectId: "project-123",
        },
      });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(mockToastError).toHaveBeenCalledWith("Backend mismatch");
    expect(result.current.multiTargetState).toBeNull();
  });

  test("selectTarget keeps the target picker open when the retry launch fails", async () => {
    const mockArtifact = createMockDocument({
      id: "artifact-retry-fail",
      projectId: "project-123",
    });

    const conflictError = new ApiError("Multiple targets", 409, undefined, {
      data: {
        error: "multiple_targets",
        message: "Multiple compute targets available",
        availableTargets: [
          { id: "target-1", machineName: "machine-1", status: "online" },
          { id: "target-2", machineName: "machine-2", status: "online" },
        ],
      },
    });

    // create → success, run-loop → multiple_targets conflict, retry → failure
    mockApiClient.post
      .mockResolvedValueOnce(mockArtifact)
      .mockRejectedValueOnce(conflictError)
      .mockRejectedValueOnce(new Error("retry launch failed"));
    mockApiClient.get.mockResolvedValueOnce([
      makeComputeTargetWire("target-1"),
    ]);

    const { result } = renderHook(() => useCreateAndGenerateDocument(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.mutate({
        input: {
          title: "Test Plan",
          type: DocumentType.ImplementationPlan,
          content: "",
          projectId: "project-123",
        },
      });
    });

    await waitFor(() => {
      expect(result.current.multiTargetState).not.toBeNull();
    });

    await act(async () => {
      await result.current.selectTarget("target-1");
    });

    // Retry failed → state must remain so the user can re-pick rather than be
    // stranded with an orphaned document and a dismissed dialog.
    expect(result.current.multiTargetState).not.toBeNull();
    expect(result.current.multiTargetState?.availableTargets).toHaveLength(2);
    expect(mockToastError).toHaveBeenCalledWith("retry launch failed");
  });

  test("selectTarget preserves state and does not launch when compute target refresh fails", async () => {
    const mockArtifact = createMockDocument({
      id: "artifact-refresh-fail",
      projectId: "project-123",
    });
    const conflictError = new ApiError("Multiple targets", 409, undefined, {
      data: {
        error: "multiple_targets",
        message: "Multiple compute targets available",
        availableTargets: [
          { id: "target-1", machineName: "machine-1", status: "online" },
        ],
      },
    });

    mockApiClient.post
      .mockResolvedValueOnce(mockArtifact)
      .mockRejectedValueOnce(conflictError);
    mockApiClient.get.mockRejectedValueOnce(new Error("refresh failed"));

    const { result } = renderHook(() => useCreateAndGenerateDocument(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.mutate({
        input: {
          title: "Test Plan",
          type: DocumentType.ImplementationPlan,
          content: "",
          projectId: "project-123",
        },
      });
    });

    await waitFor(() => {
      expect(result.current.multiTargetState).not.toBeNull();
    });

    await act(async () => {
      await result.current.selectTarget("target-1");
    });

    expect(mockApiClient.get).toHaveBeenCalledWith("/compute-targets");
    expect(mockApiClient.post).toHaveBeenCalledTimes(2);
    expect(result.current.multiTargetState).not.toBeNull();
    expect(mockToastError).toHaveBeenCalledWith(
      "Failed to refresh compute targets before retrying."
    );
  });

  test("launches generated PRDs through a dedicated mutation with target and repo context", async () => {
    const mockArtifact = createMockDocument({
      id: "prd-123",
      projectId: "project-123",
      type: DocumentType.Prd,
    });
    const additionalRepos = [{ fullName: "org/extra", branch: "main" }];

    mockApiClient.post.mockResolvedValueOnce({
      loopId: "loop-prd",
      status: "PENDING",
    });
    mockApiClient.get.mockResolvedValueOnce([
      makeComputeTargetWire("target-1"),
    ]);

    const { result } = renderHook(() => useGeneratePrdLaunch(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.mutate({
        artifact: mockArtifact,
        additionalRepos,
        computeTargetId: "target-1",
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/documents/prd-123/run-loop",
      expect.objectContaining({
        command: RunLoopCommand.GeneratePrd,
        additionalRepos,
        computeTargetId: "target-1",
      })
    );
  });

  test("blocks Generate PRD selected-target launch before mutation when compute target refresh fails", async () => {
    const mockArtifact = createMockDocument({
      id: "prd-refresh-fail",
      projectId: "project-123",
      type: DocumentType.Prd,
    });

    mockApiClient.get.mockRejectedValueOnce(new Error("refresh failed"));

    const { result } = renderHook(() => useGeneratePrdLaunch(), {
      wrapper: createWrapper(),
    });

    await expect(
      result.current.mutateAsync({
        artifact: mockArtifact,
        computeTargetId: "target-1",
      })
    ).rejects.toThrow("Failed to refresh compute targets before retrying.");

    expect(mockApiClient.get).toHaveBeenCalledWith("/compute-targets");
    expect(mockToastError).toHaveBeenCalledWith(
      "Failed to refresh compute targets before retrying."
    );
    expect(mockApiClient.post).not.toHaveBeenCalled();
  });

  test("blocks Generate PRD selected-target launch before mutation when refreshed targets omit the selection", async () => {
    const mockArtifact = createMockDocument({
      id: "prd-missing-target",
      projectId: "project-123",
      type: DocumentType.Prd,
    });

    mockApiClient.get.mockResolvedValueOnce([
      makeComputeTargetWire("target-2"),
    ]);

    const { result } = renderHook(() => useGeneratePrdLaunch(), {
      wrapper: createWrapper(),
    });

    await expect(
      result.current.mutateAsync({
        artifact: mockArtifact,
        computeTargetId: "target-1",
      })
    ).rejects.toThrow(
      "Selected compute target is no longer available. Choose a target again."
    );

    expect(mockApiClient.get).toHaveBeenCalledWith("/compute-targets");
    expect(mockToastError).toHaveBeenCalledWith(
      "Selected compute target is no longer available. Choose a target again."
    );
    expect(mockApiClient.post).not.toHaveBeenCalled();
  });

  test("selectTarget retry omits additionalRepos when none were provided", async () => {
    const mockArtifact = createMockDocument({
      id: "artifact-789",
      projectId: "project-123",
    });

    const conflictError = new ApiError("Multiple targets", 409, undefined, {
      data: {
        error: "multiple_targets",
        message: "Multiple compute targets available",
        availableTargets: [
          { id: "target-1", machineName: "machine-1", status: "online" },
        ],
      },
    });

    mockApiClient.post
      .mockResolvedValueOnce(mockArtifact)
      .mockRejectedValueOnce(conflictError)
      .mockResolvedValueOnce({ loopId: "loop-999", status: "PENDING" });
    mockApiClient.get.mockResolvedValueOnce([
      makeComputeTargetWire("target-1"),
    ]);

    const { result } = renderHook(() => useCreateAndGenerateDocument(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.mutate({
        input: {
          title: "Test Plan",
          type: DocumentType.ImplementationPlan,
          content: "",
          projectId: "project-123",
        },
      });
    });

    await waitFor(() => {
      expect(result.current.multiTargetState).not.toBeNull();
    });

    await act(async () => {
      await result.current.selectTarget("target-1");
    });

    const retryCallBody = mockApiClient.post.mock.calls[2][1];
    expect(retryCallBody).not.toHaveProperty("additionalRepos");
    expect(retryCallBody).toMatchObject({
      command: RunLoopCommand.Plan,
      computeTargetId: "target-1",
    });
  });
});

describe("useGeneratePrdFromDocument", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("seeds a PRD from the Document then launches GENERATE_PRD against it", async () => {
    const seededPrd = createMockDocument({
      id: "prd-seeded",
      projectId: "project-9",
    });

    // 1. POST /documents/doc-1/generate-prd-from-doc → the seeded DRAFT PRD
    // 2. POST /documents/prd-seeded/run-loop → launch success
    mockApiClient.post
      .mockResolvedValueOnce(seededPrd)
      .mockResolvedValueOnce({ loopId: "loop-1", status: "PENDING" });

    const { result } = renderHook(() => useGeneratePrdFromDocument(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.mutate({
        documentId: "doc-1",
        projectId: "project-9",
        title: "From Doc",
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // First call seeds the PRD from the source Document + target project.
    expect(mockApiClient.post).toHaveBeenNthCalledWith(
      1,
      "/documents/doc-1/generate-prd-from-doc",
      { projectId: "project-9", title: "From Doc" }
    );

    // Second call launches the existing GENERATE_PRD engine against the new PRD.
    expect(mockApiClient.post).toHaveBeenNthCalledWith(
      2,
      "/documents/prd-seeded/run-loop",
      expect.objectContaining({ command: RunLoopCommand.GeneratePrd })
    );

    expect(result.current.data).toEqual({
      artifact: seededPrd,
      status: "launched",
    });
  });

  test("surfaces a generic launch failure so the seeded PRD is not silently stranded", async () => {
    const seededPrd = createMockDocument({
      id: "prd-seeded",
      projectId: "project-9",
    });
    const launchError = new Error("launch failed");

    // Seed succeeds, then the run-loop launch throws a non-conflict error.
    mockApiClient.post
      .mockResolvedValueOnce(seededPrd)
      .mockRejectedValueOnce(launchError);

    const { result } = renderHook(() => useGeneratePrdFromDocument(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.mutate({ documentId: "doc-1", projectId: "project-9" });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    // The seeded PRD already committed, so the failure must be toasted, not swallowed.
    expect(mockToastError).toHaveBeenCalledWith("launch failed");
  });

  test("does not launch a loop when the seed request fails", async () => {
    const seedError = new Error("seed failed");
    mockApiClient.post.mockRejectedValueOnce(seedError);

    const { result } = renderHook(() => useGeneratePrdFromDocument(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.mutate({ documentId: "doc-1", projectId: "project-9" });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    // Only the seed call was attempted; no run-loop launch was fired.
    expect(mockApiClient.post).toHaveBeenCalledTimes(1);
    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/documents/doc-1/generate-prd-from-doc",
      { projectId: "project-9" }
    );
  });

  test("on target conflict, selectTarget replays only the launch and never re-seeds a duplicate PRD", async () => {
    const seededPrd = createMockDocument({
      id: "prd-seeded",
      projectId: "project-9",
    });
    const conflictError = new ApiError("Multiple targets", 409, undefined, {
      data: {
        error: "multiple_targets",
        message: "Multiple compute targets available",
        availableTargets: [
          { id: "target-1", machineName: "machine-1", status: "online" },
        ],
      },
    });

    // 1. seed → committed DRAFT PRD
    // 2. run-loop launch → multiple_targets conflict
    // (get) refresh full compute-target snapshot including the selection
    // 3. run-loop replay against the SAME seeded PRD → success
    mockApiClient.post
      .mockResolvedValueOnce(seededPrd)
      .mockRejectedValueOnce(conflictError)
      .mockResolvedValueOnce({ loopId: "loop-1", status: "PENDING" });
    mockApiClient.get.mockResolvedValueOnce([
      makeComputeTargetWire("target-1"),
    ]);

    const { result } = renderHook(() => useGeneratePrdFromDocument(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.mutate({ documentId: "doc-1", projectId: "project-9" });
    });

    await waitFor(() => expect(result.current.multiTargetState).not.toBeNull());
    expect(result.current.multiTargetState?.pendingArtifact.id).toBe(
      "prd-seeded"
    );

    await act(async () => {
      await result.current.selectTarget("target-1");
    });

    // Exactly one seed POST across the whole flow — the replay is launch-only.
    const seedCalls = mockApiClient.post.mock.calls.filter(([path]) =>
      String(path).endsWith("/generate-prd-from-doc")
    );
    expect(seedCalls).toHaveLength(1);

    // The replay launch targets the already-seeded PRD.
    expect(mockApiClient.post).toHaveBeenNthCalledWith(
      3,
      "/documents/prd-seeded/run-loop",
      expect.objectContaining({
        command: RunLoopCommand.GeneratePrd,
        computeTargetId: "target-1",
      })
    );
    expect(result.current.multiTargetState).toBeNull();
  });
});

/**
 * ISS-5687 acceptance: "a dispatch that cannot broker surfaces an explicit,
 * honest error — never a silent no-op."
 *
 * Both mutations set `meta: { suppressDefaultErrorToast: true }` and their call
 * sites pass no `onError`, so the ONLY thing standing between a refused launch
 * and total silence is the trailing `toast.error` in `handleRunLoopResponse`.
 * Nothing pinned that, and deleting it would restore the silence the ticket was
 * filed about while every other test stayed green. These lock it — exactly
 * once, so a second call site cannot start double-reporting either.
 */
describe("launch failures are surfaced, never silently absorbed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("useCreateAndGenerateDocument toasts a generic run-loop failure", async () => {
    const mockArtifact = createMockDocument({ id: "plan-1" });
    mockApiClient.post
      .mockResolvedValueOnce(mockArtifact)
      .mockRejectedValueOnce(
        new ApiError("Compute target offline", 503, undefined, {
          data: { error: "offline" },
        })
      );

    const { result } = renderHook(() => useCreateAndGenerateDocument(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current
        .mutateAsync({
          input: {
            title: "Plan",
            type: DocumentType.ImplementationPlan,
            content: "",
          },
        })
        .catch(() => undefined);
    });

    await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1));
    expect(mockToastError).toHaveBeenCalledWith(
      expect.stringContaining("Compute target offline")
    );
  });

  test("useGeneratePrdLaunch toasts a generic run-loop failure", async () => {
    const mockArtifact = createMockDocument({ id: "prd-1" });
    mockApiClient.post.mockRejectedValueOnce(
      new ApiError("No AI harness available", 422, undefined, {
        data: { error: "no_harness" },
      })
    );

    const { result } = renderHook(() => useGeneratePrdLaunch(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current
        .mutateAsync({ artifact: mockArtifact })
        .catch(() => undefined);
    });

    await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1));
    expect(mockToastError).toHaveBeenCalledWith(
      expect.stringContaining("No AI harness available")
    );
  });

  /**
   * The 429 concurrent-loop-limit branch was the one hole left in that
   * guarantee. `handleRunLoopResponse` routed it through the OPTIONAL
   * `onRateLimited` and returned unconditionally — and no call site in this
   * file passes that callback, so hitting the limit produced nothing at all:
   * no toast, no error, no state change. Indistinguishable from a launch that
   * simply never happened, which is the exact silence ISS-5687 was filed about.
   * These pin the fallback for a 429 with no handler.
   */
  test("useCreateAndGenerateDocument toasts a 429 concurrent-loop refusal", async () => {
    const mockArtifact = createMockDocument({ id: "plan-429" });
    mockApiClient.post
      .mockResolvedValueOnce(mockArtifact)
      .mockRejectedValueOnce(
        new ApiError("Too many concurrent loops", 429, undefined, {
          data: { error: "rate_limited" },
        })
      );

    const { result } = renderHook(() => useCreateAndGenerateDocument(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current
        .mutateAsync({
          input: {
            title: "Plan",
            type: DocumentType.ImplementationPlan,
            content: "",
          },
        })
        .catch(() => undefined);
    });

    await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1));
    expect(mockToastError).toHaveBeenCalledWith(
      expect.stringContaining("Too many concurrent loops")
    );
  });

  test("useGeneratePrdLaunch toasts a 429 concurrent-loop refusal", async () => {
    const mockArtifact = createMockDocument({ id: "prd-429" });
    mockApiClient.post.mockRejectedValueOnce(
      new ApiError("Too many concurrent loops", 429, undefined, {
        data: { error: "rate_limited" },
      })
    );

    const { result } = renderHook(() => useGeneratePrdLaunch(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current
        .mutateAsync({ artifact: mockArtifact })
        .catch(() => undefined);
    });

    await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1));
    expect(mockToastError).toHaveBeenCalledWith(
      expect.stringContaining("Too many concurrent loops")
    );
  });

  test("a multiple-targets conflict opens the picker instead of toasting", async () => {
    const mockArtifact = createMockDocument({ id: "prd-2" });
    mockApiClient.post.mockRejectedValueOnce(
      new ApiError("Multiple targets", 409, undefined, {
        data: {
          error: "multiple_targets",
          message: "Multiple compute targets available",
          availableTargets: [
            { id: "target-1", machineName: "machine-1", status: "online" },
          ],
        },
      })
    );

    const { result } = renderHook(() => useGeneratePrdLaunch(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current
        .mutateAsync({ artifact: mockArtifact })
        .catch(() => undefined);
    });

    expect(mockToastError).not.toHaveBeenCalled();
  });
});

function makeComputeTargetWire(id: string) {
  return {
    id,
    organizationId: "org-1",
    userId: "user-1",
    machineName: "Test-MBP",
    platform: "darwin",
    capabilities: { [COMMAND_SIGNING_CAPABILITY_KEY]: false },
    supportedOperations: [],
    lastSeenAt: "2026-05-10T12:00:00.000Z",
    isOnline: true,
    isSharedWithOrg: false,
    serverCapabilities: { computeTargetSigning: false },
    selectedHarness: HarnessType.Claude,
    createdAt: "2026-05-10T12:00:00.000Z",
    updatedAt: "2026-05-10T12:00:00.000Z",
  };
}
