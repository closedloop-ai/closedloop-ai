import { BranchViewFileDiffErrorCode } from "@repo/api/src/types/branch-view";
import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../../shared/api/api-error";
import { parseBranchViewFileDiffAccessDenial } from "../branch-view-file-diff-access";

function accessDeniedError(accessDenial?: string) {
  return new ApiError("Forbidden", 403, {
    code: BranchViewFileDiffErrorCode.GithubAccessDenied,
    // Omitted rather than serialized as null when absent, matching how the
    // route builds the payload.
    details: accessDenial === undefined ? {} : { accessDenial },
  });
}

describe("parseBranchViewFileDiffAccessDenial", () => {
  it.each([
    GitHubAccessDenialReason.NotConnected,
    GitHubAccessDenialReason.Revoked,
    GitHubAccessDenialReason.InsufficientScope,
    GitHubAccessDenialReason.OrgRestricted,
    GitHubAccessDenialReason.NoInstallation,
    GitHubAccessDenialReason.RateLimited,
    GitHubAccessDenialReason.Unavailable,
  ])("extracts the %s reason", (reason) => {
    expect(parseBranchViewFileDiffAccessDenial(accessDeniedError(reason))).toBe(
      reason
    );
  });

  it("returns null for a 403 that is not an access denial", () => {
    // An unrelated authorization failure must still render as a generic diff
    // error rather than claiming the user's GitHub credential is at fault.
    const error = new ApiError("Forbidden", 403, {
      details: { accessDenial: GitHubAccessDenialReason.NotConnected },
    });

    expect(parseBranchViewFileDiffAccessDenial(error)).toBeNull();
  });

  it("returns null when the reason is absent or unrecognized", () => {
    expect(
      parseBranchViewFileDiffAccessDenial(accessDeniedError(undefined))
    ).toBeNull();
    // A reason this client build does not know about degrades to the generic
    // error instead of rendering an empty state (cross-version skew).
    expect(
      parseBranchViewFileDiffAccessDenial(accessDeniedError("teleported"))
    ).toBeNull();
  });

  it("returns null for a non-API error", () => {
    expect(parseBranchViewFileDiffAccessDenial(new Error("boom"))).toBeNull();
    expect(parseBranchViewFileDiffAccessDenial(null)).toBeNull();
  });
});
