/**
 * Unit tests for the global QueryClient mutations.onError toast suppression.
 *
 * Verifies that mutations with meta.suppressDefaultErrorToast = true
 * do NOT produce the default toast, while mutations without the flag
 * still toast normally.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-error";
import { makeQueryClient } from "@/lib/query-client";

const mockToastError = vi.hoisted(() => vi.fn());

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

  it("toasts for mutations without suppressDefaultErrorToast meta", async () => {
    const client = makeQueryClient();
    const mutation = client.getMutationCache().build(client, {
      mutationFn: () => Promise.reject(new Error("Test failure")),
    });

    await mutation.execute(undefined).catch(() => undefined);

    expect(mockToastError).toHaveBeenCalledOnce();
    expect(mockToastError).toHaveBeenCalledWith("Operation failed", {
      description:
        "The operation did not complete. Technical details are available for debugging.",
    });
  });

  it("does NOT toast for mutations with suppressDefaultErrorToast meta", async () => {
    const client = makeQueryClient();
    const mutation = client.getMutationCache().build(client, {
      mutationFn: () => Promise.reject(new Error("Suppressed failure")),
      meta: { suppressDefaultErrorToast: true },
    });

    await mutation.execute(undefined).catch(() => undefined);

    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("uses friendly git remediation for structured ApiError metadata", async () => {
    const client = makeQueryClient();
    const mutation = client.getMutationCache().build(client, {
      mutationFn: () =>
        Promise.reject(
          new ApiError("Pre-commit hook failed", 500, {
            code: "PROCESS_FAILED",
            details: {
              action: "commit",
              category: "pre_commit_hook",
              hookType: "lint",
              stderrExcerpt: "eslint failed",
            },
          })
        ),
    });

    await mutation.execute(undefined).catch(() => undefined);

    expect(mockToastError).toHaveBeenCalledWith("Pre-commit hook failed", {
      description:
        "Git refused the commit because a local pre-commit hook failed.",
    });
  });
});
