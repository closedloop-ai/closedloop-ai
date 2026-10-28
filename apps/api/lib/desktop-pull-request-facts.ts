/**
 * ISS-8423 — what a desktop `pull_request` artifact ref may CLAIM about the row
 * it writes, and the one list the reconciler's stub predicate shares with it.
 *
 * Two different questions are asked of the same payload and they have different
 * answers, which is why both classifications live here rather than one being
 * derived from the other:
 *
 * - "did the desktop OBSERVE anything?" gates `lastVerifiedAt`, because PRD-683
 *   D2 admits every stamped row to the trusted-for-metrics population.
 * - "could a provider FETCH still fill anything?" gates `lastRefreshAttemptAt`,
 *   because that column is the reconciler's per-row retry clock and it is the
 *   emptiness of those columns that the reconciler's stub arm selects on.
 */
import type { GitHubPRState } from "@repo/api/src/types/github";

/** The desktop-known PullRequestDetail columns carried by a `pull_request` ref. */
export type DesktopPullRequestDetailData = {
  prState?: GitHubPRState;
  isDraft?: boolean;
  title?: string;
  htmlUrl?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  mergedAt?: Date;
  closedAt?: Date;
  baseRefName?: string;
};

/**
 * Every `DesktopPullRequestDetailData` key, classified as a fact the desktop
 * OBSERVED about the pull request or as identity the server derives itself.
 * `htmlUrl` is built from the trusted repo + number, so it is equally present on
 * a ref that observed nothing at all.
 *
 * A `Record` over the whole key set rather than an `htmlUrl` exclusion test: a
 * field added to `DesktopPullRequestDetailData` fails `tsc` here until it is
 * classified, and reading a server-derived value as a measurement is the exact
 * defect this guards.
 */
const DESKTOP_PR_DETAIL_OBSERVED_FACT: Record<
  keyof DesktopPullRequestDetailData,
  boolean
> = {
  prState: true,
  isDraft: true,
  title: true,
  htmlUrl: false,
  additions: true,
  deletions: true,
  changedFiles: true,
  mergedAt: true,
  closedAt: true,
  // ISS-8175: read out of gh's own "Creating pull request for <head> into
  // <base>" line at create time. A measurement the desktop took, not identity
  // the server rebuilt like `htmlUrl`.
  baseRefName: true,
};

/**
 * Every `DesktopPullRequestDetailData` key mapped to the `pull_request_detail`
 * column whose presence means the row is NO LONGER the stub this reconciler arm
 * exists to repair, or `null` when the key does not settle that question.
 *
 * Read the mapped set as "nothing to lose by fetching it", not as "a fetch could
 * write this column" — three keys below map to `null` despite a fetch being able
 * to fill something, for the two different reasons stated under them.
 *
 * This is the SSOT for the reconciler's stub predicate
 * (`desktopRowWithNoFetchableFactsSql` in `session-linked-targets.ts`, which
 * renders its column list from this map) AND for the producer's retry-clock
 * decision. They must agree: the producer declines to move
 * `lastRefreshAttemptAt` for exactly the rows that arm selects, and a copy of
 * this list in either place reopens ISS-8423 silently.
 *
 * `prState` and `isDraft` map to `null` even though they ARE observations
 * (above): both columns are NOT NULL with a default, so no SQL predicate can
 * tell a value the desktop measured from the default nobody measured. A
 * `state`-only ref is therefore verified by the producer AND still a stub to
 * the reconciler — right on both counts, because such a row still has no title,
 * no LOC and none of the twelve `head_repository_default_branch_*` columns that
 * cloud branch eligibility needs.
 */
const DESKTOP_PR_DETAIL_FETCHABLE_COLUMN: Record<
  keyof DesktopPullRequestDetailData,
  string | null
