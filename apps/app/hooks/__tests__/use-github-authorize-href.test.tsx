import { describe, expect, it } from "vitest";
import { useGitHubAuthorizeHref } from "../use-github-authorize-href";

// PLN-1742 M5: the hook is a pure alias for getGitHubConnectUrl("authorize")
// -- the in-house authorize route is retired, so there is no org-enrollment
// verdict left to read and no provider tree required.
describe("useGitHubAuthorizeHref", () => {
  it("targets the Clerk linking page", () => {
    expect(useGitHubAuthorizeHref({ returnTo: "/acme/branches" })).toBe(
      "/connect/github/link?returnTo=%2Facme%2Fbranches"
    );
  });

  it("returns the bare linking page without a returnTo", () => {
    expect(useGitHubAuthorizeHref()).toBe("/connect/github/link");
  });
});
