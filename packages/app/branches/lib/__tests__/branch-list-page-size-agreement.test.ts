import { BRANCH_LIST_SERVER_PAGE_SIZE_OPTIONS } from "@repo/api/src/types/branch-list-contract";
import {
  TABLE_PAGE_SIZE_OPTIONS,
  TABLE_PAGE_SIZE_OPTIONS_EXTENDED,
} from "@repo/design-system/components/ui/table-page-size-select";
import { describe, expect, it } from "vitest";
import { BRANCH_GRID_TABLE_V2_PAGE_SIZE_OPTIONS } from "../../hooks/use-branch-filter-state";

/**
 * ISS-9225 — the Branches list OFFERS one ladder and ACCEPTS a superset of it.
 *
 * Those were one array until that ticket: `branch-list-contract.ts` spelled
 * `[25, 50, 100]` a second time and the Branches footer read it, while Sessions'
 * read `TABLE_PAGE_SIZE_OPTIONS`, so the two lists could offer different choices
 * with nothing red. A single physical constant is not available across this
 * boundary — `packages/design-system` is gated from importing `@repo/api`, and
 * `packages/api` is consumed by `apps/api` routes and `apps/desktop`'s main
 * process, so it cannot import a `"use client"` UI module in the other
 * direction. This is where the two meet, and it is what fails when they stop
 * agreeing.
 *
 * ISS-9692 CHANGED what the first case asserts, deliberately. It used to read
 * `BRANCH_GRID_TABLE_V2_PAGE_SIZE_OPTIONS` as the set Branches OFFERS and pin it
 * to `[25, 50, 100]`. That constant is now an ACCEPTANCE set — what a
 * `?pageSize=` may carry and what the hook's state may hold — because the OFFER
 * became conditional on the `table-page-size-ladder` flag and therefore stopped
 * being expressible as a constant at all. Left pinned to the base ladder it did
 * not merely mis-document: `normalizeBranchPageSize` rejected a 250 or a 500, so
 * the footer offered the two large rungs and this surface silently refused them.
 * The offer's own coverage moved to where the offer now lives, on the rendered
 * options of `ListSurfacePaginationFooter`
 * (`packages/app/shared/components/__tests__/list-surface-pagination-footer.test.tsx`).
 */
describe("Branches page sizes", () => {
  it("accepts every rung the shared control can offer", () => {
    // Written out rather than mapped from the constant: a fixture that reads
    // the ladder it polices cannot fail when a rung is dropped from it.
    expect([...BRANCH_GRID_TABLE_V2_PAGE_SIZE_OPTIONS]).toStrictEqual([
      25, 50, 100, 250, 500,
    ]);
  });

  it("never accepts less than the control offers, on either ladder", () => {
    const unoffered = [
      ...TABLE_PAGE_SIZE_OPTIONS,
      ...TABLE_PAGE_SIZE_OPTIONS_EXTENDED,
    ].filter(
      (size) =>
        !(BRANCH_GRID_TABLE_V2_PAGE_SIZE_OPTIONS as readonly number[]).includes(
          size
        )
    );

    expect(unoffered).toStrictEqual([]);
    expect(TABLE_PAGE_SIZE_OPTIONS_EXTENDED.length).toBeGreaterThan(
      TABLE_PAGE_SIZE_OPTIONS.length
    );
  });

  it("accepts every rung the shared control offers, at the endpoint too", () => {
    // The client half above governs the URL and the hook's state; this is the
    // wire. Both ladders, because a flag-off client still deep-links a value a
    // flag-on session wrote.
    const unaccepted = TABLE_PAGE_SIZE_OPTIONS_EXTENDED.filter(
      (size) =>
        !(BRANCH_LIST_SERVER_PAGE_SIZE_OPTIONS as readonly number[]).includes(
          size
        )
    );

    expect(unaccepted).toStrictEqual([]);
    // Not vacuous: an empty ladder would satisfy the filter above forever.
    expect(TABLE_PAGE_SIZE_OPTIONS_EXTENDED.length).toBeGreaterThan(0);
  });
});
