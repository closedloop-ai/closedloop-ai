/** Fixed page width for compatibility reads that reconcile a full Branch cohort. */
export const BRANCH_LIST_COMPLETE_COHORT_PAGE_SIZE = 100;

/** Maximum parallel requests issued by one complete-cohort compatibility read. */
export const BRANCH_LIST_COMPLETE_COHORT_CONCURRENCY = 4;

/** Maximum Branch population admitted to one Desktop snapshot IPC request. */
export const BRANCH_LIST_COMPLETE_COHORT_MAX_ROWS = 20_000;
