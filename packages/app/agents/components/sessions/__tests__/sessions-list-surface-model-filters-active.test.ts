import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { describe, expect, it } from "vitest";
import { resolveSessionsFiltersActive } from "../sessions-list-surface-model";

/**
 * ISS-9107 — an explicit `?from=`/`?to=` window counts as a narrower.
 *
 * Uncounted, a window that matched nothing leaves `filtersActive` false, so the
 * body hands the empty state `hasActiveFilters: false` and a reader with plenty
 * of sessions is told they have none — with no "Clear filters" way back. On the
 * server arm that is unrecoverable: `listNarrowed` IS `filtersActive` there, so
 * nothing else could catch the narrowing.
 */

const INACTIVE = {
  customWindowActive: false,
  dateRange: DEFAULT_DATE_RANGE,
  facets: DEFAULT_SESSION_FACET_FILTERS,
  scopeUserId: null,
  search: "",
};

describe("resolveSessionsFiltersActive custom window (ISS-9107)", () => {
  it.each([true, false])(
    "counts an explicit window with every other axis inactive (isServerDriven=%s)",
    (isServerDriven) => {
      expect(
        resolveSessionsFiltersActive({
          ...INACTIVE,
          customWindowActive: true,
          isServerDriven,
        })
      ).toBe(true);
    }
  );

  // The negative sibling: with nothing narrowing, the empty state must stay the
  // genuinely-empty one, or every list would offer a "Clear filters" that clears
  // nothing.
  it.each([true, false])(
    "reports nothing active when no window and no other narrower (isServerDriven=%s)",
    (isServerDriven) => {
      expect(
        resolveSessionsFiltersActive({ ...INACTIVE, isServerDriven })
      ).toBe(false);
    }
  );
});
