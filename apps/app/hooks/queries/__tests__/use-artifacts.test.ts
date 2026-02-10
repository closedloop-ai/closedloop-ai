import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createMockArtifact } from "@/__tests__/fixtures/artifacts";
import {
  artifactKeys,
  useArtifact,
  useArtifacts,
  useArtifactsByProject,
  useArtifactsBySubtype,
  useCreateArtifact,
  useCreateNewVersion,
  useDeleteArtifact,
  useUpdateArtifact,
} from "../use-artifacts";
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

describe("Artifact Query Hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("useArtifacts", () => {
    test("fetches artifacts with search params", async () => {
      const mockArtifacts = [createMockArtifact({ id: "1", subtype: "PRD" })];

      mockApiClient.get.mockResolvedValueOnce(mockArtifacts);

      const { result } = renderHook(
        () => useArtifacts({ subtype: "PRD", latestOnly: true }),
        { wrapper: createWrapper() }
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApiClient.get).toHaveBeenCalledWith(
        "/artifacts?subtype=PRD&latestOnly=true"
      );
      expect(result.current.data).toEqual(mockArtifacts);
    });

    test("uses correct query key", () => {
      const searchParams = { subtype: "PRD" as const, latestOnly: true };
      const expectedKey = artifactKeys.list(searchParams);

      renderHook(() => useArtifacts(searchParams), {
        wrapper: createWrapper(),
      });

      expect(expectedKey).toEqual(["artifacts", "list", searchParams]);
    });
  });

  describe("useArtifactsBySubtype", () => {
    test("fetches artifacts by subtype with latestOnly=true", async () => {
      const mockArtifacts = [createMockArtifact({ id: "1", subtype: "PRD" })];

      mockApiClient.get.mockResolvedValueOnce(mockArtifacts);

      const { result } = renderHook(() => useArtifactsBySubtype("PRD", true), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApiClient.get).toHaveBeenCalledWith(
        "/artifacts?subtype=PRD&latestOnly=true"
      );
      expect(result.current.data).toEqual(mockArtifacts);
    });

    test("fetches artifacts by subtype with latestOnly=false", async () => {
      mockApiClient.get.mockResolvedValueOnce([]);

      const { result } = renderHook(
        () => useArtifactsBySubtype("IMPLEMENTATION_PLAN", false),
        { wrapper: createWrapper() }
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApiClient.get).toHaveBeenCalledWith(
        "/artifacts?subtype=IMPLEMENTATION_PLAN&latestOnly=false"
      );
    });
  });

  describe("useArtifactsByProject", () => {
    test("fetches artifacts by project ID", async () => {
      const mockArtifacts = [
        createMockArtifact({ id: "1", projectId: "project-123" }),
      ];

      mockApiClient.get.mockResolvedValueOnce(mockArtifacts);

      const { result } = renderHook(
        () => useArtifactsByProject("project-123", true),
        { wrapper: createWrapper() }
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApiClient.get).toHaveBeenCalledWith(
        "/artifacts?projectId=project-123&latestOnly=true"
      );
      expect(result.current.data).toEqual(mockArtifacts);
    });
  });

  describe("useArtifact", () => {
    test("fetches single artifact by ID", async () => {
      const mockArtifact = createMockArtifact({ id: "artifact-123" });

      mockApiClient.get.mockResolvedValueOnce(mockArtifact);

      const { result } = renderHook(() => useArtifact("artifact-123"), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApiClient.get).toHaveBeenCalledWith("/artifacts/artifact-123");
      expect(result.current.data).toEqual(mockArtifact);
    });

    test("is disabled when id is empty", () => {
      const { result } = renderHook(() => useArtifact(""), {
        wrapper: createWrapper(),
      });

      expect(result.current.fetchStatus).toBe("idle");
      expect(mockApiClient.get).not.toHaveBeenCalled();
    });

    test("uses correct query key", () => {
      const artifactId = "artifact-123";
      const expectedKey = artifactKeys.detail(artifactId);

      renderHook(() => useArtifact(artifactId), { wrapper: createWrapper() });

      expect(expectedKey).toEqual(["artifacts", "detail", artifactId]);
    });
  });
});

describe("Artifact Mutation Hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("useCreateArtifact", () => {
    test("creates artifact and invalidates list cache", async () => {
      const mockArtifact = {
        id: "new-artifact",
        title: "New PRD",
        subtype: "PRD",
      };

      mockApiClient.post.mockResolvedValueOnce(mockArtifact);

      const { result } = renderHook(() => useCreateArtifact(), {
        wrapper: createWrapper(),
      });

      result.current.mutate({
        title: "New PRD",
        subtype: "PRD",
        content: "Content here",
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApiClient.post).toHaveBeenCalledWith("/artifacts", {
        title: "New PRD",
        subtype: "PRD",
        content: "Content here",
      });
      expect(result.current.data).toEqual(mockArtifact);
    });

    test("handles creation error", async () => {
      const mockError = new Error("Failed to create");
      mockApiClient.post.mockRejectedValueOnce(mockError);

      const { result } = renderHook(() => useCreateArtifact(), {
        wrapper: createWrapper(),
      });

      result.current.mutate({
        title: "New PRD",
        subtype: "PRD",
        content: "Content",
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toEqual(mockError);
    });
  });

  describe("useUpdateArtifact", () => {
    test("updates artifact and invalidates detail cache", async () => {
      const mockUpdated = {
        id: "artifact-123",
        title: "Updated Title",
      };

      mockApiClient.put.mockResolvedValueOnce(mockUpdated);

      const { result } = renderHook(() => useUpdateArtifact(), {
        wrapper: createWrapper(),
      });

      result.current.mutate({
        id: "artifact-123",
        title: "Updated Title",
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApiClient.put).toHaveBeenCalledWith(
        "/artifacts/artifact-123",
        {
          title: "Updated Title",
        }
      );
      expect(result.current.data).toEqual(mockUpdated);
    });

    test("separates id from body in API call", async () => {
      mockApiClient.put.mockResolvedValueOnce({});

      const { result } = renderHook(() => useUpdateArtifact(), {
        wrapper: createWrapper(),
      });

      result.current.mutate({
        id: "artifact-123",
        title: "New Title",
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      // Verify id is in URL, not body
      expect(mockApiClient.put).toHaveBeenCalledWith(
        "/artifacts/artifact-123",
        {
          title: "New Title",
        }
      );
    });
  });

  describe("useDeleteArtifact", () => {
    test("deletes artifact and invalidates all cache", async () => {
      mockApiClient.delete.mockResolvedValueOnce({ deleted: true });

      const { result } = renderHook(() => useDeleteArtifact(), {
        wrapper: createWrapper(),
      });

      result.current.mutate("artifact-123");

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApiClient.delete).toHaveBeenCalledWith(
        "/artifacts/artifact-123"
      );
      expect(result.current.data).toEqual({ deleted: true });
    });
  });

  describe("useCreateNewVersion", () => {
    test("creates new version and invalidates detail and versions cache", async () => {
      const mockVersion = {
        id: "artifact-123",
        version: 2,
        content: "New version content",
      };

      mockApiClient.post.mockResolvedValueOnce(mockVersion);

      const { result } = renderHook(() => useCreateNewVersion(), {
        wrapper: createWrapper(),
      });

      result.current.mutate({
        id: "artifact-123",
        content: "New version content",
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApiClient.post).toHaveBeenCalledWith(
        "/artifacts/artifact-123/new-version",
        { content: "New version content" }
      );
      expect(result.current.data).toEqual(mockVersion);
    });
  });
});
