import { GitHubFetchMechanism } from "@repo/api/src/types/github-read-model";
import { describe, expect, it } from "vitest";
import { isProviderAuthoritativePullRequest } from "./pull-request-provider-authority";

/**
 * Expectations are pinned as literals rather than derived from
 * `isGitHubAppFetchMechanism`, so a change that widens or narrows the App
 * mechanism set cannot move the expected value along with the answer.
 */
const APP_MECHANISMS = [
  GitHubFetchMechanism.Webhook,
  GitHubFetchMechanism.Backfill,
  GitHubFetchMechanism.Graphql,
  GitHubFetchMechanism.Rest,
] as const;

const NON_APP_MECHANISMS = [
  GitHubFetchMechanism.DesktopSync,
  GitHubFetchMechanism.Unknown,
  null,
] as const;

describe("isProviderAuthoritativePullRequest", () => {
  it("holds authority for every App mechanism even with no githubId yet", () => {
    for (const fetchMechanism of APP_MECHANISMS) {
      expect(
        isProviderAuthoritativePullRequest({ fetchMechanism, githubId: null })
      ).toBe(true);
    }
  });

  it("keeps authority on githubId whatever a later write does to the mechanism", () => {
    // AC3 / ISS-8462: `fetch_mechanism` is rewritten by every successful
    // reconcile, so authority may not rest on it. `githubId` is provider-only
    // and never cleared, so it survives any mechanism the row ends up carrying.
    for (const fetchMechanism of [...APP_MECHANISMS, ...NON_APP_MECHANISMS]) {
      expect(
        isProviderAuthoritativePullRequest({
          fetchMechanism,
          githubId: "PR_kwDO",
        })
      ).toBe(true);
    }
  });

  it("denies authority to a row no provider has produced or verified", () => {
    for (const fetchMechanism of NON_APP_MECHANISMS) {
      expect(
        isProviderAuthoritativePullRequest({ fetchMechanism, githubId: null })
      ).toBe(false);
    }
  });

  it("treats an absent row as unowned rather than throwing", () => {
    expect(isProviderAuthoritativePullRequest(null)).toBe(false);
    expect(isProviderAuthoritativePullRequest(undefined)).toBe(false);
  });
});
