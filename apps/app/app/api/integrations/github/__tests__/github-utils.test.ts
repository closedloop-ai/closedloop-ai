import { GitHubConnectReturnSegment } from "@repo/api/src/types/github-clerk-link";
import { describe, expect, it } from "vitest";
import { getCanonicalBranchViewReturnPath } from "../github-return-path";
import {
  createGitHubOAuthReturnToCookie,
  getGitHubLinkRedirectUrl,
  verifyGitHubOAuthReturnToCookie,
} from "../github-utils";

describe("GitHub OAuth return helpers", () => {
  // ISS-5958: the desktop opener and this validator gate the same two-process
  // contract. They read one list now, and this asserts THIS side honors every
  // entry on it -- the desktop suite asserts the same list from its side, so a
  // segment added to the list cannot reach production honored by only one.
  it.each(Object.values(GitHubConnectReturnSegment))(
    "honors the shared %s return segment, org-qualified or not",
    (segment) => {
      expect(
        getCanonicalBranchViewReturnPath(`/${segment}`, { orgSlug: "acme" })
      ).toBe(`/acme/${segment}`);
      expect(getCanonicalBranchViewReturnPath(`/acme/${segment}`)).toBe(
        `/acme/${segment}`
      );
    }
  );

  it("accepts only canonical GitHub-gated surface return paths", () => {
    expect(getCanonicalBranchViewReturnPath("/acme/build/branch-1")).toBe(
      "/acme/branches/branch-1"
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
    // ISS-5958 M4: desktop Settings → Account asks to come back to /settings
    // after connecting. Both allowlists — the desktop opener's and this one —
    // have to accept it, or the request degrades to Branches here instead.
    expect(getCanonicalBranchViewReturnPath("/acme/settings")).toBe(
      "/acme/settings"
    );
    expect(
      getCanonicalBranchViewReturnPath("/settings", { orgSlug: "acme" })
    ).toBe("/acme/settings");

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
      "/acme/settings?tab=integrations",
      "/acme/settings/extra",
      "/settings",
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

describe("getGitHubLinkRedirectUrl", () => {
  it("carries the pending installation and the return target to the link page", () => {
    expect(getGitHubLinkRedirectUrl("42", "/acme/branches")).toBe(
      "http://localhost:3000/connect/github/link?returnTo=%2Facme%2Fbranches&resumeInstallationId=42"
    );
  });

  it("drops a non-numeric installation id rather than echoing it", () => {
    // The id arrives on a query string; only GitHub's own integer ids resume.
    expect(getGitHubLinkRedirectUrl("../evil")).toBe(
      "http://localhost:3000/connect/github/link"
    );
  });
});
