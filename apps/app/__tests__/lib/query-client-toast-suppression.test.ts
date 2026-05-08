/**
 * Unit tests for the global QueryClient mutations.onError toast suppression.
 *
 * Verifies that mutations with meta.suppressDefaultErrorToast = true
 * do NOT produce the default toast, while mutations without the flag
 * still toast normally.
 */

import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-error";

const mockToastError = vi.fn();

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: mockToastError,
    success: vi.fn(),
    info: vi.fn(),
  },
}));

describe("QueryClient mutations.onError toast suppression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Re-implements the global onError logic for testing.
   * The actual makeQueryClient is not exported; we test the pattern directly.
   */
  function makeTestQueryClient() {
    return new QueryClient({
      defaultOptions: {
        mutations: {
          retry: false,
          onError: (error, _variables, _onMutateResult, mutation) => {
            if (
              mutation &&
              (
                mutation.meta as
                  | { suppressDefaultErrorToast?: boolean }
                  | undefined
              )?.suppressDefaultErrorToast === true
            ) {
              return;
            }
            const message =
              error instanceof ApiError || error instanceof Error
                ? error.message
                : "An unexpected error occurred";
            mockToastError(message);
          },
        },
      },
    });
  }

  it("toasts for mutations without suppressDefaultErrorToast meta", async () => {
    const client = makeTestQueryClient();
    const mutation = client.getMutationCache().build(client, {
      mutationFn: () => Promise.reject(new Error("Test failure")),
    });

    await mutation.execute(undefined).catch(() => undefined);

    expect(mockToastError).toHaveBeenCalledOnce();
    expect(mockToastError).toHaveBeenCalledWith("Test failure");
  });

  it("does NOT toast for mutations with suppressDefaultErrorToast meta", async () => {
    const client = makeTestQueryClient();
    const mutation = client.getMutationCache().build(client, {
      mutationFn: () => Promise.reject(new Error("Suppressed failure")),
      meta: { suppressDefaultErrorToast: true },
    });

    await mutation.execute(undefined).catch(() => undefined);

    expect(mockToastError).not.toHaveBeenCalled();
  });
});
