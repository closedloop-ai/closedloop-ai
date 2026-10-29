/**
 * ISS-4704's section packing, shared by the browser and `apps/api` (ISS-10472).
 *
 * Here rather than in `@repo/app` because the assigned tree WILL page its root
 * groups server-side while `DocumentsView` keeps packing the legacy streams in
 * the browser. Two copies of this arithmetic would put a section on page 2
 * server-side and page 3 client-side, which is the skipped-or-duplicated row
 * the paging work exists to remove.
 *
 * {@link planSectionPages} is the primitive and takes SIZES, not ids, because
 * the server plans over the whole corpus and may only load the page it serves —
 * reading every root id into Node to pack them is the thing root-group paging
 * exists to stop. {@link packSectionsIntoPages} is the id-carrying wrapper the
 * browser keeps using, so there is one algorithm with two entry points.
 */

/** One rendered group section, in the order its surface renders sections. */
export type OrderedSection = {
  /** Matches `GroupSectionDescriptor.key`, so a renderer can look a total up. */
  key: string;
  ids: string[];
};

/** One section's size, in section order. The planner's input. */
export type SectionSize = {
  key: string;
  size: number;
};

/** The rows one page takes from one section. */
export type SectionSlice = {
  key: string;
  /** Rows of this section already placed on earlier pages. */
  skip: number;
  take: number;
};

/** One planned page, as slices of the sections it draws from. */
export type SectionPlanSlicePage = {
  slices: SectionSlice[];
  /**
   * Section keys whose rows began on an EARLIER page. Only a section larger
   * than one page can produce one, so this set is empty on a board whose
   * sections all fit.
   */
  continuedSectionKeys: Set<string>;
};

/** One page of a {@link SectionPagePlan}. */
export type SectionPlanPage = {
  /** Ordered root-group / flat-row ids that make up this page. */
  ids: string[];
  continuedSectionKeys: Set<string>;
};

/**
 * A section-aware page plan for a GROUPED surface.
 *
 * `sectionTotals` is each section's size over the FULL list, which is the
 * population a header's count claims to be. Without it a renderer has only the
 * page's own subset, and printing that beside the label states a page slice as
 * the population.
 */
export type SectionPagePlan = {
  pages: SectionPlanPage[];
  /** Each section's true size over the full unpaged list, by section key. */
  sectionTotals: Map<string, number>;
};

/** {@link SectionPagePlan}, as slices rather than ids. */
export type SectionSlicePlan = {
  pages: SectionPlanSlicePage[];
  sectionTotals: Map<string, number>;
};

/**
 * Greedily pack whole sections onto pages. Page row-counts become variable —
 * that is the cost of keeping a section under one header — and every row still
 * lands on exactly one page, so the corpus stays wholly reachable.
 */
export function planSectionPages(
  sections: readonly SectionSize[],
  pageSize: number
): SectionSlicePlan {
  // Floor at 1: a 0 or negative size would make every section "oversized" and
  // loop without ever placing a row (repo numeric-input guardrail).
  const size = Math.max(1, Math.floor(pageSize));
  const pages: SectionPlanSlicePage[] = [];
  const sectionTotals = new Map<string, number>();
  let open = emptySlicePage();
  let openCount = 0;

  for (const section of sections) {
    assertPlannableSection(section, sectionTotals);
    sectionTotals.set(section.key, section.size);
    if (openCount > 0 && openCount + section.size > size) {
      pages.push(open);
      open = emptySlicePage();
      openCount = 0;
    }
    let taken = 0;
    while (taken < section.size) {
      if (openCount >= size) {
        pages.push(open);
        open = emptySlicePage();
        openCount = 0;
        open.continuedSectionKeys.add(section.key);
      }
      const take = Math.min(size - openCount, section.size - taken);
      open.slices.push({ key: section.key, skip: taken, take });
      openCount += take;
      taken += take;
    }
  }
  if (openCount > 0) {
    pages.push(open);
  }
  return { pages, sectionTotals };
}

/**
 * {@link planSectionPages} with the ids filled in.
 *
 * The browser already holds every row, so it packs ids directly; the plan is
 * still what decides the boundaries, so the two surfaces cut in the same place.
 */
export function packSectionsIntoPages(
  sections: readonly OrderedSection[],
  pageSize: number
): SectionPagePlan {
  const idsByKey = new Map(
    sections.map((section) => [section.key, section.ids])
  );
  const plan = planSectionPages(
    sections.map((section) => ({ key: section.key, size: section.ids.length })),
    pageSize
  );
  return {
    pages: plan.pages.map((page) => ({
      continuedSectionKeys: page.continuedSectionKeys,
      ids: page.slices.flatMap((slice) =>
        (idsByKey.get(slice.key) ?? []).slice(
          slice.skip,
          slice.skip + slice.take
        )
      ),
    })),
    sectionTotals: plan.sectionTotals,
  };
}

function emptySlicePage(): SectionPlanSlicePage {
  return { slices: [], continuedSectionKeys: new Set<string>() };
}

/**
 * Both failures are silent downstream, which is why they stop here rather than
 * at a caller: a duplicate key makes {@link packSectionsIntoPages} draw the
 * section's rows from the LAST section sharing it, and a `size` outside the
 * counting integers places a `take` no caller can slice with. `apps/api` plans
 * from SQL counts, where a `bigint` or a `NaN` is reachable input (ISS-10472).
 */
function assertPlannableSection(
  section: SectionSize,
  planned: ReadonlyMap<string, number>
): void {
  if (planned.has(section.key)) {
    throw new Error(`planSectionPages: duplicate section key "${section.key}"`);
  }
  if (!Number.isSafeInteger(section.size) || section.size < 0) {
    throw new Error(
      `planSectionPages: section "${section.key}" size must be a non-negative safe integer, got ${String(section.size)}`
    );
  }
}
