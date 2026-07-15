import { describe, expect, it } from "vitest";
import {
  createGitHubOAuthReturnToCookie,
  getCanonicalBranchViewReturnPath,
  verifyGitHubOAuthReturnToCookie,
} from "../github-utils";

describe("GitHub OAuth return helpers", () => {
  it("accepts only canonical GitHub-gated surface return paths", () => {
    expect(getCanonicalBranchViewReturnPath("/acme/build/branch-1")).toBe(
      "/acme/build/branch-1"
    );
    expect(getCanonicalBranchViewReturnPath("/acme/branches")).toBe(
      "/acme/branches"
    );
    expect(getCanonicalBranchViewReturnPath("/acme/branches/branch-1")).toBe(
      "/acme/branches/branch-1"
    );
    expect(
      getCanonicalBranchViewReturnPath("/branches", { orgSlug: "acme" })
    ).toBe("/acme/branches");
    expect(
      getCanonicalBranchViewReturnPath("/branches/owner%2Frepo::feature", {
        orgSlug: "acme",
      })
    ).toBe("/acme/branches/owner%2Frepo::feature");
    expect(getCanonicalBranchViewReturnPath("/acme/insights")).toBe(
      "/acme/insights"
    );
    expect(
      getCanonicalBranchViewReturnPath("/insights", { orgSlug: "acme" })
    ).toBe("/acme/insights");
    expect(getCanonicalBranchViewReturnPath("/acme/agents")).toBe(
      "/acme/agents"
    );
    expect(
      getCanonicalBranchViewReturnPath("/agents", { orgSlug: "acme" })
    ).toBe("/acme/agents");

    for (const returnTo of [
      "https://evil.example.test/acme/build/branch-1",
      "//evil.example.test/acme/build/branch-1",
      "/api/integrations/github/callback",
      "/acme/build/branch-1?github=connected",
      "/acme/build/branch-1#fragment",
      "/acme/branches?github=connected",
      "/acme/branches/branch-1#fragment",
      "/acme/insights?github=connected",
      "/acme/insights/extra",
      "/acme/agents?github=connected",
      "/acme/agents/extra",
      "/acme/branch/branch-1",
      "/acme/build/%2e%2e",
      "/acme/build/foo%2fbar",
      "/acme/branches/foo%2e%2e",
      "/acme/build/foo\\bar",
      "/acme/build/branch-1/extra",
      "/acme/branches/branch-1/extra",
      "/branches",
      "/insights",
      "/branches/foo%2e%2e",
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
