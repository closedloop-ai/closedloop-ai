/**
 * ISS-4996: the single definition of "does this stored repository value carry
 * any identity at all", shared by the render boundary and the writer boundary.
 *
 * It lives in `@repo/lib` rather than beside the session display labels
 * (`packages/app/agents/lib/session-repository-label.ts`) because `apps/api` has
 * no `@repo/app` dependency, and the sync ingest schema
 * (`apps/api/lib/desktop-agent-sessions-schema.ts`) has to apply the SAME rule.
 * Re-declaring the predicate there would let the writer and the reader drift on
 * what counts as malformed — precisely the divergence FEA-3780 set out to
 * remove.
 *
 * The DISPLAY concerns — the "Unknown" label, the malformed tooltip, the
 * absent-vs-malformed split — stay in `session-repository-label.ts`. Only the
 * identity predicate is shared.
 */

/** Any character that is not a slash or whitespace — i.e. real identity content. */
export const REPOSITORY_IDENTITY_CONTENT_REGEX = /[^/\s]/;

/**
 * The stored repository name, trimmed, or `null` when it carries no identity —
 * empty, whitespace-only, or nothing but slashes (`"/"`, `"//"`). That is the
 * whole rule, and it is deliberately permissive about everything else.
 *
 * It does NOT enforce an `owner/repo` character class. `resolveRepoFullName`
 * (`apps/desktop/src/server/operations/git-helpers.ts`) captures the one-slash
 * tail of ANY origin remote with no host or charset check, so real remotes
 * legitimately resolve to `my projects/repo` (a local-path remote), `~user/repo`
 * (gitolite), or `Grüne/repo` (a non-ASCII self-hosted owner). Rejecting those
 * would render "Unknown" for a repository that genuinely resolved, and would
 * disagree with the Repository facet — which still offers the stored value —
 * reintroducing FEA-3780's bug from the other direction.
 */
export function normalizeRepositoryIdentity(
  value: string | null | undefined
): string | null {
  const trimmed = value?.trim();
  if (!(trimmed && REPOSITORY_IDENTITY_CONTENT_REGEX.test(trimmed))) {
    return null;
  }

  return trimmed;
}
