import { describe, expect, it } from "vitest";
import {
  createGitHubOAuthReturnToCookie,
  getCanonicalBranchViewReturnPath,
  verifyGitHubOAuthReturnToCookie,
} from "../github-utils";

describe("GitHub OAuth Branch View return helpers", () => {
  it("accepts only canonical Branch View return paths", () => {
    expect(getCanonicalBranchViewReturnPath("/acme/build/branch-1")).toBe(
      "/acme/build/branch-1"
    );

    for (const returnTo of [
      "https://evil.example.test/acme/build/branch-1",
      "//evil.example.test/acme/build/branch-1",
      "/api/integrations/github/callback",
      "/acme/build/branch-1?github=connected",
      "/acme/build/branch-1#fragment",
      "/acme/build/%2e%2e",
      "/acme/build/foo%2fbar",
      "/acme/build/foo\\bar",
      "/acme/build/branch-1/extra",
      `/${"a".repeat(201)}/build/branch-1`,
    ]) {
      expect(getCanonicalBranchViewReturnPath(returnTo)).toBeNull();
    }
  });

  it("verifies only untampered, unexpired cookies bound to the OAuth state", () => {
    const cookieValue = createGitHubOAuthReturnToCookie({
      issuedAt: 1000,
      returnTo: "/acme/build/branch-1",
      state: "state-1",
    });

    expect(
      verifyGitHubOAuthReturnToCookie({
        cookieValue,
        now: 1000,
        state: "state-1",
      })
    ).toBe("/acme/build/branch-1");
    expect(
      verifyGitHubOAuthReturnToCookie({
        cookieValue,
        now: 1000,
        state: "state-2",
      })
    ).toBeNull();
    expect(
      verifyGitHubOAuthReturnToCookie({
        cookieValue: `${cookieValue.slice(0, -1)}x`,
        now: 1000,
        state: "state-1",
      })
    ).toBeNull();
    expect(
      verifyGitHubOAuthReturnToCookie({
        cookieValue,
        now: 1000 + 10 * 60 * 1000 + 1,
        state: "state-1",
      })
    ).toBeNull();
  });
});
