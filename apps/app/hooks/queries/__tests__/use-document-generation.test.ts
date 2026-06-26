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
