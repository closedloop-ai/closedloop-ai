import type { BranchListResponse } from "@repo/api/src/types/branch";
import {
  BRANCH_LIST_COMPLETE_COHORT_CONCURRENCY,
  BRANCH_LIST_COMPLETE_COHORT_PAGE_SIZE,
} from "@repo/api/src/types/branch-list-work-budget";

/** Actual request and row work consumed by one complete-cohort read. */
export type CompleteBranchListWork = {
  peakRequestConcurrency: number;
  requestCount: number;
  rowCount: number;
};

/** Reads a complete cohort under the declared page-width and concurrency budgets. */
export async function readCompleteBranchListPages(
  fetchPage: (offset: number) => Promise<BranchListResponse>
): Promise<{ pages: BranchListResponse[]; work: CompleteBranchListWork }> {
  const firstPage = await fetchPage(0);
  const pageCount = remainingPageCount(firstPage);
  const pages = new Map<number, BranchListResponse>([[0, firstPage]]);
  let nextPageIndex = 1;
  let activeRequests = 0;
  let peakRequestConcurrency = 1;
  let failed = false;
  let firstError: unknown;

  const fetchNextPages = async (): Promise<void> => {
    while (!failed) {
      const pageIndex = nextPageIndex;
      nextPageIndex += 1;
      if (pageIndex > pageCount) {
        return;
      }
      activeRequests += 1;
      peakRequestConcurrency = Math.max(peakRequestConcurrency, activeRequests);
      try {
        const page = await fetchPage(
          pageIndex * BRANCH_LIST_COMPLETE_COHORT_PAGE_SIZE
        );
        assertCompleteBranchListPage(page, pageIndex, firstPage.total);
        pages.set(pageIndex, page);
      } catch (error) {
        firstError ??= error;
        failed = true;
      } finally {
        activeRequests -= 1;
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(BRANCH_LIST_COMPLETE_COHORT_CONCURRENCY, pageCount) },
      () => fetchNextPages()
    )
  );
  if (failed) {
    throw firstError;
  }
  const orderedPages = [...pages.entries()]
    .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
    .map(([, page]) => page);
  return {
    pages: orderedPages,
    work: {
      peakRequestConcurrency,
      requestCount: orderedPages.length,
      rowCount: orderedPages.reduce(
        (count, page) => count + page.items.length,
        0
      ),
    },
  };
}

function remainingPageCount(firstPage: BranchListResponse): number {
  const { total } = firstPage;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new RangeError("Branches list returned an invalid total");
  }
  assertCompleteBranchListPage(firstPage, 0, total);
  if (firstPage.hasMore !== true) {
    return 0;
  }
  return Math.max(
    0,
    Math.ceil(total / BRANCH_LIST_COMPLETE_COHORT_PAGE_SIZE) - 1
  );
}

function assertCompleteBranchListPage(
  page: BranchListResponse,
  pageIndex: number,
  total: number
): void {
  const offset = pageIndex * BRANCH_LIST_COMPLETE_COHORT_PAGE_SIZE;
  const expectedItemCount = Math.min(
    BRANCH_LIST_COMPLETE_COHORT_PAGE_SIZE,
    Math.max(0, total - offset)
  );
  const expectedHasMore = offset + expectedItemCount < total;
  if (
    page.items.length !== expectedItemCount ||
    (expectedHasMore ? page.hasMore !== true : page.hasMore === true)
  ) {
    throw new RangeError("Branches list pagination metadata is inconsistent");
  }
}
