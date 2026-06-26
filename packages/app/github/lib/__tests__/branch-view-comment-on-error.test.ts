import { BranchViewCommentWriteIdentityStatus } from "@repo/api/src/types/branch-view";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../shared/api/api-error";
import { branchViewCommentOnError } from "../branch-view-comment-identity-blocker";

const mockToastError = vi.hoisted(() => vi.fn());

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: mockToastError,
    success: vi.fn(),
    info: vi.fn(),
  },
}));

describe("branchViewCommentOnError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("suppresses the toast for identity-blocker errors (local prompt UI owns them)", () => {
    branchViewCommentOnError(
      new ApiError("Connect GitHub", 403, {
        details: {
          identityBlocker: {
            status: BranchViewCommentWriteIdentityStatus.Missing,
          },
        },
      })
    );

    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("toasts ordinary errors", () => {
    branchViewCommentOnError(new Error("network down"));
    expect(mockToastError).toHaveBeenCalledOnce();
  });

  it("toasts identity-blocker-shaped errors with an unrecognized status", () => {
    branchViewCommentOnError(
      new ApiError("Connect GitHub", 403, {
        details: { identityBlocker: { status: "SOMETHING_ELSE" } },
      })
    );

    expect(mockToastError).toHaveBeenCalledOnce();
  });
});
