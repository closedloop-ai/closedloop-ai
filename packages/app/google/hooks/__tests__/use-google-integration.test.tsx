import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LONG_RUNNING_API_TIMEOUT_MS } from "../../../shared/api/api-timeout";
import { useImportGoogleDocs } from "../use-google-integration";

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const DOCUMENTS_QUERY_KEY = ["documents"];
const IMPORT_INPUT = { folderId: "folder-1", projectId: "project-1" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useImportGoogleDocs", () => {
  it("POSTs the import under the long-running deadline and invalidates documents on success", async () => {
    mockApiClient.post.mockResolvedValueOnce({
      importedCount: 2,
      totalDocsInFolder: 2,
      artifacts: [],
    });
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useImportGoogleDocs(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    result.current.mutate(IMPORT_INPUT);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/integrations/google/import",
      IMPORT_INPUT,
      { timeoutMs: LONG_RUNNING_API_TIMEOUT_MS }
    );
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: DOCUMENTS_QUERY_KEY })
    );
  });

  // ISS-5013: the abandon path. Before the client deadline existed this request
  // simply hung, so a rejection was unreachable; now it can reject at
  // LONG_RUNNING_API_TIMEOUT_MS with documents already created server-side. On
  // `onSuccess`-only invalidation the list would keep asserting its pre-import
  // population. This test fails if the hook goes back to `onSuccess`.
  it("still invalidates documents when the import is abandoned at the deadline", async () => {
    mockApiClient.post.mockRejectedValueOnce(new Error("timed out"));
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useImportGoogleDocs(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    result.current.mutate(IMPORT_INPUT);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: DOCUMENTS_QUERY_KEY })
    );
  });
});
