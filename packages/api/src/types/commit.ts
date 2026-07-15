/**
 * Commit provenance + identity shared types (FEA-2731 / PRD-510 D7).
 *
 * `CommitDetail` is the cloud SSOT for git commits observed on a branch, fed by
 * two producers reconciled on the identity key `(organizationId,
 * repositoryFullName, sha)`:
 *   - the desktop sync lane (non-App repos, no GitHub App required), which
 *     supplies the ABBREVIATED sha it parsed from the git-commit summary line,
 *   - the GitHub `push` webhook (App repos), which supplies the FULL 40-char sha.
 *
 * The cloud reconciles the two with a git-style sha-prefix match and, when the
 * webhook lands, expands the stored sha to its full form (see the commit
 * service). This module owns only the small vocabulary shared by both sides.
 */

/**
 * Provenance of the last authoritative writer of a `CommitDetail` row. GitHub
 * sources (`push_webhook`, `github_api`) are authoritative for author/date/LOC;
 * `desktop_sync` is a fallback that fills nulls only (Phase 4 merge). Freeform
 * on the DB column (matching BranchDetail's pushSource convention); this const
 * object is the SSOT for the allowed values — import it, never re-declare.
 */
export const CommitProvenanceSource = {
  DesktopSync: "desktop_sync",
  PushWebhook: "push_webhook",
  GitHubApi: "github_api",
} as const;
export type CommitProvenanceSource =
  (typeof CommitProvenanceSource)[keyof typeof CommitProvenanceSource];

/**
 * The GitHub-sourced provenances. A write from one of these is authoritative for
 * the GitHub-owned fields (author*, committedAt, authoredAt, message, LOC,
 * isMerge/mergeCommitSha) and overwrites them; a `desktop_sync` write fills only
 * nulls. Also drives which `source` label is retained on merge — GitHub
 * authority, once established, is never demoted by a later desktop write.
 */
export const AUTHORITATIVE_COMMIT_SOURCES: ReadonlySet<string> = new Set([
  CommitProvenanceSource.PushWebhook,
  CommitProvenanceSource.GitHubApi,
]);

/** True when a commit provenance is GitHub-authoritative (not desktop fallback). */
export function isAuthoritativeCommitSource(source: string): boolean {
  return AUTHORITATIVE_COMMIT_SOURCES.has(source);
}
