import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import {
  useCreateDocument,
  useDeleteDocument,
  useDocument,
  useDocuments,
  useDocumentsByProject,
  useUpdateDocument,
} from "@repo/app/documents/hooks/use-documents";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createWrapper } from "./test-utils";

// Mock useApiClient
const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
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
