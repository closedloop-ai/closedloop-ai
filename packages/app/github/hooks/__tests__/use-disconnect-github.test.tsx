import { ApiError } from "@repo/app/shared/api/api-error";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { createWrapperWithClient } from "@repo/app/shared/test-utils";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDisconnectGitHub } from "../use-github-integration";

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

/**
 * Driven through the PRODUCTION `makeQueryClient()`, whose default
 * `mutations.onError` is live, so a second toast would be counted (ISS-11741).
 */
beforeEach(() => {
  vi.clearAllMocks();
});

describe("useDisconnectGitHub", () => {
  it("keeps the generic failure toast for a caller that passes no options", async () => {
    mockApiClient.delete.mockRejectedValueOnce(new ApiError("boom", 500));
    const { result } = renderHook(() => useDisconnectGitHub(), {
      wrapper: createWrapperWithClient(makeQueryClient({ gcTime: 0 })),
    });

    act(() => {
      result.current.mutate();
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockApiClient.delete).toHaveBeenCalledWith("/integrations/github");
    expect(mockToastError).toHaveBeenCalledOnce();
  });

  it("runs only the caller's onError when one is passed", async () => {
    mockApiClient.delete.mockRejectedValueOnce(new ApiError("boom", 500));
    const onError = vi.fn();
    const { result } = renderHook(() => useDisconnectGitHub({ onError }), {
      wrapper: createWrapperWithClient(makeQueryClient({ gcTime: 0 })),
    });

    act(() => {
      result.current.mutate();
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(onError).toHaveBeenCalledOnce();
    expect(mockToastError).not.toHaveBeenCalled();
  });
});
