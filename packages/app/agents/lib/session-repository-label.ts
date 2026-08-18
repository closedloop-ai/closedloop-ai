/**
 * FEA-3780 / FEA-4274: the single definition of a session's *repository
 * identity* and its display label, shared by every surface that shows one.
 *
 * A session's repository derives ONLY from resolved Git-remote evidence. It is
 * never derived from the session's working directory (`cwd`) or worktree path:
 * those are frequently numbered container dirs (e.g. `/Users/x/Code/3`) or, in
 * the degenerate case that produced FEA-3780, the filesystem root (`/`).
 * Presenting either as a repository invents an identity that the Repository
 * filter — built from `repositoryFullName` — can never produce, so the session
 * sits under a label that cannot select it.
 *
 * FEA-4274 established this for the Sessions list. The session-detail surfaces
 * kept an independent `?? session.cwd` fallback, so a session the list showed
 * as "Unknown" showed a raw filesystem path on its detail page — the same
 * record describing itself two different ways. Both now resolve through here.
 *
 * Version-skew safe: a session synced by an older Desktop that carried only a
 * cwd folder and no remote degrades to `null` / "Unknown" rather than crashing
 * or fabricating a label.
 *
 * ## Boundary: this is NOT the artifact-key normalizer
 *
 * Two normalizers exist for a repository full name and they are deliberately
 * different. Pick by lane:
 *
 * - **This module — session DISPLAY identity.** Preserves the stored spelling
 *   verbatim (trim only). It must not transform, because the Repository facet,
 *   the filter predicate and the desktop sort all group on the stored value: a
 *   label that differs from the grouping key is exactly the divergence FEA-3780
 *   set out to remove. It rejects only a value carrying no identity at all —
 *   the predicate itself is `normalizeRepositoryIdentity` in
 *   `@repo/lib/sessions/repository-identity`, which ISS-4996 moved there so the
 *   sync ingest schema (`apps/api/lib/desktop-agent-sessions-schema.ts`, which
 *   cannot import `@repo/app`) applies the SAME rule at the writer boundary.
 *   This module keeps the display concerns: the label, the tooltip, and the
 *   absent-vs-malformed split.
 * - **`normalizeRepoFullName` (`packages/api/src/types/branch.ts`) — artifact
 *   KEY identity** for the branch/commit/PR lane. It lowercases, strips `.git`
 *   and surrounding slashes, and never rejects, because that value is a join
 *   key that has to match across producers.
 *
 * A consequence worth knowing: a remote spelled `Owner/Repo` displays with its
 * original case here and joins as `owner/repo` there, so the same repo can read
 * two ways one click apart. That predates this module; unifying it is a
 * separate change. Do not "fix" it by swapping one normalizer for the other —
 * lowercasing here would desync the label from the facet it is grouped by.
 */

import { normalizeRepositoryIdentity } from "@repo/lib/sessions/repository-identity";

/**
 * The fields a session record can carry its repository identity in. Structural
 * so list items, detail records, and the desktop-local shapes all satisfy it
 * without this module depending on any one of them.
 */
export type SessionRepositorySource = {
  repositoryFullName?: string | null;
  /**
   * Compatibility alias. Both current producers set it to the same value as
   * `repositoryFullName`; it is read second so an older payload that populated
   * only this field still resolves.
   */
  repo?: string | null;
};

/** Shown when no Git remote has resolved — the identity is genuinely unknown. */
export const SESSION_REPOSITORY_UNKNOWN_LABEL = "Unknown";

/**
 * ISS-4996 (#4324 review): why the MALFORMED cell keeps the word "Unknown"
 * while the ABSENT cell beside it renders the shared em dash.
 *
 * Two glyphs for two facts is only honest if the reader can tell which is
 * which; without this the column asks a question it refuses to answer. It names
 * the condition in the user's terms ("a repository was recorded, but it is not
 * readable") rather than ours, and does NOT promise a fix, because the render
 * has no idea whether anyone is looking at it.
 */
export const SESSION_REPOSITORY_MALFORMED_TOOLTIP =
  "A repository was recorded for this session, but the stored value is not a readable repository name.";

