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
