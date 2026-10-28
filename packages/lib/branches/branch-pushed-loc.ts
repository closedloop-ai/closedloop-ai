/**
 * @file branch-pushed-loc.ts
 * @description The Branches LOC numerator: lines pushed to origin, and nothing
 * else (ISS-9956, ISS-9957, ISS-9958).
 *
 * Split from `branch-list-metrics.ts` on the same seam `branch-cost-evidence.ts`
 * took: everything here answers "which publication evidence names a push", while
 * the kernel answers "what does each tile publish".
 *
 * WHY THE FILTER RUNS BEFORE RECONCILIATION. `reconcileBranchPublicationLoc`
 * fuses a push and a merged-PR observation of one commit into a single row and
 * drops `source` doing it, so after reconciliation the two lanes are
 * indistinguishable. Filtering first keeps a commit that was both pushed and
 * merged exactly once, while keeping pushed-but-unmerged lines a merged-only
 * count never sees.
 *
 * That single-count used to rest on the two arms sharing a `repo:sha` change
 * identity. ISS-10009 part 2 changed the producer: a captured push now carries
 * a RANGE identity (`repo:before..after`), and the cloud producer drops the
 * merged-PR row whose head sha a push already names. So the arms no longer meet
 * in reconciliation at all — the drop happens upstream, and the filter here
 * still selects exactly the push lane.
 */
import {
  type BranchMetricLocContribution,
  BranchPublicationLocSource,
  branchPublicationChangeIdentity,
  branchPublicationLocIsWellFormed,
} from "./branch-publication-loc";

/**
 * The contributions that name a successful push to origin AND survive
 * reconciliation's validity check.
 *
 * Well-formedness is part of "is this push evidence", not a later filter: a
 * malformed push row is dropped by `reconcileBranchPublicationLoc`, so treating
 * it as evidence here would claim a push the total can never account for.
 */
export function pushedLocContributions(
  contributions: readonly BranchMetricLocContribution[]
): BranchMetricLocContribution[] {
  return contributions.filter(
    (contribution) =>
      contribution.source === BranchPublicationLocSource.SuccessfulPush &&
      branchPublicationLocIsWellFormed(contribution)
  );
}

/**
 * The change identities a PROVEN push observation carries.
 *
 * Built from well-formed push rows only. A malformed push is dropped by
 * reconciliation, so crediting its identity would hand the push arm a merged
 * sibling's lines: the merged row survives reconciliation, matches the
 * identity, and its LOC is then summed as pushed (davetho review).
 */
export function pushedChangeIdentities(
  contributions: readonly BranchMetricLocContribution[]
): Set<string> {
  return new Set(
    pushedLocContributions(contributions).map(branchPublicationChangeIdentity)
  );
}

/**
 * Whether the push arm accounts for every code change this evidence names that
 * can affect the selected window.
 *
 * A merged-PR row whose change identity no push row carries is a real published
 * change the push-only total omits, so the total is short — short by a knowable
 * amount, which is a Partial, not a Complete with a smaller number. Without this
 * the existing coverage flag would call such a cohort complete, because it was
 * computed for the push-OR-merge evidence rather than for the push arm alone.
 *
 * Scoped by `affectsWindow` because the verdict is about THIS window's total: an
 * older merged-only row cannot change it, so letting it turn a fully covered
 * window Partial discloses a gap that is not there (whitlockk review). Evidence that
 * cannot be placed in time is reported as affecting every window, so unplaceable
 * records still count against completeness rather than being assumed elsewhere.
 *
 * An untagged or malformed contribution counts against completeness for the same
 * reason: a producer predating {@link BranchPublicationLocSource} says nothing
 * about which lane it observed, and an unproven lane is not a proven push.
 */
export function pushedLocEvidenceIsComplete(
  contributions: readonly BranchMetricLocContribution[],
  affectsWindow: (contribution: BranchMetricLocContribution) => boolean
): boolean {
  const pushedIdentities = pushedChangeIdentities(contributions);
  return contributions
    .filter(affectsWindow)
    .every((contribution) =>
      pushedIdentities.has(branchPublicationChangeIdentity(contribution))
    );
}

/**
 * Whether this evidence carries any push observation at all.
 *
 * The desktop local projection emits merged-PR contributions only, so its push
 * arm is empty for every cohort. Summing that to `0` would publish "nothing was
 * pushed" from evidence that cannot speak to pushes — a fabricated figure under
 * a pushed basis, which is the one outcome these tickets exist to prevent. The
 * caller renders the metric unavailable instead.
 */
export function hasPushedLocEvidence(
  contributions: readonly BranchMetricLocContribution[]
): boolean {
  return pushedLocContributions(contributions).length > 0;
}
