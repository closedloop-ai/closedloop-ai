import { LinkType } from "@repo/api/src/types/artifact";
import { ApiError } from "@repo/app/shared/api/api-error";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { createWrapperWithClient } from "@repo/app/shared/test-utils";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCreateArtifactLink } from "../use-artifact-links";
import { useDeleteAttachment } from "../use-attachments";

const { mockApiClient, mockToastError } = vi.hoisted(() => ({
  mockApiClient: { delete: vi.fn(), get: vi.fn(), post: vi.fn() },
  mockToastError: vi.fn(),
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: mockToastError, success: vi.fn() },
}));

const LINK_INPUT = {
  sourceId: "doc-1",
  targetId: "issue-1",
  linkType: LinkType.Produces,
};

/**
 * ISS-11741 gave these hooks an opt-in for the one surface that owns its
 * failure message. Every other caller passes nothing and must keep the shared
 * client's generic toast, so each hook is driven through the PRODUCTION
 * `makeQueryClient()`, whose default `mutations.onError` is live.
 */
beforeEach(() => {
  vi.clearAllMocks();
});

describe("useCreateArtifactLink", () => {
  it("keeps the generic failure toast for a caller that passes no options", async () => {
    mockApiClient.post.mockRejectedValueOnce(new ApiError("boom", 500));
    const { result } = renderHook(() => useCreateArtifactLink(), {
      wrapper: createWrapperWithClient(makeQueryClient({ gcTime: 0 })),
    });

    act(() => {
      result.current.mutate(LINK_INPUT);
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockToastError).toHaveBeenCalledOnce();
  });

  it("runs only the caller's onError when one is passed", async () => {
    mockApiClient.post.mockRejectedValueOnce(new ApiError("boom", 500));
    const onError = vi.fn();
    const { result } = renderHook(() => useCreateArtifactLink({ onError }), {
      wrapper: createWrapperWithClient(makeQueryClient({ gcTime: 0 })),
    });

    act(() => {
      result.current.mutate(LINK_INPUT);
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[1]).toEqual(LINK_INPUT);
    expect(mockToastError).not.toHaveBeenCalled();
  });
});

describe("useDeleteAttachment", () => {
  it("keeps the generic failure toast for a caller that passes no options", async () => {
    mockApiClient.delete.mockRejectedValueOnce(new ApiError("boom", 500));
    const { result } = renderHook(() => useDeleteAttachment("document-1"), {
      wrapper: createWrapperWithClient(makeQueryClient({ gcTime: 0 })),
    });

    act(() => {
      result.current.mutate("attachment-1");
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockApiClient.delete).toHaveBeenCalledWith(
      "/documents/document-1/attachments/attachment-1"
    );
    expect(mockToastError).toHaveBeenCalledOnce();
  });

  it("shows no toast when the caller opts out of the default", async () => {
    mockApiClient.delete.mockRejectedValueOnce(new ApiError("boom", 500));
    const { result } = renderHook(
      () =>
        useDeleteAttachment("document-1", { suppressDefaultErrorToast: true }),
      { wrapper: createWrapperWithClient(makeQueryClient({ gcTime: 0 })) }
    );

    act(() => {
      result.current.mutate("attachment-1");
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockToastError).not.toHaveBeenCalled();
  });
});
