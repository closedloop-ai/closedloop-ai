/**
 * @file artifact-status-rank.ts
 * @description The semantic ORDER over the normalized artifact-status vocabulary
 * (PRD-714 / ISS-9437): one rank per displayed root, DERIVED from the declaration order
 * of {@link DISPLAYED_ARTIFACT_STATUS} rather than written out.
 *
 * `artifact-status.ts` deliberately left this underived and named ISS-9437 as the
 * ticket that decides how roots and raw values order against each other. This module is
 * the root half of that answer. The raw half is unchanged: `statusDisplayRank`
 * (`./artifact-status-display-order.ts`) stays the one rank for raw
 * Document/Issue values, and `branchStatusRank` (`./branch-status-order.ts`) stays the
 * one rank for `BranchStatus`. Both are the TIEBREAK under a root, never replaced.
 *
 * Imports `./artifact-status.ts` and nothing else, so a bundle-sensitive `"use client"`
 * sort path can order by root without pulling zod in through the vocabulary modules —
 * the same property `artifact-status-display.ts` has, pinned the same way by
 * `artifact-status-rank.zod-free.test.ts`.
 *
 * ## A rank alone cannot keep `unknown` last
 *
 * The declaration order already puts `unknown` after every real root. What it cannot do
 * is survive a descending sort: a comparator that negates a rank delta flips the
 * unknown row to the TOP, which is exactly what the Documents Status column does today.
 * ISS-9437 rules that unknown placement resolves BEFORE direction — last on ascending
 * AND descending — so callers take {@link artifactStatusRootRankOrNull} and hand it to
 * `compareNullableNumber` (`@repo/lib/sort-comparators`), whose null handling returns
 * before the direction sign is applied.
 *
 * Branches route a null rank through their existing compareMissing helper.
 * D5 Sessions uses this nullable rank in the cloud and local list comparators;
 * both decide unknown placement before applying direction.
 */

import type { DisplayedArtifactStatus } from "./artifact-status.js";
import { DISPLAYED_ARTIFACT_STATUS } from "./artifact-status.ts";

/**
 * Rank per displayed root, lowest first, in declaration order: todo, in_progress,
 * in_review, done, canceled, unknown.
 *
 * Never hand-written. ISS-9437's ruling is that the declaration order IS the semantic
 * order, so a literal array here would be a second statement of it that could disagree.
 */
export const ARTIFACT_STATUS_ROOT_RANK: Readonly<
  Record<DisplayedArtifactStatus, number>
> = Object.freeze(
  // `Object.fromEntries` widens its key type to `string`, so it cannot express the
  // exhaustive Record this module promises. The cast is sound BECAUSE the entries come
  // from `Object.values(DISPLAYED_ARTIFACT_STATUS)` — every member, and only members —
  // and `artifact-status-rank.test.ts` asserts that exhaustiveness independently, so a
  // root added later fails a test rather than silently ranking as unknown.
  Object.fromEntries(
    Object.values(DISPLAYED_ARTIFACT_STATUS).map((root, index) => [root, index])
  ) as Record<DisplayedArtifactStatus, number>
);

const UNKNOWN_ROOT_RANK =
  ARTIFACT_STATUS_ROOT_RANK[DISPLAYED_ARTIFACT_STATUS.Unknown];

/**
 * Where a root belongs in the semantic order. An unrecognized value and a nullish one
 * both rank with `unknown`, after every real root — matching the fold contract in
 * `./artifact-status-mapping.ts`, where nothing unrecognized is ever given a real root.
 */
export function artifactStatusRootRank(
  root: string | null | undefined
): number {
  if (root != null && Object.hasOwn(ARTIFACT_STATUS_ROOT_RANK, root)) {
    return ARTIFACT_STATUS_ROOT_RANK[root as DisplayedArtifactStatus];
  }
  return UNKNOWN_ROOT_RANK;
}

/**
 * The same rank, reporting `unknown` as `null` so a caller can park it last in BOTH
 * directions through `compareNullableNumber` instead of negating it to the top on a
 * descending sort. See the file header.
 */
export function artifactStatusRootRankOrNull(
  root: string | null | undefined
): number | null {
  const rank = artifactStatusRootRank(root);
  return rank === UNKNOWN_ROOT_RANK ? null : rank;
}
