# packages/github

> **Agents:** also read `AGENTS.md` in this directory for coding patterns, security rules, and domain conventions.

Server-only package (`import "server-only"`) for GitHub App integration. All exports require
valid `GITHUB_APP_*` environment variables. Do not import in `apps/app` — use `apps/api` routes.

## Exported Surface

`index.ts` is the GitHub App client and the full set of REST/GraphQL operations the platform uses (Octokit auth, webhook signature verification, repo/branch/PR/deployment reads, PR review/comment operations). Read `index.ts` directly for the current export list — do not hand-maintain an inventory here. Conventions:

- Auth: `getAuthenticatedOctokit()` resolves the GitHub App installation for the configured app-installation repo (`GITHUB_APP_DISPATCH_REPO`) for app-owned reads (e.g. Desktop release lookup); `getInstallationAccessToken(installationId)` for per-install operations. Use `deleteInstallation()` (JWT auth) for uninstall — not an installation token.
- Auth split: app and installation token helpers are for repository/PR/deployment reads, sync/backfill, webhook handling, and app-owned operations. User-token helpers are only for user-authored GitHub comment writes: creating, editing, deleting, resolving, or unresolving PR issue/review comments and review threads on behalf of the authenticated GitHub user.
- Do not route user-authored comment writes through installation-token helpers. The `*WithUserToken` comment helpers construct Octokit from the provided user access token and must not call `getAuthenticatedOctokit()`, `getInstallationOctokit()`, or `getInstallationAccessToken()`.
- Branch existence checks (`verifyBranchExists`, `verifyInstallationBranchExists`) return `false` on 404 and throw on other errors.
