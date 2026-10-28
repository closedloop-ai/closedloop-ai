// Display vocabulary for a branch's CI-check rollup (`ChecksStatus`).
//
// Lightweight by design: one map, no parsers or validators, so the broad
// `"use client"` surfaces that render checks can import it without dragging a
// heavier module into their bundle.
//
// Two surfaces read it: `BranchChecksStatusValue` (branch-checks-status-value.tsx)
// tones the `passed/total` tally for the Branches grid and the Branch Details
// row, and the pull-request picker row states the rollup in words because it
// has no counts to tone.

import {
  CheckRowOutcomeBucket,
  checkRowOutcomeBucket,
  isWholeMeasuredPopulation,
} from "@repo/api/src/types/branch-check-projection";
import { ChecksStatus } from "@repo/api/src/types/branch-checks";
import type { ToneLabelVariant } from "@repo/design-system/components/ui/tone-label";

// FEA-4066: the CI-check rollup takes its color from the SAME `Badge`/`Chip`
// variant vocabulary the Status column uses (SSOT), so a failing build reads as
// destructive and a green one as success instead of the same neutral gray.
// Unknown/absent status falls through to the neutral `default` tone.
export const CHECKS_STATUS_VARIANT: Record<ChecksStatus, ToneLabelVariant> = {
  [ChecksStatus.Passing]: "success",
  [ChecksStatus.Failing]: "destructive",
  [ChecksStatus.Pending]: "warning",
  [ChecksStatus.Unknown]: "default",
};

/**
 * ISS-8155: the rollup stated in words, for a surface with no `passed/total`
 * tally to attach a tone to.
 *
 * `Unknown` is a MEASURED answer — the provider reported no conclusion — and is
 * deliberately not the same string as an ABSENT `checksStatus`, which means no
 * producer reached this PR at all. Collapsing the two is the fabrication the
 * absent-value contract exists to stop, so the absent case has its own label
 * below rather than borrowing this one.
 */
export const CHECKS_STATUS_LABEL: Record<ChecksStatus, string> = {
  [ChecksStatus.Passing]: "Checks passing",
  [ChecksStatus.Failing]: "Checks failing",
  [ChecksStatus.Pending]: "Checks pending",
  [ChecksStatus.Unknown]: "Checks unknown",
};

/** No producer reported a rollup — distinct from a reported `Unknown`. */
export const CHECKS_STATUS_UNREPORTED_LABEL = "Checks not reported";

/**
 * ISS-8241: the two measured NON-conclusions, which are facts about a revision
 * rather than absences and must not borrow `CHECKS_STATUS_UNREPORTED_LABEL`.
 *
 * A provider that returned an empty population measured this pull request and
 * found nothing to run; a provider read that FAILED measured nothing at all and
 * leaves the stored rollup describing some earlier head. Rendering either as
 * "not reported" would tell a reader nobody had looked, and rendering the failed
 * read as "unknown" would present a stale conclusion as this head's.
 */
export const CHECKS_POPULATION_EMPTY_LABEL = "No checks on this revision";

/** A measured read the provider failed — no rollup from it can be believed. */
export const CHECKS_PROVIDER_UNAVAILABLE_LABEL = "Checks could not be read";

/**
 * ISS-8241: a producer DID reach this head, the read came back `available`, and
 * it counted a non-empty population — but none of its rows reached the render.
 *
 * Not the same fact as either neighbour above: somebody looked, so "not
 * reported" would be wrong, and the read did not fail, so "could not be read"
 * would be wrong too. Nothing is shown beneath this line, because there is
 * nothing to show — the rows the count promised are the very thing missing, so
 * this names that gap rather than a merely absent verdict over a visible list.
 */
export const CHECKS_ROLLUP_UNREPORTED_LABEL = "Checks outcome not reported";

/** The provider recorded no status or conclusion for one check row. */
export const CHECK_ROW_OUTCOME_UNRECORDED_LABEL = "No outcome recorded";

/**
 * One check row's outcome, in this product's words and tone.
 *
 * The stored projection keeps GitHub's OWN vocabulary (uppercased by
 * `normalizeProviderStatus`): a check run carries a `conclusion` once it
 * finishes and only a `status` while it runs, and a status context carries a
 * `state` in `status` with no conclusion at all. This maps that vocabulary onto
 * the same words the live selected-PR panel uses, so the two renders of the same
 * check never disagree about whether it passed.
 *
 * A word this map does not know is NOT quietly classified. It renders as itself
 * at the neutral tone, because guessing which bucket an unrecognized provider
 * outcome belongs in is how a failing check comes to read as a passing one.
 */
