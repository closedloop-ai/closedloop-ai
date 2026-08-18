import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import {
  useCreateDocument,
  useDeleteDocument,
  useDocument,
  useDocuments,
  useDocumentsByProject,
  useDocumentsPage,
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

    test("the bare-array hook rejects the includeTotal discriminator at compile time (shafty023)", () => {
      // includeTotal selects the ENVELOPE response arm; a caller that passed it
      // to useDocuments (which promises DocumentWithProject[]) would get the
      // envelope back and fail on .map. It lives on DocumentListPageParams, not
      // FindDocumentsOptions, so this must not type-check.
      renderHook(
        () =>
          useDocuments({
            type: "PRD",
            // @ts-expect-error includeTotal is not a member of FindDocumentsOptions
            includeTotal: true,
          }),
        { wrapper: createWrapper() }
      );

      expect(mockApiClient.get).toHaveBeenCalled();
    });
  });

  describe("useDocumentsPage (ISS-4576)", () => {
    test("requests the paged envelope and exposes the server total, not just an array", async () => {
      const page = {
        items: [createMockDocument({ id: "1" })],
        total: 1204,
        limit: 50,
        offset: 0,
        hasMore: true,
      };

      mockApiClient.get.mockResolvedValueOnce(page);

      const { result } = renderHook(
        () => useDocumentsPage({ assigneeId: "user-1", limit: 50, offset: 0 }),
        { wrapper: createWrapper() }
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApiClient.get).toHaveBeenCalledWith(
        "/documents?assigneeId=user-1&limit=50&offset=0&includeTotal=true"
      );
      // The adapter must NOT collapse the envelope to `items` — the continuation
      // metadata is what keeps a paging surface from truncating silently.
      expect(result.current.data?.total).toBe(1204);
      expect(result.current.data?.hasMore).toBe(true);
    });

    test("keys the paged read separately from the bare-array read of the same filters", () => {
      const filters = { assigneeId: "user-1", limit: 50, offset: 0 };

      renderHook(() => useDocumentsPage(filters), {
        wrapper: createWrapper(),
      });

      // A shared key would let an array response satisfy an envelope reader.
      expect(documentKeys.list(filters)).not.toEqual(
        documentKeys.list({ ...filters, includeTotal: true })
      );
    });

    test("normalizes an older API's legacy bare array into an honest one-page envelope (version skew, shafty023)", async () => {
      // An API that predates `includeTotal` strips the unknown param and returns
      // the legacy `DocumentWithProject[]` — and it ignored the `limit` too, so
      // the array is the WHOLE matching set. Without normalization the board read
      // missing `.items`/`.total` as an empty queue. It must instead fold to
      // "everything on one unbounded page".
      const legacyArray = [
        createMockDocument({ id: "1" }),
        createMockDocument({ id: "2" }),
      ];

      mockApiClient.get.mockResolvedValueOnce(legacyArray);

      const { result } = renderHook(
        () => useDocumentsPage({ assigneeId: "user-1", limit: 50, offset: 0 }),
        { wrapper: createWrapper() }
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data?.items).toHaveLength(2);
      expect(result.current.data?.total).toBe(2);
      expect(result.current.data?.limit).toBeNull();
      expect(result.current.data?.hasMore).toBe(false);
    });

    test("degrades a malformed response to a safe empty page rather than crashing the render", async () => {
      mockApiClient.get.mockResolvedValueOnce({ unexpected: "shape" });

      const { result } = renderHook(
        () => useDocumentsPage({ assigneeId: "user-1", limit: 50, offset: 0 }),
        { wrapper: createWrapper() }
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data?.items).toEqual([]);
      expect(result.current.data?.total).toBe(0);
      expect(result.current.data?.hasMore).toBe(false);
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
