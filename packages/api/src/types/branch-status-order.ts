import { BRANCH_STATUS_MAPPING } from "./artifact-status-mapping.ts";
import { artifactStatusRootRank } from "./artifact-status-rank.ts";
import { BranchStatus } from "./branch.ts";

/**
 * Canonical display order for {@link BranchStatus}, and the rank every branch
 * comparator sorts on.
 *
 * ISS-9666: sorting the Branches table by Status used to key on the LOCALIZED
 * DISPLAY LABEL — `BRANCH_STATUS_CONFIG[status].label` on the client,
 * `BRANCH_STATUS_LABELS[status]` on the server — compared with `localeCompare`.
 * That made row order a function of presentation strings: ascending Status read
 * "Changes requested, Closed, Draft, In review, Merged, Open", and renaming or
 * translating a single label silently reordered the table. Sort order is data.
 *
 * This is NOT a newly-invented ranking. It is `Object.values(BranchStatus)` —
 * the SAME expression `buildBranchServerPage` already feeds to its Status facet,
 * so the order a reader sorts by is the order they already see in the Status
 * filter menu, on both surfaces. Deriving it rather than restating it as a
 * literal array is what keeps the two from drifting, and
 * `packages/lib/branches/branch-list-page.test.ts` pins the agreement by
 * asserting the served facet options equal this order.
 */
export const BRANCH_STATUS_SORT_ORDER: readonly string[] =
  Object.values(BranchStatus);

const BRANCH_STATUS_RANKS = new Map<string, number>(
  BRANCH_STATUS_SORT_ORDER.map((status, index) => [status, index])
);

/**
 * Rank a branch status for sorting. A status outside the vocabulary — and a row
 * carrying none — ranks after every known one, matching how the Branches
 * comparators already place an unavailable value.
 */
export function branchStatusRank(status: string | null | undefined): number {
  if (!status) {
    return BRANCH_STATUS_SORT_ORDER.length;
  }
  return BRANCH_STATUS_RANKS.get(status) ?? BRANCH_STATUS_SORT_ORDER.length;
}

/**
 * The same six statuses as {@link BRANCH_STATUS_SORT_ORDER}, reordered so the canonical
 * artifact-status ROOT decides first (ISS-9437): draft, open, review, blocked, merged,
 * closed.
 *
 * Derived by STABLY sorting that same order on the root each status folds to through
 * {@link BRANCH_STATUS_MAPPING}. The stability is load-bearing and is why this is a
 * derivation rather than a second literal list: `open`, `review` and `blocked` all fold
 * to `in_review`, and a stable sort leaves them in their `Object.values(BranchStatus)`
 * order, so the existing per-vocabulary order IS the tiebreak by construction. Nothing
 * has to remember to keep two lists in step.
 *
 * The visible change is `draft` moving to the front — a draft PR is in progress, and
 * every other artifact surface already bands in-progress work before anything in review.
 */
export const BRANCH_STATUS_ROOT_FIRST_ORDER: readonly string[] = Object.freeze(
  [...Object.values(BranchStatus)].sort(
    (left, right) =>
      artifactStatusRootRank(BRANCH_STATUS_MAPPING[left].root) -
      artifactStatusRootRank(BRANCH_STATUS_MAPPING[right].root)
  )
);

const BRANCH_STATUS_ROOT_FIRST_RANKS = new Map<string, number>(
  BRANCH_STATUS_ROOT_FIRST_ORDER.map((status, index) => [status, index])
);

export const BranchStatusOrderingName = {
  Vocabulary: "vocabulary",
  RootFirst: "root_first",
} as const;
export type BranchStatusOrderingName =
  (typeof BranchStatusOrderingName)[keyof typeof BranchStatusOrderingName];

/**
 * A resolved Branches status ordering: the option order a Status facet renders, and the
 * rank its comparators sort on.
 *
 * The two travel together on ONE value because they are the same decision. They are two
 * separate derivations today — the facet is built inline from `Object.values(BranchStatus)`
 * in `buildBranchServerPage` while the comparators call {@link branchStatusRank} — and
 * they agree only because those two expressions happen to coincide. ISS-9666's invariant
 * is that the order a reader sorts by is the order they see in the filter menu; handing
 * both a single resolved value is what makes that structural.
 *
 * `rank` may return `null`, which the Branches comparators route through their existing
 * `compareMissing` — placing the row last on ascending AND descending, before any
 * direction negation.
 */
export type BranchStatusOrdering = Readonly<{
  name: BranchStatusOrderingName;
  order: readonly string[];
  rank: (status: string | null | undefined) => number | null;
}>;

/**
 * Today's ordering, unchanged, and the shape every caller gets when the ISS-9437 flag is
 * off or unresolved.
 *
 * `rank` is {@link branchStatusRank} itself and therefore never returns `null`: an
 * unrecognized or absent status still ranks at `BRANCH_STATUS_SORT_ORDER.length`, which
 * places it last on ascending and FIRST on descending. That is what the Branches table
 * does today, quirk included. Reproducing it exactly is the point — the flag-off path
 * must not move a single row, so the pre-existing descending oddity is preserved here
 * and corrected only in {@link ROOT_FIRST_BRANCH_STATUS_ORDERING}.
 */
export const DEFAULT_BRANCH_STATUS_ORDERING: BranchStatusOrdering =
  Object.freeze({
    name: BranchStatusOrderingName.Vocabulary,
    order: BRANCH_STATUS_SORT_ORDER,
    rank: branchStatusRank,
  });

export const ROOT_FIRST_BRANCH_STATUS_ORDERING: BranchStatusOrdering =
  Object.freeze({
    name: BranchStatusOrderingName.RootFirst,
    order: BRANCH_STATUS_ROOT_FIRST_ORDER,
    rank: rootFirstBranchStatusRank,
  });

/**
 * Pick the ordering for a resolved ISS-9437 flag value. The caller reads the flag and
 * calls this once; everything downstream receives a whole ordering rather than a boolean
 * it would have to re-interpret.
 */
export function branchStatusOrderingFor(
  rootFirstEnabled: boolean
): BranchStatusOrdering {
  return rootFirstEnabled
    ? ROOT_FIRST_BRANCH_STATUS_ORDERING
    : DEFAULT_BRANCH_STATUS_ORDERING;
}

/**
 * Rank in the root-first order, or `null` for a status the vocabulary does not name.
 *
 * `null` rather than a trailing number, because the Branches comparators hand a null
 * sort value to `compareMissing`, which returns BEFORE the direction negation and so
 * parks the row last whichever way the column is sorted. That is the placement ISS-9437
 * rules for an unknown status, and a trailing number cannot express it — which is
 * exactly why the two orderings differ here rather than sharing one rank function.
 */
function rootFirstBranchStatusRank(
  status: string | null | undefined
): number | null {
  if (!status) {
    return null;
  }
  return BRANCH_STATUS_ROOT_FIRST_RANKS.get(status) ?? null;
}
