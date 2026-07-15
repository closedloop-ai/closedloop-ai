import {
  createTestQueryClient,
  createWrapper,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  catalogKeys,
  useArchiveCatalogItem,
  useCatalogItem,
  useCatalogItems,
  useConfirmUpload,
  useCreateCatalogItem,
  useUpdateCatalogItem,
  useUploadIntent,
} from "../use-catalog";

// Mock useApiClient — the catalog hooks call it directly (no data-source).
const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const item = {
  id: "item-1",
  organizationId: "org-1",
  targetKind: "plugin",
  source: "org_custom",
  name: "My Plugin",
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// catalogKeys
// ---------------------------------------------------------------------------

describe("catalogKeys", () => {
  it("all is the stable base key", () => {
    expect(catalogKeys.all).toEqual(["catalog"]);
  });

  it("list() is nested under the list namespace", () => {
    expect(catalogKeys.list()).toEqual(["catalog", "list"]);
  });

  it("detail(id) is unique per id and nested under details", () => {
    expect(catalogKeys.detail("item-1")).toEqual([
      "catalog",
      "detail",
      "item-1",
    ]);
    expect(catalogKeys.detail("item-1")).not.toEqual(
      catalogKeys.detail("item-2")
    );
  });
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

describe("useCatalogItems", () => {
  it("fetches the org catalog list (success state)", async () => {
    mockApiClient.get.mockResolvedValueOnce([item]);

    const { result } = renderHook(() => useCatalogItems(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([item]);
    expect(mockApiClient.get).toHaveBeenCalledWith("/catalog");
  });

  it("surfaces isError when the list request fails", async () => {
    mockApiClient.get.mockRejectedValueOnce(new Error("403"));

    const { result } = renderHook(() => useCatalogItems(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("useCatalogItem", () => {
  it("fetches a single item by id (success state)", async () => {
    mockApiClient.get.mockResolvedValueOnce(item);

    const { result } = renderHook(() => useCatalogItem("item-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(item);
    expect(mockApiClient.get).toHaveBeenCalledWith("/catalog/item-1");
  });

  it("is disabled for an empty id — never calls the API", () => {
    renderHook(() => useCatalogItem(""), { wrapper: createWrapper() });
    expect(mockApiClient.get).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

describe("useCreateCatalogItem", () => {
  it("POSTs to /catalog and invalidates the list on success", async () => {
    mockApiClient.post.mockResolvedValueOnce(item);
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useCreateCatalogItem(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    result.current.mutate({ targetKind: "plugin", name: "My Plugin" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiClient.post).toHaveBeenCalledWith("/catalog", {
      targetKind: "plugin",
      name: "My Plugin",
    });
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: catalogKeys.lists() })
    );
  });

  it("surfaces isError when the create fails", async () => {
    const err = new Error("403 forbidden");
    mockApiClient.post.mockRejectedValueOnce(err);

    const { result } = renderHook(() => useCreateCatalogItem(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({ targetKind: "plugin", name: "My Plugin" });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual(err);
  });
});

describe("useUpdateCatalogItem", () => {
  it("PATCHes /catalog/{id} and invalidates both detail and list", async () => {
    mockApiClient.patch.mockResolvedValueOnce(item);
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useUpdateCatalogItem(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    result.current.mutate({ id: "item-1", name: "Renamed" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiClient.patch).toHaveBeenCalledWith("/catalog/item-1", {
      name: "Renamed",
    });
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: catalogKeys.detail("item-1") })
    );
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: catalogKeys.lists() })
    );
  });
});

describe("useArchiveCatalogItem", () => {
  it("DELETEs /catalog/{id} and invalidates the list", async () => {
    mockApiClient.delete.mockResolvedValueOnce(item);
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useArchiveCatalogItem(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    result.current.mutate("item-1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiClient.delete).toHaveBeenCalledWith("/catalog/item-1");
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: catalogKeys.lists() })
    );
  });
});

describe("useUploadIntent", () => {
  it("POSTs to /catalog/upload-intent and returns the presigned URL", async () => {
    const intent = { presignedUrl: "https://s3/put", s3Key: "org/1/zip" };
    mockApiClient.post.mockResolvedValueOnce(intent);

    const { result } = renderHook(() => useUploadIntent(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({
      catalogItemId: "item-1",
      fileType: "zip",
      contentType: "application/zip",
      fileSizeBytes: 1024,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(intent);
    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/catalog/upload-intent",
      expect.objectContaining({ catalogItemId: "item-1", fileType: "zip" })
    );
  });
});

describe("useConfirmUpload", () => {
  it("POSTs to /catalog/confirm and invalidates detail + list", async () => {
    mockApiClient.post.mockResolvedValueOnce(item);
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useConfirmUpload(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    result.current.mutate({
      catalogItemId: "item-1",
      fileType: "zip",
      s3Key: "org/1/zip",
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/catalog/confirm",
      expect.objectContaining({ catalogItemId: "item-1", s3Key: "org/1/zip" })
    );
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: catalogKeys.detail("item-1") })
    );
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: catalogKeys.lists() })
    );
  });
});
