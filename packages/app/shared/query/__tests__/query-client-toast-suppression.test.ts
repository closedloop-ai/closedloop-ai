/**
 * Unit tests for the generic mutation-error handling in the shared query
 * client (FEA-1510): the default handler toasts via the generic
 * `toastMutationError` primitive and honors the `suppressDefaultErrorToast`
 * meta opt-out. Domain-specific behavior (Branch View identity-blocker
 * suppression, the loops "View loop" action) is owned by each domain's own
 * mutation `onError` and tested in its slice — not here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/api-error";
import { makeQueryClient, toastMutationError } from "../query-client";

const mockToastError = vi.hoisted(() => vi.fn());

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: mockToastError,
    success: vi.fn(),
    info: vi.fn(),
  },
}));

describe("makeQueryClient default mutation onError", () => {
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

  it("suppresses the toast for the suppressDefaultErrorToast meta", async () => {
    const client = makeQueryClient();
    const mutation = client.getMutationCache().build(client, {
      mutationFn: () => Promise.reject(new Error("Suppressed failure")),
      meta: { suppressDefaultErrorToast: true },
    });

    await mutation.execute(undefined).catch(() => undefined);

    expect(mockToastError).not.toHaveBeenCalled();
  });
});

describe("toastMutationError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the friendly title and description for an error", () => {
    toastMutationError(
      new ApiError("Pre-commit hook failed", 500, {
        code: "PROCESS_FAILED",
        details: {
          action: "commit",
          category: "pre_commit_hook",
          hookType: "lint",
          stderrExcerpt: "eslint failed",
        },
      })
    );

    expect(mockToastError).toHaveBeenCalledWith("Pre-commit hook failed", {
      description:
        "Git refused the commit because a local pre-commit hook failed.",
    });
  });

  it("attaches an action when one is supplied", () => {
    const onClick = vi.fn();
    toastMutationError(new Error("boom"), { label: "View loop", onClick });

    const action = mockToastError.mock.calls.at(-1)?.[1]?.action;
    expect(action?.label).toBe("View loop");
    action?.onClick?.();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("omits the action key when none is supplied", () => {
    toastMutationError(new Error("boom"));
    expect(mockToastError.mock.calls.at(-1)?.[1]?.action).toBeUndefined();
  });
});
