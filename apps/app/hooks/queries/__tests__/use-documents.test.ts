import { DocumentType } from "@repo/api/src/types/document";
import { RunLoopCommand } from "@repo/api/src/types/loop";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createMockDocument } from "@/__tests__/fixtures/documents";
import { ApiError } from "@/lib/api-error";
import {
  documentKeys,
  useCreateAndGenerateDocument,
  useCreateDocument,
  useDeleteDocument,
  useDocument,
  useDocuments,
  useDocumentsByProject,
  useUpdateDocument,
} from "../use-documents";
import { createWrapper } from "./test-utils";

// Mock useApiClient
const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@/hooks/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

vi.mock("@/lib/engineer/local-gateway-api-namespace", () => ({
  resolveDesktopApiNamespaceHint: vi.fn().mockResolvedValue(undefined),
}));

describe("Artifact Query Hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("useDocuments", () => {
    test("fetches artifacts with search params", async () => {
      const mockArtifacts = [createMockDocument({ id: "1", type: "PRD" })];

      mockApiClient.get.mockResolvedValueOnce(mockArtifacts);

      const { result } = renderHook(() => useDocuments({ type: "PRD" }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApiClient.get).toHaveBeenCalledWith("/documents?type=PRD");
      expect(result.current.data).toEqual(mockArtifacts);
    });

    test("uses correct query key", () => {
      const searchParams = { type: "PRD" as const };
      const expectedKey = documentKeys.list(searchParams);

      renderHook(() => useDocuments(searchParams), {
        wrapper: createWrapper(),
      });

      expect(expectedKey).toEqual(["documents", "list", searchParams]);
    });
  });

  describe("useDocumentsByProject", () => {
    test("fetches artifacts by project ID", async () => {
      const mockArtifacts = [
        createMockDocument({ id: "1", projectId: "project-123" }),
      ];

      mockApiClient.get.mockResolvedValueOnce(mockArtifacts);

      const { result } = renderHook(
        () => useDocumentsByProject("project-123"),
        { wrapper: createWrapper() }
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApiClient.get).toHaveBeenCalledWith(
        "/documents?projectId=project-123"
      );
      expect(result.current.data).toEqual(mockArtifacts);
    });
  });

  describe("useDocument", () => {
    test("fetches single artifact by ID", async () => {
      const mockArtifact = createMockDocument({ id: "artifact-123" });

      mockApiClient.get.mockResolvedValueOnce(mockArtifact);

      const { result } = renderHook(() => useDocument("artifact-123"), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApiClient.get).toHaveBeenCalledWith("/documents/artifact-123");
      expect(result.current.data).toEqual(mockArtifact);
    });

    test("is disabled when id is empty", () => {
      const { result } = renderHook(() => useDocument(""), {
        wrapper: createWrapper(),
      });

      expect(result.current.fetchStatus).toBe("idle");
      expect(mockApiClient.get).not.toHaveBeenCalled();
    });

    test("uses correct query key", () => {
      const documentId = "artifact-123";
      const expectedKey = documentKeys.detail(documentId);

      renderHook(() => useDocument(documentId), { wrapper: createWrapper() });

      expect(expectedKey).toEqual(["documents", "detail", documentId]);
    });
  });
});

describe("Artifact Mutation Hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("useCreateDocument", () => {
    test("creates artifact and invalidates list cache", async () => {
      const mockArtifact = {
        id: "new-artifact",
        title: "New PRD",
        type: "PRD",
      };

      mockApiClient.post.mockResolvedValueOnce(mockArtifact);

      const { result } = renderHook(() => useCreateDocument(), {
        wrapper: createWrapper(),
      });

      result.current.mutate({
        title: "New PRD",
        type: "PRD",
        content: "Content here",
        projectId: "01935b3e-0000-7000-8000-000000000001",
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApiClient.post).toHaveBeenCalledWith("/documents", {
        title: "New PRD",
        type: "PRD",
        content: "Content here",
        projectId: "01935b3e-0000-7000-8000-000000000001",
      });
      expect(result.current.data).toEqual(mockArtifact);
    });

    test("handles creation error", async () => {
      const mockError = new Error("Failed to create");
      mockApiClient.post.mockRejectedValueOnce(mockError);

      const { result } = renderHook(() => useCreateDocument(), {
        wrapper: createWrapper(),
      });

      result.current.mutate({
        title: "New PRD",
        type: "PRD",
        content: "Content",
        projectId: "01935b3e-0000-7000-8000-000000000001",
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toEqual(mockError);
    });
  });

  describe("useUpdateDocument", () => {
    test("updates artifact and invalidates detail cache", async () => {
      const mockUpdated = {
        id: "artifact-123",
        title: "Updated Title",
      };

      mockApiClient.put.mockResolvedValueOnce(mockUpdated);

      const { result } = renderHook(() => useUpdateDocument(), {
        wrapper: createWrapper(),
      });

      result.current.mutate({
        id: "artifact-123",
        title: "Updated Title",
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApiClient.put).toHaveBeenCalledWith(
        "/documents/artifact-123",
        {
          title: "Updated Title",
        }
      );
      expect(result.current.data).toEqual(mockUpdated);
    });

    test("separates id from body in API call", async () => {
      mockApiClient.put.mockResolvedValueOnce({});

      const { result } = renderHook(() => useUpdateDocument(), {
        wrapper: createWrapper(),
      });

      result.current.mutate({
        id: "artifact-123",
        title: "New Title",
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      // Verify id is in URL, not body
      expect(mockApiClient.put).toHaveBeenCalledWith(
        "/documents/artifact-123",
        {
          title: "New Title",
        }
      );
    });
  });

  describe("useDeleteDocument", () => {
    test("deletes artifact and invalidates all cache", async () => {
      mockApiClient.delete.mockResolvedValueOnce({ deleted: true });

      const { result } = renderHook(() => useDeleteDocument(), {
        wrapper: createWrapper(),
      });

      result.current.mutate("artifact-123");

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApiClient.delete).toHaveBeenCalledWith(
        "/documents/artifact-123"
      );
      expect(result.current.data).toEqual({ deleted: true });
    });
  });
});

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
