/**
 * The web app's Clerk GitHub linking page (PLN-1742 M3). One constant because
 * the path is a cross-process wire value: `apps/app` serves the route and the
 * desktop MAIN process constructs the URL it opens in the browser. Version-skew
 * safe either way — an older web deploy 404s to the app shell rather than
 * breaking the desktop — but the two producers must agree on the spelling.
 *
 * (The `github-clerk-credentials` PostHog/Labs rollout key that used to live
 * here was retired in M5: Clerk is the unconditional credential source, so
 * there is no enrollment verdict left to gate on.)
 *
 * Leaf, dependency-free module (no Zod, no `@repo/app`) — safe to import
 * from the desktop main process.
 */
export const GITHUB_CLERK_LINK_PATH = "/connect/github/link" as const;

/**
 * The GitHub OAuth scopes GitHub linking asks the user to grant. The linking
 * page passes this exact set on BOTH paths — `user.createExternalAccount`
 * for a first-time link and `externalAccount.reauthorize` for the M5 re-link
 * of a grant that lacks `repo` — so a re-linked grant matches a fresh one.
 * The server-side scope FLOOR (`GITHUB_REPO_SCOPE` in
 * `apps/api/lib/github/github-connection-credential.ts`) is a different
 * contract — what a credential must carry, not what linking requests.
 *
 * `additionalScopes` is ADDITIVE to the Clerk Dashboard's GitHub provider
 * config, so this array can only widen what the consent screen shows, never
 * narrow it. Removing `read:org` from a first-time link therefore also needs
 * it removed from that dashboard config (live AND test) — an operator action
 * outside this repo. Until that lands, a fresh link still inherits `read:org`
 * from the global provider config; only what this repo requests is narrowed.
 *
 * ISS-8156 dropped `read:org`: nothing consumed it. The one org-scoped read
 * on a user token — `orgs.getMembershipForAuthenticatedUser`, the claim
 * ownership proof in
 * `apps/api/app/integrations/github/service/installation-claim.ts` — accepts
 * `repo` (GitHub answers that endpoint with
 * `X-Accepted-OAuth-Scopes: admin:org, read:org, repo, user, write:org`), and
 * `repo` is already the enforced floor. Do not re-add a scope here without a
 * caller that needs it: every entry is a permission a user is asked to grant.
 */
export const GITHUB_CLERK_OAUTH_SCOPES = [
  "repo",
  "read:user",
  "user:email",
] as const;

/**
 * Machine-readable reasons a claim (`POST /integrations/github/connect`) was
 * refused, carried as the failure body's `code`. Only reasons a CALLER can
 * act on live here: `LinkRequired` means the caller has no usable Clerk
 * GitHub grant, which the web callback turns into a trip through the linking
 * page instead of the generic "Failed to connect" dead end. Additive and
 * optional on the wire — an older client that ignores `code` still renders
 * the human message.
 */
export const GitHubConnectErrorCode = {
  LinkRequired: "github_link_required",
} as const;
export type GitHubConnectErrorCode =
  (typeof GitHubConnectErrorCode)[keyof typeof GitHubConnectErrorCode];

/**
 * Query param the install callback uses to hand a still-unclaimed
 * installation to the linking page (PLN-1742 M5). Carrying it here rather
 * than resuming the callback keeps the callback's one-time CSRF state out of
 * a URL the user is bounced through: the linking page finishes the claim
 * with the caller's own Clerk-authenticated API session. Digits only —
 * validated by both the producer and the page that reads it.
 */
export const GITHUB_RESUME_INSTALLATION_ID_PARAM = "resumeInstallationId";

/**
 * Marks a caller that has already been through the widen-scope consent round
 * (PLN-1742 M5 `reauthorize`). Two producers read it off two different URLs,
 * which is why it is one constant rather than two literals:
 *
 * - On the LINKING PAGE's own URL it stops a consent that still yields
 *   `insufficient_scope` from bouncing to GitHub forever, and
 *   `buildRetryHref` drops it so "Try again" can reach consent again.
 * - On `POST /integrations/github/clerk-link` it tells the server the same
 *   fact, which is what separates a terminal `insufficient_scope` from the
 *   benign first one the page answers by re-linking (ISS-10459). Additive and
 *   optional: a client that omits it reads as "not yet through consent", so
 *   an older deploy under-reports rather than paging on a link that worked.
 */
export const GITHUB_CLERK_RELINK_ATTEMPTED_PARAM = "relink";

/**
 * Where a finished GitHub connect may send the user back to — the org-scoped
 * top-level surfaces, as bare path segments.
 *
 * One list because this is a two-process contract: the desktop MAIN process
 * decides which `returnTo` it will put on the URL it opens, and the web app
 * decides which one it will honor on the way back. Both are allowlists, never
 * passthroughs — the value becomes a post-OAuth navigation target — and they
 * have to agree, or the request silently degrades to the default. ISS-5958 M4
 * paid for that: `settings` had to be hand-added on both sides in one commit,
 * and adding only one would have left the user on Branches after connecting
 * from Settings.
 *
 * A detail route (`branches/:id`) is NOT here. It carries an id each side has
 * to validate on its own terms, so it stays a per-process pattern.
 */
export const GitHubConnectReturnSegment = {
  Branches: "branches",
  Insights: "insights",
  Agents: "agents",
  Sessions: "sessions",
  Settings: "settings",
  // ISS-7866: the web dashboard renders gated KPI cards but passed no connect
  // target, so its ask arrived with no button on it — an instruction the reader
  // could not act on. Giving it an authorize href needs a return segment, or
  // the round trip lands them somewhere other than where they clicked.
  Dashboard: "dashboard",
} as const;
export type GitHubConnectReturnSegment =
  (typeof GitHubConnectReturnSegment)[keyof typeof GitHubConnectReturnSegment];
