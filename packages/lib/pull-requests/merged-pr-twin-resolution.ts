/**
 * Which of two `pull_request_detail` rows claiming ONE pull request represents
 * it, for every surface reporting merged PRs (ISS-11589). The pair is possible
 * because no unique constraint spans it: `@@unique([repositoryId, number])`
 * skips a null `repository_id`, and the partial unique that catches that row
 * excludes the App row.
 */

/** The fields the tie-break decides from. Identity is the caller's to supply. */
export type MergedPullRequestTwinRow = {
  /** Only the App/webhook path writes one, so its presence is the authority claim. */
  githubId?: string | null;
  additions: number | null;
  deletions: number | null;
};

type MergedPullRequestTwinResolution<Row> = {
  values: Row[];
  /** Rows with an empty identity key: the caller's population is short by this. */
  unidentifiedCount: number;
  /**
   * Identities whose rows disagreed on size with nothing here able to settle it,
   * so the winner stands on ARRIVAL ORDER. A caller that publishes a
   * completeness verdict must treat these as unreconciled: such a pair used to
   * be dropped and starred, and a tie-break that cannot name an authority has
   * not earned a complete figure (tamsinb review on #8237).
   */
  unsettledDisagreementCount: number;
};

/** A row carrying one count and not the other is half-projected, not a zero. */
export function mergedPullRequestLoc(
  row: MergedPullRequestTwinRow
): number | null {
  const additions = finiteCount(row.additions);
  const deletions = finiteCount(row.deletions);
  if (additions === null || deletions === null) {
    return null;
  }
  return additions + deletions;
}

/**
 * Dedupe twin rows by identity, keeping the winning ROW so callers retain every
 * field they selected. Sized beats unsized FIRST, then App-owned beats
 * repo-less, so a PR's size never depends on which row the query emitted first.
 *
 * **Authority over the diff stats and nothing else.** Two repo-less rows with
 * disagreeing counts leave the incumbent standing on arrival order, and no rule
 * here ranks any other field — so a caller reading one off the winner (a
 * lifecycle instant, say) is reading a field this never decided. That case is
 * REPORTED, in `unsettledDisagreementCount`, rather than hidden behind the
 * surviving row.
 */
export function resolveMergedPullRequestTwins<
  Row extends MergedPullRequestTwinRow,
>(
  rows: readonly Row[],
  identityOf: (row: Row) => string
): MergedPullRequestTwinResolution<Row> {
  const byIdentity = new Map<string, Row>();
  const unsettledIdentities = new Set<string>();
  let unidentifiedCount = 0;
  for (const row of rows) {
    const identity = identityOf(row);
    if (!identity) {
      unidentifiedCount += 1;
      continue;
    }
    const incumbent = byIdentity.get(identity);
    if (!incumbent) {
      byIdentity.set(identity, row);
      continue;
    }
    const verdict = compareTwins(incumbent, row);
    if (verdict.unsettled) {
      unsettledIdentities.add(identity);
    }
    if (verdict.candidateWins) {
      byIdentity.set(identity, row);
    }
  }
  return {
    values: [...byIdentity.values()],
    unidentifiedCount,
    unsettledDisagreementCount: unsettledIdentities.size,
  };
}

type MergedPullRequestTwinVerdict = {
  candidateWins: boolean;
  /** Both rows are sized and disagree, and no `githubId` separates them. */
  unsettled: boolean;
};

function compareTwins(
  incumbent: MergedPullRequestTwinRow,
  candidate: MergedPullRequestTwinRow
): MergedPullRequestTwinVerdict {
  const incumbentLoc = mergedPullRequestLoc(incumbent);
  const candidateLoc = mergedPullRequestLoc(candidate);
  if (incumbentLoc === null) {
    return { candidateWins: candidateLoc !== null, unsettled: false };
  }
  if (candidateLoc === null || candidateLoc === incumbentLoc) {
    return { candidateWins: false, unsettled: false };
  }
  if (Boolean(candidate.githubId) !== Boolean(incumbent.githubId)) {
    return { candidateWins: Boolean(candidate.githubId), unsettled: false };
  }
  return { candidateWins: false, unsettled: true };
}

/**
 * The declared `number | null` lies at this persistence boundary — an unselected
 * column or corrupt projection presents as `undefined`, `NaN` or `Infinity`, and
 * `=== null` alone produced a `NaN` KLOC. Negatives go too: `Number.isFinite(-5)`
 * is true, and no diff can drive a line count below zero.
 */
function finiteCount(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}
