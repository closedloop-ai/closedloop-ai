import { SENSITIVE_QUERY_PARAMS } from "@repo/analytics/sensitive-query-params";
import { describe, expect, it } from "vitest";
import { GITHUB_CONNECT_REDIRECT_PARAM } from "../github-connect-redirect";

/**
 * `packages/analytics` cannot import {@link GITHUB_CONNECT_REDIRECT_PARAM} — a
 * package never reaches into `apps/app/lib/` (root AGENTS.md) — so it respells
 * the wire name. This is the guard that makes that copy safe, and it lives here
 * because `apps/app` is the only side that can see both spellings.
 *
 * What is at stake if they drift: this param carries the WHOLE desktop
 * authorize URL, `state` and `code_challenge` included, through the signed-out
 * detour `buildGitHubConnectRedirectUrl` builds. posthog-js masks by top-level
 * key and never unwraps a nested url, so a rename here that the analytics list
 * does not follow puts the PKCE challenge and the OAuth CSRF token back on
 * every event PostHog receives from that route.
 */
describe("analytics redaction of the signed-out redirect target", () => {
  it("masks whatever the connect deep link names its redirect param", () => {
    expect(SENSITIVE_QUERY_PARAMS).toContain(GITHUB_CONNECT_REDIRECT_PARAM);
  });
});