> = {
  title: "title",
  additions: "additions",
  deletions: "deletions",
  changedFiles: "changed_files",
  mergedAt: "merged_at",
  closedAt: "closed_at",
  prState: null,
  isDraft: null,
  htmlUrl: null,
  // ISS-8175. `null` here for a DIFFERENT reason than the two above:
  // `base_ref_name` IS nullable and a provider fetch DOES fill it
  // (`buildPullRequestDetailUpdate` writes it from `freshPr.baseBranch`), so on
  // the old wording it would map to its column. It does not, because mapping it
  // would strand the row it describes. A base ref satisfies none of the cloud
  // branch eligibility this arm repairs for — such a row still has no title, no
  // LOC and none of the twelve `head_repository_default_branch_*` columns — so
  // it is exactly as much a stub as the `state`-only ref above, and adding
  // `base_ref_name IS NULL` to the arm's conjunction would narrow it until that
  // row stopped being selected and never drained. It would also let the
  // producer re-stamp `lastRefreshAttemptAt` on every sync of an active
  // branch's created PR, which is the self-reinforcement ISS-8423 measured.
  baseRefName: null,
};

/** The `pull_request_detail` columns above, in declaration order. */
export const DESKTOP_PR_FETCHABLE_FACT_COLUMNS: readonly string[] =
  Object.values(DESKTOP_PR_DETAIL_FETCHABLE_COLUMN).filter(
    (column): column is string => column !== null
  );

/**
 * Whether the ref carried at least one observed fact. A write with none must not
 * stamp `lastVerifiedAt`: the row holds nothing but server-derived identity, its
 * `pr_state` reads the column default `OPEN` rather than a measurement, and
 * PRD-683 D2 admits every stamped row to the trusted-for-metrics population
 * (ISS-8423).
 */
export function hasObservedPullRequestFacts(
  facts: DesktopPullRequestDetailData
): boolean {
  return Object.keys(facts).some(
    (key) =>
      DESKTOP_PR_DETAIL_OBSERVED_FACT[key as keyof DesktopPullRequestDetailData]
  );
}

/**
 * Whether the ref carried a fact a provider fetch could otherwise have filled —
 * i.e. whether the row it writes is anything more than the stub the reconciler
 * exists to repair.
 */
export function hasFetchablePullRequestFacts(
  facts: DesktopPullRequestDetailData
): boolean {
  return Object.keys(facts).some(
    (key) =>
      DESKTOP_PR_DETAIL_FETCHABLE_COLUMN[
        key as keyof DesktopPullRequestDetailData
      ] !== null
  );
}

/**
 * The freshness columns a desktop write may advance. The two clocks are gated
 * SEPARATELY and both gates are load-bearing:
 *
 * `lastVerifiedAt` follows observation, because PRD-683 D2 admits every stamped
 * row to the trusted-for-metrics population and a row holding only
 * server-derived identity has measured nothing.
 *
 * `lastRefreshAttemptAt` follows FETCHABILITY, not observation, because that
 * column is the RECONCILER's per-row retry clock and this lane is an ingest,
 * not a refresh attempt. Writing it on a row the reconciler still classifies as
 * a stub is what made ISS-8423 self-reinforcing: an active branch re-observing
 * the same PR kept pushing its own stub back out of the reconciler's window, so
 * the more the branch was worked on the longer its PR stayed empty. A
 * `state`-only ref hits that path too, which is why the gate here is the
 * fetchable set and not the observed one (whitlockk review, 2026-08-28).
 *
 * Both are OMITTED, never written as null, so a factless re-sync cannot erase
 * an earlier fact-carrying verification or a reconciler attempt it knows
 * nothing about.
 */
export function desktopFreshnessStamps(
  facts: DesktopPullRequestDetailData,
  observedAt: Date
): { lastVerifiedAt?: Date; lastRefreshAttemptAt?: Date } {
  return {
    ...(hasObservedPullRequestFacts(facts)
      ? { lastVerifiedAt: observedAt }
      : {}),
    ...(hasFetchablePullRequestFacts(facts)
      ? { lastRefreshAttemptAt: observedAt }
      : {}),
  };
}
