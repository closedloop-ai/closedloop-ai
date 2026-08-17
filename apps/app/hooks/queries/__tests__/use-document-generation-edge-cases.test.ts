import {
  COMMAND_SIGNING_CAPABILITY_KEY,
  HarnessType,
} from "@repo/api/src/types/compute-target";
import { DocumentType } from "@repo/api/src/types/document";
import { projectTreeKeys } from "@repo/app/projects/hooks/use-project-tree";
import { ApiError } from "@repo/app/shared/api/api-error";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  useCreateAndGenerateDocument,
  useGeneratePrdFromDocument,
  useGeneratePrdLaunch,
} from "../use-document-generation";
import {
  createTestQueryClient,
  createWrapper,
  createWrapperWithClient,
} from "./test-utils";

// Gap-fill sibling to use-document-generation.test.ts: branches the main file
// doesn't exercise (explicit/omitted/null computeTargetId variants, the
// project-tree invalidation guard, clearTargetSelection, the selectTarget
// no-op guard, backend-mismatch on the two hooks the main file doesn't cover
// it for, and useGeneratePrdLaunch's un-exercised resolve-on-conflict path).
// Split out rather than appended so the main file stays under the Biome
// 1000-line file-size ceiling.

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

describe("useCreateAndGenerateDocument edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("includes an explicit computeTargetId in the initial run-loop POST body", async () => {
    const mockArtifact = createMockDocument({
      id: "artifact-explicit-target",
      projectId: "project-123",
    });

    mockApiClient.post
      .mockResolvedValueOnce(mockArtifact)
      .mockResolvedValueOnce({ loopId: "loop-explicit", status: "PENDING" });

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
        computeTargetId: "target-explicit",
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const runLoopCallBody = mockApiClient.post.mock.calls[1][1];
    expect(runLoopCallBody).toMatchObject({
      computeTargetId: "target-explicit",
    });
  });

  test("skips the project-tree cache invalidation when the created artifact has no projectId", async () => {
    // createMockDocument defaults projectId to null — an org-level DOC create.
    const mockArtifact = createMockDocument({ id: "artifact-no-project" });

    mockApiClient.post
      .mockResolvedValueOnce(mockArtifact)
      .mockResolvedValueOnce({ loopId: "loop-np", status: "PENDING" });

    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useCreateAndGenerateDocument(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    act(() => {
      result.current.mutate({
        input: { title: "Org Doc", type: DocumentType.Doc, content: "" },
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const invalidatedProjectTree = invalidateSpy.mock.calls.some(([arg]) => {
      const queryKey = (arg as { queryKey?: unknown[] } | undefined)?.queryKey;
      return Array.isArray(queryKey) && queryKey[0] === projectTreeKeys.all[0];
    });
    expect(invalidatedProjectTree).toBe(false);
  });

  test("clearTargetSelection resets the pending multi-target state without launching a retry", async () => {
    const mockArtifact = createMockDocument({
      id: "artifact-clear",
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

    act(() => {
      result.current.clearTargetSelection();
    });

    expect(result.current.multiTargetState).toBeNull();
    // Only the create + failed run-loop calls happened — clearing must not
    // trigger a retry POST.
    expect(mockApiClient.post).toHaveBeenCalledTimes(2);
  });

  test("selectTarget is a no-op when there is no pending multi-target conflict", async () => {
    const { result } = renderHook(() => useCreateAndGenerateDocument(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.selectTarget("target-1");
    });

    expect(mockApiClient.post).not.toHaveBeenCalled();
    expect(mockApiClient.get).not.toHaveBeenCalled();
    expect(result.current.multiTargetState).toBeNull();
  });

  test("selectTarget surfaces the fallback message when the retry rejects with a non-Error value", async () => {
    const mockArtifact = createMockDocument({
      id: "artifact-nonerror-retry",
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
      .mockRejectedValueOnce("non-error rejection");
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

    expect(mockToastError).toHaveBeenCalledWith(
      "Failed to start plan generation"
    );
  });
});

describe("useGeneratePrdFromDocument edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("surfaces a toast and does not enter target-selection state on a backend mismatch", async () => {
    const seededPrd = createMockDocument({
      id: "prd-bm",
      projectId: "project-9",
    });
    const mismatchError = new ApiError("Backend mismatch", 409, undefined, {
      data: {
        error: "backend_mismatch",
        message: "Resolved target differs from the artifact backend",
        originalComputeTargetId: "target-1",
        originalComputeTargetName: "machine-1",
        preferredComputeTargetId: "target-2",
        documentId: "prd-bm",
      },
    });

    mockApiClient.post
      .mockResolvedValueOnce(seededPrd)
      .mockRejectedValueOnce(mismatchError);

    const { result } = renderHook(() => useGeneratePrdFromDocument(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.mutate({ documentId: "doc-1", projectId: "project-9" });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(mockToastError).toHaveBeenCalledWith("Backend mismatch");
    expect(result.current.multiTargetState).toBeNull();
  });

  test("selectTarget(null) launches with a null computeTargetId and skips the compute-target refresh", async () => {
    const seededPrd = createMockDocument({
      id: "prd-null-target",
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

    mockApiClient.post
      .mockResolvedValueOnce(seededPrd)
      .mockRejectedValueOnce(conflictError)
      .mockResolvedValueOnce({ loopId: "loop-cloud", status: "PENDING" });

    const { result } = renderHook(() => useGeneratePrdFromDocument(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.mutate({ documentId: "doc-1", projectId: "project-9" });
    });

    await waitFor(() => {
      expect(result.current.multiTargetState).not.toBeNull();
    });

    await act(async () => {
      await result.current.selectTarget(null);
    });

    // Cloud verdict (ISS-5171): no refresh GET, and the launch body carries
    // computeTargetId: null rather than falling back to a local machine.
    expect(mockApiClient.get).not.toHaveBeenCalled();
    expect(mockApiClient.post).toHaveBeenNthCalledWith(
      3,
      "/documents/prd-null-target/run-loop",
      expect.objectContaining({ computeTargetId: null })
    );
    expect(result.current.multiTargetState).toBeNull();
  });

  test("selectTarget is a no-op when there is no pending multi-target conflict", async () => {
    const { result } = renderHook(() => useGeneratePrdFromDocument(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.selectTarget("target-1");
    });

    expect(mockApiClient.post).not.toHaveBeenCalled();
    expect(mockApiClient.get).not.toHaveBeenCalled();
  });

  test("clearTargetSelection resets the pending multi-target state without launching a retry", async () => {
    const seededPrd = createMockDocument({
      id: "prd-clear",
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

    mockApiClient.post
      .mockResolvedValueOnce(seededPrd)
      .mockRejectedValueOnce(conflictError);

    const { result } = renderHook(() => useGeneratePrdFromDocument(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.mutate({ documentId: "doc-1", projectId: "project-9" });
    });

    await waitFor(() => {
      expect(result.current.multiTargetState).not.toBeNull();
    });

    act(() => {
      result.current.clearTargetSelection();
    });

    expect(result.current.multiTargetState).toBeNull();
    expect(mockApiClient.post).toHaveBeenCalledTimes(2);
  });
});

describe("useGeneratePrdLaunch edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("surfaces a toast on a backend mismatch instead of resolving to pending_target_selection", async () => {
    const mockArtifact = createMockDocument({
      id: "prd-launch-bm",
      projectId: "project-123",
      type: DocumentType.Prd,
    });
    const mismatchError = new ApiError("Backend mismatch", 409, undefined, {
      data: {
        error: "backend_mismatch",
        message: "Resolved target differs from the artifact backend",
        originalComputeTargetId: "target-1",
        originalComputeTargetName: "machine-1",
        preferredComputeTargetId: "target-2",
        documentId: "prd-launch-bm",
      },
    });

    mockApiClient.post.mockRejectedValueOnce(mismatchError);

    const { result } = renderHook(() => useGeneratePrdLaunch(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.mutate({ artifact: mockArtifact });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(mockToastError).toHaveBeenCalledWith("Backend mismatch");
  });

  test("resolves to pending_target_selection with the available targets and additionalRepos on a multiple-targets conflict", async () => {
    const mockArtifact = createMockDocument({
      id: "prd-launch-conflict",
      projectId: "project-123",
      type: DocumentType.Prd,
    });
    const additionalRepos = [{ fullName: "org/extra", branch: "main" }];
    const availableTargets = [
      { id: "target-1", machineName: "machine-1", status: "online" },
      { id: "target-2", machineName: "machine-2", status: "online" },
    ];
    const conflictError = new ApiError("Multiple targets", 409, undefined, {
      data: {
        error: "multiple_targets",
        message: "Multiple compute targets available",
        availableTargets,
      },
    });

    mockApiClient.post.mockRejectedValueOnce(conflictError);

    const { result } = renderHook(() => useGeneratePrdLaunch(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.mutate({ artifact: mockArtifact, additionalRepos });
    });

    // Unlike a generic launch failure, a multi-target conflict RESOLVES the
    // mutation (isSuccess), it does not reject it — the caller reads
    // `status: "pending_target_selection"` off `data` instead of catching.
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual({
      additionalRepos,
      artifact: mockArtifact,
      availableTargets,
      status: "pending_target_selection",
    });
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("omits computeTargetId from the run-loop body and skips the refresh call when none is provided", async () => {
    const mockArtifact = createMockDocument({
      id: "prd-launch-no-target",
      projectId: "project-123",
      type: DocumentType.Prd,
    });

    mockApiClient.post.mockResolvedValueOnce({
      loopId: "loop-no-target",
      status: "PENDING",
    });

    const { result } = renderHook(() => useGeneratePrdLaunch(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.mutate({ artifact: mockArtifact });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.get).not.toHaveBeenCalled();
    const runLoopCallBody = mockApiClient.post.mock.calls[0][1];
    expect(runLoopCallBody).not.toHaveProperty("computeTargetId");
  });

  test("includes a null computeTargetId without refreshing when explicitly cleared to run on Cloud", async () => {
    const mockArtifact = createMockDocument({
      id: "prd-launch-cloud",
      projectId: "project-123",
      type: DocumentType.Prd,
    });

    mockApiClient.post.mockResolvedValueOnce({
      loopId: "loop-cloud",
      status: "PENDING",
    });

    const { result } = renderHook(() => useGeneratePrdLaunch(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.mutate({ artifact: mockArtifact, computeTargetId: null });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.get).not.toHaveBeenCalled();
    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/documents/prd-launch-cloud/run-loop",
      expect.objectContaining({ computeTargetId: null })
    );
  });

  test("omits additionalRepos from the run-loop body when none were provided", async () => {
    const mockArtifact = createMockDocument({
      id: "prd-launch-no-repos",
      projectId: "project-123",
      type: DocumentType.Prd,
    });

    mockApiClient.post.mockResolvedValueOnce({
      loopId: "loop-no-repos",
      status: "PENDING",
    });

    const { result } = renderHook(() => useGeneratePrdLaunch(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.mutate({ artifact: mockArtifact });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const runLoopCallBody = mockApiClient.post.mock.calls[0][1];
    expect(runLoopCallBody).not.toHaveProperty("additionalRepos");
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
