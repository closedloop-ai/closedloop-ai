import { GitHubCredentialKind } from "@repo/api/src/types/github";

/**
 * The shared POLICY predicates for a GitHub user credential — scope floor,
 * name normalization, credential family, and the `lastUsedAt` sampling
 * interval the registry writes on.
 *
 * PLN-1525 gave this module the one stored-token read; PLN-1742 emptied it.
 * M1 put Clerk in front, M5 retired the in-house OAuth client so nothing mints
 * a stored token any more, and the M5 tail deleted the stored read itself.
 * What is left is the vocabulary every lane still shares — the credential now
 * comes from `clerk-github-credential.ts`, and the `GitHubUserConnection` row
 * is a token-less registry (`github-clerk-registry.ts`).
 *
 * There is no module-local denial enum any more either: the two members that
 * justified one (`expired`, `decryption_failed`) described a stored cipher and
 * died with it, leaving a strict copy of the wire `GitHubAccessDenialReason`.
 * Every lane speaks that enum directly.
 */

/** An unexpired capability row folded into a credential read. */
export type GitHubCapabilityRecord = {
  credentialKind: string;
  denialReason: string | null;
  installationId: string | null;
  checkedAt: Date;
  expiresAt: Date;
};

/**
 * `lastUsedAt` is sampled, not written per resolution: its only consumer is
 * GitHub's one-year-unused auto-revocation, which needs day granularity.
 * Writing it on every resolution would become a Postgres write per GitHub
 * operation, since the registry is touched on every credential resolution
 * (PLN-1525 pool-protection rule 3).
 */
export const LAST_USED_AT_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;

/** The scope floor for classic-OAuth-family reads/writes (PLN-1525). */
export const GITHUB_REPO_SCOPE = "repo";

/**
 * Does this credential clear the classic-OAuth scope floor?
 *
 * App-family tokens report no scopes at all and are governed by installation
 * reach rather than by scopes, so they never fail it — only an OAuth-family
 * token can. PLN-1742 M2: one predicate for the interactive resolver, the sync
 * pool, and the webhook sync lane, which each carried their own and disagreed
 * (the sync lane's demanded `repo`/`public_repo` outright, so it rejected every
 * App-family token it was handed).
 *
 * Adopting it dropped the sync lane's `public_repo`-on-a-public-repository
 * allowance, which is unreachable rather than merely unused: nothing can mint
 * such a grant. GitHub linking requests `repo read:user user:email`
 * (`GITHUB_CLERK_OAUTH_SCOPES`), so a token carrying `public_repo` WITHOUT
 * `repo` has no producer. If one ever gains one, this is the single place to
 * widen.
 */
export function meetsGitHubRepoScopeFloor(scopes: readonly string[]): boolean {
  return scopes.length === 0 || scopes.includes(GITHUB_REPO_SCOPE);
}

/**
 * The one normalization rule for GitHub owner and repo name segments used in
 * cache/verdict identity (GitHub treats both as case-insensitive). Every
 * lane — interactive resolver and sync pool — must build identity through
 * this so case variants can never mint distinct verdict rows.
 */
export function normalizeGitHubName(segment: string): string {
  return segment.toLowerCase();
}

/**
 * Which credential family a set of granted scopes belongs to. A GitHub App
 * user-to-server token reports an empty `scope`, while the Clerk-held OAuth
 * App token carries classic scopes — the scopes array is the discriminator.
 * Scope-floor checks only apply to the OAuth family; App-token reach is
 * governed by the installation, not scopes.
 */
export function storedGitHubCredentialKind(
  scopes: readonly string[]
): GitHubCredentialKind {
  return scopes.length > 0
    ? GitHubCredentialKind.OauthUser
    : GitHubCredentialKind.GithubAppUser;
}
