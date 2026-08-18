# GitHub Package Rules

Server-only package (`import "server-only"`) for GitHub integration. Installation/app-authenticated
exports require valid `GITHUB_APP_*` environment variables; the credential-agnostic subpaths
(`user-token-auth`, `bounded-fetch`) take a caller-supplied token and need no App configuration.
Do not import in `apps/app` — use `apps/api` routes.

## Exported Surface

`index.ts` is the GitHub App client and the full set of REST/GraphQL operations the platform uses (Octokit auth, webhook signature verification, repo/branch/PR/deployment reads, PR review/comment operations). Read `index.ts` directly for the current export list — do not hand-maintain an inventory here. Conventions:

- Auth: `getAuthenticatedOctokit()` resolves the GitHub App installation for the configured app-installation repo (`GITHUB_APP_DISPATCH_REPO`) for app-owned reads (e.g. Desktop release lookup); `getInstallationAccessToken(installationId)` for per-install operations. Use `deleteInstallation()` (JWT auth) for uninstall — not an installation token.
- `getInstallationOctokit()` performs a token exchange and therefore rejects like any network call. A caller whose reads report failure as values reaches it through `acquireInstallationClient` / `readWithInstallationClient` (`apps/api/lib/github/installation-client.ts`), which classify that rejection into the same `GitHubProviderResult` a read produces — adding a try/catch at the call site *just* to catch the mint is the scattered handling those helpers replaced. Where the read itself throws and the caller already has one handler covering that (`getBranches`, `getRepositoryBranches`), minting inside that same handler is correct: acquisition and read failures already end up in one place, which is the point.
- Auth split (PLN-1525): credential *selection* lives in the apps/api resolver layer (`apps/api/lib/github/`), not here — this package stays credential-agnostic. Installation/app helpers serve app-owned operations and installation-lane reads; `user-token-auth.ts` builds timeout-bounded user Octokits for user-attributed **reads** (the interactive resolver and sync-pool lanes) as well as the comment-write helpers' operations. Do not add code here that picks which credential to use.
- Do not route user-authored comment writes through installation-token helpers. The `*WithUserToken` comment helpers take the caller's **user** Octokit as their first parameter (PLN-1525 — they no longer mint one from a token, so a multi-write action builds one bounded client instead of one per call) and must not call `getAuthenticatedOctokit()`, `getInstallationOctokit()`, or `getInstallationAccessToken()`. The parameter type cannot distinguish a user client from an installation client, so the ban is review-owned: `apps/api/app/comments/github-identity.ts` is the only sanctioned source, and passing an installation client would silently post as the app instead of the human who wrote the comment.
- Branch existence checks (`verifyBranchExists`) return `false` on 404 and throw on other errors.
- Read functions take the caller's `octokit` as the first parameter (PLN-1525 step 4) — do not add functions that mint an installation client from an `installationId` argument; callers resolve their client once per operation in `apps/api` and thread it down. A read that owns a deadline accepts `Octokit | Promise<Octokit>` and awaits it inside the raced operation, so the caller's credential acquisition is bounded by that same deadline (`review-thread-lookup`); otherwise a slow token exchange escapes the timeout the read advertises.

## Subpath Modules

Imported by direct path, not re-exported from `index.ts`. Read the package source for the
current module list — do not hand-maintain an inventory here. Two carry a contract beyond
their signature:

- **`deployment-status-parser`** — `parseDeploymentStatusEvent(payload)` returns `null` ONLY when the payload has no non-nullable dedupe identity (`deployment.id` + `deployment_status.id`); an unrecognized `state` is NOT a parse failure and degrades to `DeploymentEventState.Unknown` (ISS-4975).
- **`electron-release`** — `getLatestElectronRelease()` must resolve the Desktop channel/tag specifically, not repo-global latest-release semantics (see Domain Rules).

## Parser Conventions

- **New parsers belong here**, not in `apps/api/lib/`. Import via subpath: `@repo/github/artifact-reference-parser`.
- **Every new parser module must include unit tests** in `__tests__/`.
- **Do not add barrel re-exports** to `index.ts` for parser modules — direct subpath imports avoid Biome's `noBarrelFile` rule.
- **Top-level regex** — declare `const MY_REGEX = /pattern/` at module scope, not inside functions.
- **Never use `str.match(regex)`** — use `RegExp.exec(str)` or `str.matchAll(regex)`.
- Parser input types are module-specific: file-content parsers may accept `Buffer` or markdown entries, while PR title/body parsers accept strings. Follow the exported function signature and return typed objects from `@repo/api/src/types/`.
- Return `null` or empty structures on parse failure; log warnings with `[module-name]` prefix via `@repo/observability/log`.

## Domain Rules

- When mapping pull-request review comments, preserve GitHub's original anchor fields as fallbacks for canonical line data. Outdated comments can have `line: null` while `original_line` remains populated, and downstream branch-view projection/backfill code still needs a stable anchor.
- When resolving Desktop releases from GitHub, do not rely on repo-global latest release semantics or on the first page of repository releases containing a Desktop release. Query the Desktop channel/tag directly or page until the Desktop-specific release contract is found.
