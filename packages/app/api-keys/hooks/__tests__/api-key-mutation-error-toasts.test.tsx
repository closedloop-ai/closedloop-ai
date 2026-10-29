import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { createWrapperWithClient } from "@repo/app/shared/test-utils";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useCreatePlatformApiKey,
  useRevokePlatformApiKey,
} from "../use-platform-api-keys";

const mockToastError = vi.hoisted(() => vi.fn());

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: mockToastError, success: vi.fn() },
}));

const mockApiClient = {
  delete: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
};

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const REJECTION = new Error("upstream failure");

/**
 * Each hook's failure toast belongs to its caller, so a caller that passes no
 * options gets no toast from the shared client's default `mutations.onError`
 * (ISS-11410). Driven through the PRODUCTION `makeQueryClient()`, whose default
 * handler is live.
 */
const HOOKS = [
  {
    name: "useCreatePlatformApiKey",
    run: () => {
      const { result } = renderHook(() => useCreatePlatformApiKey(), {
        wrapper: createWrapperWithClient(makeQueryClient()),
      });
      act(() => result.current.mutate({ name: "CI" }));
      return result;
    },
  },
  {
    name: "useRevokePlatformApiKey",
    run: () => {
      const { result } = renderHook(() => useRevokePlatformApiKey(), {
        wrapper: createWrapperWithClient(makeQueryClient()),
      });
      act(() => result.current.mutate("key-1"));
      return result;
    },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockApiClient.delete.mockRejectedValue(REJECTION);
  mockApiClient.post.mockRejectedValue(REJECTION);
  mockApiClient.put.mockRejectedValue(REJECTION);
});

describe("API key mutation hooks called without options", () => {
  it.each(HOOKS)("$name adds no toast of its own", async ({ run }) => {
    const result = run();

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockToastError).not.toHaveBeenCalled();
    expect(result.current.error).toBe(REJECTION);
  });
});

describe("API key mutation hooks called with a caller onError", () => {
  it("runs the caller's onError once per failed call and adds nothing else", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useRevokePlatformApiKey({ onError }), {
      wrapper: createWrapperWithClient(makeQueryClient()),
    });

    await act(async () => {
      await Promise.allSettled([
        result.current.mutateAsync("key-1"),
        result.current.mutateAsync("key-2"),
      ]);
    });

    expect(onError.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      [REJECTION, "key-1"],
      [REJECTION, "key-2"],
    ]);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("runs the caller's onError for a failure that settles after the caller unmounts", async () => {
    let rejectCreate: (reason: unknown) => void = () => undefined;
    mockApiClient.post.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectCreate = reject;
      })
    );
    const onError = vi.fn();
    const { result, unmount } = renderHook(
      () => useCreatePlatformApiKey({ onError }),
      { wrapper: createWrapperWithClient(makeQueryClient()) }
    );

    const settled = result.current
      .mutateAsync({ name: "CI" })
      .catch(() => undefined);
    unmount();
    rejectCreate(REJECTION);
    await settled;

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toBe(REJECTION);
  });
});
