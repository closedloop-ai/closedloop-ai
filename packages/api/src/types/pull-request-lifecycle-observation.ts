import { GitHubPRState } from "./github-status.ts";

/**
 * Whether a PERSISTED pull-request row's lifecycle was actually observed, as
 * opposed to read off its column defaults. Introduced by `f9ed3b47a` (#4021) and
 * moved here by ISS-8422. That commit's subject cites FEA-4317, a slug with no
 * artifact behind it in ClosedLoop — the commit and PR number are the durable
 * reference, and the same phantom slug appears in the comments around
 * `session-pr-status.ts`.
 *
 * `pr_state` and `is_draft` are `NOT NULL` with defaults, so a row nobody
 * measured still reads `OPEN`, and `lastVerifiedAt` alone does not tell the two
 * apart. A genuine observation carries a terminal timestamp (`mergedAt` /
 * `closedAt`), a terminal state (Merged / Closed), or the PR-opened timestamp
 * `githubCreatedAt`, which only the webhook, `gh` fetch and App backfill paths
 * write. Absent all of those, the Open is a default and not a measurement.
 *
 * READ-SIDE TWIN of `hasObservedPullRequestFacts`
 * (`apps/api/lib/desktop-pull-request-facts.ts`, ISS-8423), which asks the same
 * question of the INGEST PAYLOAD, where every field is optional and absence is
 * directly visible. The two are deliberately separate because a persisted row
 * cannot express the absence of a `NOT NULL` column; keep their field sets in
 * step, and change neither alone.
 *
 * Zod-free and dependency-light on purpose: bundle-sensitive client surfaces
 * import this predicate without pulling a validator in behind it.
 */
export function hasObservedPullRequestLifecycle(detail: {
  prState?: string | null;
  mergedAt?: Date | string | null;
  closedAt?: Date | string | null;
  githubCreatedAt?: Date | string | null;
}): boolean {
  return (
    detail.mergedAt != null ||
    detail.closedAt != null ||
    detail.prState === GitHubPRState.Merged ||
    detail.prState === GitHubPRState.Closed ||
    detail.githubCreatedAt != null
  );
}

/**
 * Whether a persisted pull-request row observed ANYTHING — the read-side twin of
 * `DESKTOP_PR_DETAIL_OBSERVED_FACT` (`apps/api/lib/desktop-pull-request-facts.ts`,
 * ISS-8423), which asks the same question of the ingest payload.
 *
 * This is the test ISS-8422 actually needs, and it is BROADER than
 * {@link hasObservedPullRequestLifecycle}. The two answer different questions and
 * both are load-bearing: that one asks "may I trust `pr_state`" for the session
 * lane (#4021), where only lifecycle evidence counts; this one asks "is this
 * row the factless stub the desktop lane writes", whose whole content is the
 * server-derived `html_url`. A row carrying LOC, a title, or a review decision
 * was fetched from the provider, so its state is a reading rather than the
 * column default — narrowing this to lifecycle evidence alone reclassified such
 * rows as unwitnessed and handed their branch's selection to a merged sibling.
 *
 * `prState` and `isDraft` are excluded AS COLUMNS: both are `NOT NULL` with a
 * default, so their mere presence proves nothing. A value the default cannot
 * PRODUCE is a different matter, and there are two — a terminal `prState`, and
 * an `isDraft` of `true` against a `false` default. Both are readings. The
 * ingest twin classifies `isDraft` as an observed fact for exactly that reason
 * (`DESKTOP_PR_DETAIL_OBSERVED_FACT`), and excluding it here let the Draft list
 * filter select on `is_draft = TRUE` for rows this predicate had already called
 * unwitnessed (davetho review on #6313).
 */
export function hasObservedPullRequestEvidence(detail: {
  prState?: string | null;
  isDraft?: boolean | null;
  title?: string | null;
  reviewDecision?: string | null;
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
  mergedAt?: Date | string | null;
  closedAt?: Date | string | null;
  githubCreatedAt?: Date | string | null;
}): boolean {
  return (
    hasObservedPullRequestLifecycle(detail) ||
    detail.isDraft === true ||
    detail.title != null ||
    detail.reviewDecision != null ||
    detail.additions != null ||
    detail.deletions != null ||
    detail.changedFiles != null
  );
}