export function checkRowOutcome(
  status: string | null,
  conclusion: string | null
): { label: string; variant: ToneLabelVariant } {
  const reported = conclusion ?? status;
  if (!reported) {
    return { label: CHECK_ROW_OUTCOME_UNRECORDED_LABEL, variant: "default" };
  }
  const bucket = checkRowOutcomeBucket(status, conclusion);
  return {
    label: CHECK_ROW_OUTCOME_LABEL[reported.trim().toUpperCase()] ?? reported,
    variant: bucket ? CHECK_ROW_BUCKET_VARIANT[bucket] : "default",
  };
}

/**
 * The tone each bucket reads at. Exhaustive over the bucket union on purpose —
 * a bucket added upstream must fail typecheck here rather than fall to a
 * neutral tone that would render a new failure class as an unremarkable row.
 */
export const CHECK_ROW_BUCKET_VARIANT: Record<
  CheckRowOutcomeBucket,
  ToneLabelVariant
> = {
  [CheckRowOutcomeBucket.Passed]: "success",
  [CheckRowOutcomeBucket.Failed]: "destructive",
  [CheckRowOutcomeBucket.Pending]: "warning",
  [CheckRowOutcomeBucket.Inconclusive]: "default",
};

/**
 * This product's word for each provider outcome. The SEVERITY of these words is
 * not stated here — `checkRowOutcomeBucket` owns that, and the API's rollup fold
 * reads the same table, so a row's tone and the headline over it cannot
 * disagree. This map only decides how each one is spelled; a word it lacks
 * renders as the provider's own.
 */
const CHECK_ROW_OUTCOME_LABEL: Record<string, string> = {
  SUCCESS: "Passed",
  FAILURE: "Failed",
  ERROR: "Failed",
  TIMED_OUT: "Timed out",
  ACTION_REQUIRED: "Action required",
  STARTUP_FAILURE: "Failed to start",
  CANCELLED: "Canceled",
  SKIPPED: "Skipped",
  STALE: "Stale",
  NEUTRAL: "Neutral",
  QUEUED: "Pending",
  IN_PROGRESS: "Pending",
  PENDING: "Pending",
  EXPECTED: "Pending",
  WAITING: "Pending",
  REQUESTED: "Pending",
};

/**
 * ISS-8629: a CAPPED list, whose recorded total is a floor rather than the
 * population.
 *
 * Stated without a count on purpose. The short-list sentence below carries
 * "N of M" because M is the population; here M is only what got stored before
 * the producer stopped, so the one thing that can honestly be said is that more
 * exist than are listed. The tally above already states how many are in hand.
 */
export const CHECKS_POPULATION_CAPPED_LABEL =
  "Recorded list capped — more checks than are listed";

/**
 * ISS-8629: why the summary above is not a verdict over the whole population,
 * or `null` where it is one.
 *
 * TWO shortfalls, two sentences, neither borrowing the other's — the same rule
 * the four non-answers above follow. A SHORT list knows its own total and says
 * how much of it is in hand. A list the producer CAPPED at its own count cannot
 * use those words: "2 of 2 recorded checks" tells a reader everything is here
 * while the withheld tone beside it says the opposite.
 *
 * This sentence is load-bearing, not decoration. `ToneLabel` is a text colour,
 * so where the passing tone is withheld this is the only statement of that fact
 * a sighted reader gets, and — through the trigger's `aria-describedby` — the
 * only one in the accessibility tree (WCAG 1.4.1). It is emitted from the same
 * predicate that withholds the tone, so a withheld tone cannot render without
 * it.
 *
 * A population reporting MORE rows than it counted is neither shortfall, and the
 * capped branch tests `===` rather than `>=` so it cannot swallow one. It keeps
 * the counted sentence, which then reads "3 of 1" — visibly impossible data,
 * which is the honest render of it and better than either caveat.
 * `checks_detail_total_count` is an unconstrained persisted `Int`, so this is
 * reachable from bad stored state rather than a type-forbidden shape.
 *
 * Kaito's ruling of 2026-08-31 settles the TONE and does not word these; both
 * say only what the data supports, so either can be reworded without reopening
 * it.
 */
export function checksPopulationShortfall(population: {
  truncated: boolean;
  totalCount: number;
  items: readonly unknown[];
}): string | null {
  if (isWholeMeasuredPopulation(population)) {
    return null;
  }
  if (
    population.truncated &&
    population.items.length === population.totalCount
  ) {
    return CHECKS_POPULATION_CAPPED_LABEL;
  }
  return `${population.items.length} of ${population.totalCount} recorded checks`;
}
