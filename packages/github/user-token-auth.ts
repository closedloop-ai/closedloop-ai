import "server-only";
import { Octokit } from "@octokit/rest";
import { boundedFetch } from "./bounded-fetch";

// PLN-1525: consumers hold resolver-built clients typed as Octokit without
// depending on @octokit/rest themselves. Re-exported from this focused
// subpath, not index.ts — the grandfathered barrel is shrink-only.
export type { Octokit } from "@octokit/rest";

export type UserTokenOctokitOptions = {
  /** Test seam: replaces the timeout-bounded default fetch. */
  fetch?: typeof fetch;
};

/**
 * Build an Octokit authenticated as a GitHub user (OAuth App token or GitHub
 * App user-to-server token — both are plain bearer tokens to Octokit). Every
 * request is timeout-bounded like the installation lane, unlike the legacy
 * comment-write helpers in `comment-user-token.ts`.
 *
 * PLN-1525: the apps/api credential resolver builds its user-lane clients
 * through this so credential selection stays outside this package —
 * `packages/github` remains credential-agnostic.
 */
export function getUserTokenOctokit(
  userAccessToken: string,
  options?: UserTokenOctokitOptions
): Octokit {
  return new Octokit({
    auth: userAccessToken,
    request: { fetch: options?.fetch ?? boundedFetch },
  });
}
