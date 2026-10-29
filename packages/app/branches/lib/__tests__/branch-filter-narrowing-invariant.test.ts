/**
 * ISS-4503: the logical-QA pack's MONOTONICITY invariant, held against the
 * production Branches list filter.
 *
 * "Narrowing a filter never increases an included count" is the one pack rule a
 * reader can check without leaving the screen, and the one a facet predicate
 * can break silently: every facet in `matchesBranchFilters` is `length === 0 ||
 * <arm>`, so an arm that answers a selection with `true` where it meant to
 * answer `false` turns a narrowing into a widening and the row count climbs as
 * the user adds constraints.
 *
 * BOTH ARMS, because `matchesBranchFilters` is two predicates behind one name.
 * Its `approved` parameter switches the Repository arm between `row.repo` and
 * `shortRepoName(row.repo)`, and the Owner arm between `row.ownerKey ?? owner`
 * and `row.owner`. Both Branches hosts pass `true`
 * (`apps/app/app/(authenticated)/[orgSlug]/branches/page.tsx:401`,
 * `apps/desktop/src/renderer/components/branches/branches-view.tsx:411`), and
 * `facetRows` in `branch-filter-adapter.tsx` hard-codes `approved: true` while
 * building the menu from full repo names and owner keys — so the selections the
 * rendered table sends are the approved shapes. The legacy arm stays reachable
 * (`filterBranchRows` defaults `approved` to `false`), so the invariant runs
 * under both rather than moving from one to the other.
 *
 * The corpus is built so no single facet selects the whole set and no chained
 * step is a no-op, because a chain whose steps do not actually narrow passes
 * under any predicate.
 */

import {
  type BranchFilters,
  type BranchRow,
  BranchRowStatus,
  DEFAULT_BRANCH_FILTERS,
  filterBranchRows,
} from "@repo/app/branches/lib/branch-row";
import { describe, expect, it } from "vitest";
import { branchRow } from "./branch-row-fixture";

/** Pinned so a facet that consults the clock cannot move the counts. */
const NOW = Date.parse("2026-09-25T00:00:00.000Z");

/**
 * Two owners, two repos and two statuses, arranged so each facet splits the
 * corpus rather than selecting all of it. Six rows, and every chained step
 * below removes at least one.
 *
 * Every row carries BOTH identities the two arms read: a display `owner` and a
 * provider-qualified `ownerKey` that is not equal to it, and a full
 * `acme/<name>` repo whose short form differs. A fixture where the two agree
 * cannot tell the arms apart.
 */
const CORPUS: BranchRow[] = [
  branchRow({
    id: "b1",
    owner: "Avery",
    ownerKey: "closedloop:u-avery",
    repo: "acme/web",
  }),
  branchRow({
    id: "b2",
    owner: "Avery",
    ownerKey: "closedloop:u-avery",
    repo: "acme/web",
  }),
  branchRow({
    id: "b3",
    owner: "Briar",
    ownerKey: "closedloop:u-briar",
    repo: "acme/web",
  }),
  branchRow({
    id: "b4",
    owner: "Avery",
    ownerKey: "closedloop:u-avery",
    repo: "acme/api",
  }),
  branchRow({
    id: "b5",
    owner: "Briar",
    ownerKey: "closedloop:u-briar",
    repo: "acme/api",
    status: BranchRowStatus.Merged,
  }),
  branchRow({
    id: "b6",
    owner: "Avery",
    ownerKey: "closedloop:u-avery",
    repo: "acme/web",
    status: BranchRowStatus.Merged,
  }),
];

/**
 * The two predicates `matchesBranchFilters` switches between, each paired with
 * the facet values that arm's menu actually offers. The counts are identical by
 * construction — the same six rows, selected through whichever identity the arm
 * reads — so a difference between the modes is the defect, not the fixture.
 */
const MODES = [
  {
    approved: true,
    name: "approved",
    ownerFacet: "closedloop:u-avery",
    repoFacet: "acme/web",
  },
  {
    approved: false,
    name: "legacy",
    ownerFacet: "Avery",
    repoFacet: "web",
  },
] as const;

