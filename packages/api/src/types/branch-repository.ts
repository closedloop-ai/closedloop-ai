const LEADING_SLASHES_RE = /^\/+/;
const TRAILING_SLASHES_RE = /\/+$/;

/**
 * Canonical normalizer for a repository full name (PRD-510 D2). The single owner
 * used by every branch/commit producer so the identity key
 * `(organizationId, repositoryFullName, branchName)` is byte-identical across the
 * desktop-sync and GitHub-webhook lanes regardless of GitHub App installation.
 *
 * Operates on an already-extracted `owner/name` string — it does NOT parse a
 * remote URL (the desktop's URL→owner/name extraction is a separate concern).
 * Normalization: trim surrounding whitespace, strip a trailing `.git`, strip
 * leading/trailing slashes, and lowercase (GitHub owners/repos are
 * case-insensitive). Idempotent — normalizing an already-normalized name is a
 * no-op, so it is safe to apply defensively at every write and read site.
 */
export function normalizeRepoFullName(fullName: string): string {
  let next = fullName
    .trim()
    .replace(LEADING_SLASHES_RE, "")
    .replace(TRAILING_SLASHES_RE, "");
  if (next.toLowerCase().endsWith(".git")) {
    next = next.slice(0, -".git".length);
  }
  return next.replace(TRAILING_SLASHES_RE, "").toLowerCase();
}

/**
 * Canonical structural parser for a repository full name (ISS-7548): exactly
 * `owner/repo`, and ONLY that.
 *
 * A full name is normalized but never structurally validated on the way in
 * ({@link normalizeRepoFullName} trims, strips `.git`, and lowercases; the ref
 * schemas only bound the length), so `owner/repo/extra` reaches a read site as
 * its own identity key. Taking the FIRST TWO segments of it silently rebinds
 * that key to a different repository — reading `owner/repo` from GitHub and
 * writing its provider id, url, default-branch authority, PR projection, or
 * access verdict onto a row keyed for something else. Over-segmentation is
 * therefore rejected, not truncated.
 *
 * Returns `null` for anything that is not two non-empty segments. Callers own
 * the failure mapping — a `matched: false`, a `CorruptState` terminal, an
 * `Unsyncable` reclassification, a thrown error, an empty verdict target — only
 * the parse is shared.
 */
export type RepositoryIdentity = { owner: string; repo: string };

export function parseRepositoryFullName(
  fullName: string
): RepositoryIdentity | null {
  const [owner, repo, ...extra] = fullName.split("/");
  if (!(owner && repo) || extra.length > 0) {
    return null;
  }
  return { owner, repo };
}
