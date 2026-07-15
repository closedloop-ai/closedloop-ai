import { DocumentStatus } from "@repo/api/src/types/document";
import {
  useBatchDeleteDocuments,
  useBatchUpdateStatus,
} from "@repo/app/documents/hooks/use-documents";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
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

describe("useBatchUpdateStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("posts to /documents/batch-update-status with document IDs and status", async () => {
    const updatedIds = ["doc-1", "doc-2"];
    mockApiClient.post.mockResolvedValueOnce(updatedIds);

    const { result } = renderHook(() => useBatchUpdateStatus(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({
      documentIds: ["doc-1", "doc-2"],
      status: DocumentStatus.Draft,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/documents/batch-update-status",
      {
        documentIds: ["doc-1", "doc-2"],
        status: DocumentStatus.Draft,
      }
    );
    expect(result.current.data).toEqual(updatedIds);
  });

  test("transitions to error state when the API call fails", async () => {
    const error = new Error("batch update failed");
    mockApiClient.post.mockRejectedValueOnce(error);

    const { result } = renderHook(() => useBatchUpdateStatus(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({
      documentIds: ["doc-1"],
      status: DocumentStatus.Approved,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBe(error);
  });
});

describe("useBatchDeleteDocuments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("posts to /documents/batch-delete with document IDs", async () => {
    const responsePayload = {
      deletedIds: ["doc-1", "doc-2"],
      failedIds: [],
    };
    mockApiClient.post.mockResolvedValueOnce(responsePayload);

    const { result } = renderHook(() => useBatchDeleteDocuments(), {
      wrapper: createWrapper(),
    });

    result.current.mutate(["doc-1", "doc-2"]);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.post).toHaveBeenCalledWith("/documents/batch-delete", {
      documentIds: ["doc-1", "doc-2"],
    });
    expect(result.current.data).toEqual(responsePayload);
  });

  test("transitions to error state when the API call fails", async () => {
    const error = new Error("batch delete failed");
    mockApiClient.post.mockRejectedValueOnce(error);

    const { result } = renderHook(() => useBatchDeleteDocuments(), {
      wrapper: createWrapper(),
    });

    result.current.mutate(["doc-1"]);

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBe(error);
  });
});