/** A `github.com` URL path segment pair. Intentionally stricter than a label. */
const GITHUB_REPO_PATH_REGEX = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The session's repository identity, or `null` when no remote resolved. */
export function resolveSessionRepositoryFullName(
  session: SessionRepositorySource
): string | null {
  return (
    normalizeRepositoryIdentity(session.repositoryFullName) ??
    normalizeRepositoryIdentity(session.repo)
  );
}

/**
 * The display label for a repository cell or property row. Callers that render
 * their own empty state should use `resolveSessionRepositoryFullName` and
 * handle `null` instead.
 */
export function resolveSessionRepositoryLabel(
  session: SessionRepositorySource
): string {
  return (
    resolveSessionRepositoryFullName(session) ??
    SESSION_REPOSITORY_UNKNOWN_LABEL
  );
}

/**
 * The `owner/repo` path for a `github.com` URL, or `null` when the value cannot
 * safely become one. Stricter than {@link normalizeRepositoryIdentity} on
 * purpose: a label only has to be honest, but a URL has to resolve, so a
 * self-hosted or local-path remote that is a perfectly good label is not a
 * usable github.com path.
 */
export function toGitHubRepoPath(
  value: string | null | undefined
): string | null {
  const trimmed = value?.trim();
  if (!(trimmed && GITHUB_REPO_PATH_REGEX.test(trimmed))) {
    return null;
  }

  return trimmed;
}

/**
 * ISS-4996: WHY a session has no repository label. Absent and malformed are two
 * different facts and the cell must not flatten them into one word.
 *
 * `resolveSessionRepositoryFullName` folds both to `null`, which is right for a
 * caller that only needs the label — but it left the Sessions grid rendering the
 * literal word "Unknown" for the overwhelmingly common `null` case, while the
 * Branch column right beside it rendered an em dash for the identical "this
 * field has no value" condition. One condition, two glyphs, in adjacent columns.
 */
export const SessionRepositoryDisplayKind = {
  /** A Git remote resolved; `label` is the stored spelling. */
  Resolved: "resolved",
  /**
   * No repository field was set at all — the collector never resolved a remote.
   * This is the ordinary case for a session run outside a Git checkout, and it
   * is the same fact as a null branch, so it renders the same shared empty
   * glyph.
   */
  Absent: "absent",
  /**
   * A repository value WAS stored but carries no identity — empty, whitespace,
   * or nothing but slashes. That is a value that should never have been
   * persisted (validate at the ingest boundary: store valid-or-nothing), so it
   * keeps the distinct "Unknown" so it stays visible rather than disappearing
   * into the same em dash a legitimately-absent repository gets.
   */
  Malformed: "malformed",
} as const;
export type SessionRepositoryDisplayKind =
  (typeof SessionRepositoryDisplayKind)[keyof typeof SessionRepositoryDisplayKind];

export type SessionRepositoryDisplay =
  | { kind: typeof SessionRepositoryDisplayKind.Resolved; label: string }
  | { kind: typeof SessionRepositoryDisplayKind.Absent }
  | { kind: typeof SessionRepositoryDisplayKind.Malformed };

/**
 * The session's repository identity as a DISPLAY decision, distinguishing an
 * absent repository from a stored-but-unreadable one.
 *
 * A value counts as malformed only when at least one repository field is a
 * present string that survives neither {@link normalizeRepositoryIdentity} nor
 * the other field — so a payload carrying `repositoryFullName: ""` alongside a
 * good `repo` still resolves, and a version-skewed payload that simply omits
 * both fields is Absent, not malformed. Omission is not corruption.
 */
export function resolveSessionRepositoryDisplay(
  session: SessionRepositorySource
): SessionRepositoryDisplay {
  const label = resolveSessionRepositoryFullName(session);
  if (label) {
    return { kind: SessionRepositoryDisplayKind.Resolved, label };
  }
  const carriesStoredValue =
    typeof session.repositoryFullName === "string" ||
    typeof session.repo === "string";
  return carriesStoredValue
    ? { kind: SessionRepositoryDisplayKind.Malformed }
    : { kind: SessionRepositoryDisplayKind.Absent };
}
