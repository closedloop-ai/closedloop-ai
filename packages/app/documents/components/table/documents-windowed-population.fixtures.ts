import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import { SlugPrefix } from "@repo/api/src/types/slug-prefix";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import {
  buildTableViewPagePlan,
  pageTableView,
} from "@repo/app/documents/lib/table-view-pagination";
import { makeArtifact } from "@repo/app/shared/test-fixtures/documents";

/**
 * A grouped population paged by the same section-aware plan the paged callers
 * use (PRD-720, ISS-12462), so a story's band counts and continued marks come
 * from the plan rather than being written by hand. With these sizes and page
 * size, page 1 opens with the tail of a band that began on page 0 and then
 * holds one whole band: only the band at the page boundary is partial.
 */
const WINDOWED_POPULATION_PAGE_SIZE = 4;
const WINDOWED_POPULATION_BOUNDARY_PAGE = 1;

const POPULATION_SIZES: readonly (readonly [DocumentStatus, number])[] = [
  [DocumentStatus.Draft, 5],
  [DocumentStatus.InReview, 2],
  [DocumentStatus.Approved, 3],
];

const FULL_POPULATION: DocumentRowData[] = POPULATION_SIZES.flatMap(
  ([status, size], sectionIndex) =>
    Array.from({ length: size }, (_, index) => {
      const number = sectionIndex * 10 + index + 1;
      return makeArtifact({
        id: `${status}-${index}`,
        slug: `${SlugPrefix.Prd}-${number}`,
        status,
        title: `Test PRD ${number}`,
        type: DocumentType.Prd,
      });
    })
);

const EMPTY_TREE: ProjectTreeResponse = { externalParents: [], nodes: [] };

const PAGING_INPUT = {
  documents: FULL_POPULATION,
  filterCategory: "all" as const,
  filterText: "",
  groupBy: GroupByMode.Status,
  sortBy: null,
  sortDir: "asc" as const,
  treeData: EMPTY_TREE,
};

/** One page of the windowed response, exactly as a paged caller receives it. */
export function documentsWindowedPage(
  pageIndex = WINDOWED_POPULATION_BOUNDARY_PAGE
): DocumentsWindowedPage {
  const plan = buildTableViewPagePlan(
    PAGING_INPUT,
    WINDOWED_POPULATION_PAGE_SIZE
  );
  const planPage = plan?.pages[pageIndex];
  if (!(plan && planPage)) {
    throw new Error(`The windowed population has no page ${pageIndex}`);
  }
  const page = pageTableView({
    ...PAGING_INPUT,
    page: pageIndex,
    pageIds: planPage.ids,
    pageSize: WINDOWED_POPULATION_PAGE_SIZE,
  });
  return {
    continuedSectionKeys: planPage.continuedSectionKeys,
    documents: page.pagedDocuments,
    pageIds: planPage.ids,
    sectionTotals: plan.sectionTotals,
    treeData: page.pagedTreeData ?? EMPTY_TREE,
  };
}

type DocumentsWindowedPage = {
  continuedSectionKeys: ReadonlySet<string>;
  documents: DocumentRowData[];
  /** The page's rows in the plan's order. */
  pageIds: readonly string[];
  sectionTotals: ReadonlyMap<string, number>;
  treeData: ProjectTreeResponse;
};