function withFacets(overrides: Partial<BranchFilters>): BranchFilters {
  return { ...DEFAULT_BRANCH_FILTERS, ...overrides };
}

describe.each(MODES)(
  "ISS-4503 invariant ($name arm): narrowing a filter never increases an included count",
  ({ approved, ownerFacet, repoFacet }) => {
    function countMatching(filters: BranchFilters): number {
      return filterBranchRows(CORPUS, filters, { approved, now: NOW }).length;
    }

    function chain() {
      return {
        byStatus: countMatching(
          withFacets({ statuses: [BranchRowStatus.Open] })
        ),
        byStatusAndRepo: countMatching(
          withFacets({ repos: [repoFacet], statuses: [BranchRowStatus.Open] })
        ),
        byStatusRepoAndOwner: countMatching(
          withFacets({
            owners: [ownerFacet],
            repos: [repoFacet],
            statuses: [BranchRowStatus.Open],
          })
        ),
        unfiltered: countMatching(DEFAULT_BRANCH_FILTERS),
      };
    }

    it("never grows the cohort as facets are added one at a time", () => {
      const { unfiltered, byStatus, byStatusAndRepo, byStatusRepoAndOwner } =
        chain();

      // Literal counts, read off the corpus above rather than re-derived from
      // the predicate under test: four Open rows, three of them in `acme/web`,
      // two of those owned by Avery.
      expect(unfiltered).toBe(6);
      expect(byStatus).toBe(4);
      expect(byStatusAndRepo).toBe(3);
      expect(byStatusRepoAndOwner).toBe(2);

      // The invariant itself, over the same chain.
      expect(byStatus).toBeLessThanOrEqual(unfiltered);
      expect(byStatusAndRepo).toBeLessThanOrEqual(byStatus);
      expect(byStatusRepoAndOwner).toBeLessThanOrEqual(byStatusAndRepo);
    });

    it("makes every step of that chain a real narrowing, not a no-op", () => {
      const { unfiltered, byStatus, byStatusAndRepo, byStatusRepoAndOwner } =
        chain();

      // Without this the chain above would hold under a predicate that ignores
      // every facet, which is the exact failure the invariant exists to catch.
      expect(byStatus).toBeLessThan(unfiltered);
      expect(byStatusAndRepo).toBeLessThan(byStatus);
      expect(byStatusRepoAndOwner).toBeLessThan(byStatusAndRepo);
    });

    it("never grows the cohort when a value is dropped from an active facet", () => {
      const bothStatuses = countMatching(
        withFacets({ statuses: [BranchRowStatus.Open, BranchRowStatus.Merged] })
      );
      const oneStatus = countMatching(
        withFacets({ statuses: [BranchRowStatus.Open] })
      );

      expect(bothStatuses).toBe(6);
      expect(oneStatus).toBe(4);
      expect(oneStatus).toBeLessThanOrEqual(bothStatuses);
    });

    it("returns an empty cohort rather than the whole one for a facet nothing matches", () => {
      // The widening failure's loudest form: an unmatched selection that falls
      // through to "no constraint" and hands back every row.
      const unmatched = countMatching(withFacets({ repos: ["nothing-here"] }));

      expect(unmatched).toBe(0);
      expect(unmatched).toBeLessThanOrEqual(
        countMatching(DEFAULT_BRANCH_FILTERS)
      );
    });

    it("reads the identity its own arm selects on, not the other arm's", () => {
      // The counterfactual for the mode split itself: each arm must MISS the
      // other's facet value. Without it, one arm falling through to the other's
      // identity would leave every count above intact.
      const otherMode = MODES.find((mode) => mode.approved !== approved);
      // Asserted before it is read: an `?? ""` fallback would send `[""]`, which
      // matches nothing and lands on the same 0 whether the lookup worked or
      // not, so a failed lookup would pass silently (marisolashgrove, review).
      expect(otherMode).toBeDefined();

      expect(countMatching(withFacets({ repos: [otherMode!.repoFacet] }))).toBe(
        0
      );
      expect(
        countMatching(withFacets({ owners: [otherMode!.ownerFacet] }))
      ).toBe(0);
    });
  }
);
