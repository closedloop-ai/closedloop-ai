import { LONG_RUNNING_API_TIMEOUT_MS } from "@repo/api/src/types/long-running-api-timeout";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useDisconnectGoogle,
  useImportGoogleDocs,
} from "../use-google-integration";

const mockToastError = vi.hoisted(() => vi.fn());

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: mockToastError,
    info: vi.fn(),
    success: vi.fn(),
  },
}));

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
const DISCONNECT_REJECTION = "Google disconnect failed upstream";

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

  // ISS-11741: the import modal passes its own `onError`; a caller that passes
  // nothing keeps the shared client's generic toast.
  it("keeps the generic failure toast for a caller that passes no options", async () => {
    mockApiClient.post.mockRejectedValueOnce(new Error("import failed"));
    const { result } = renderHook(() => useImportGoogleDocs(), {
      wrapper: createWrapperWithClient(makeQueryClient({ gcTime: 0 })),
    });

    act(() => {
      result.current.mutate(IMPORT_INPUT);
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockToastError).toHaveBeenCalledOnce();
  });

  it("runs only the caller's onError when one is passed", async () => {
    mockApiClient.post.mockRejectedValueOnce(new Error("import failed"));
    const onError = vi.fn();
    const { result } = renderHook(() => useImportGoogleDocs({ onError }), {
      wrapper: createWrapperWithClient(makeQueryClient({ gcTime: 0 })),
    });

    act(() => {
      result.current.mutate(IMPORT_INPUT);
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(onError).toHaveBeenCalledOnce();
    expect(mockToastError).not.toHaveBeenCalled();
  });
});

/**
 * ISS-10316: `GoogleDriveCard` toasts every failed disconnect itself, so the
 * hook opts out of the shared client's default toast. Driven through the
 * PRODUCTION `makeQueryClient()`, whose default `mutations.onError` is live —
 * `createTestQueryClient()` has none, and a no-toast assertion against it would
 * pass for a hook that never set the flag. The control case below proves the
 * default handler toasts on this same client and mock.
 */
describe("useDisconnectGoogle", () => {
  it("leaves the failure toast to the card instead of adding a second one", async () => {
    mockApiClient.delete.mockRejectedValueOnce(new Error(DISCONNECT_REJECTION));
    const queryClient = makeQueryClient();

    const { result } = renderHook(() => useDisconnectGoogle(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    act(() => {
      result.current.mutate();
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockApiClient.delete).toHaveBeenCalledWith("/integrations/google");
    expect(mockToastError).not.toHaveBeenCalled();
    // Suppressing the toast must not swallow the rejection the card catches.
    expect((result.current.error as Error).message).toBe(DISCONNECT_REJECTION);
  });

  it("control: the same client toasts a rejected mutation that has not set the flag", async () => {
    const client = makeQueryClient();
    const mutation = client.getMutationCache().build(client, {
      mutationFn: () => Promise.reject(new Error(DISCONNECT_REJECTION)),
    });

    await mutation.execute(undefined).catch(() => undefined);

    expect(mockToastError).toHaveBeenCalledOnce();
  });
});
