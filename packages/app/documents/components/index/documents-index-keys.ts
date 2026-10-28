/**
 * BASE persisted view-state keys for the org-level Documents index.
 *
 * ISS-9726: base, not final. `useViewStateKey` applies the active
 * organization's namespace to each of these, so nothing here is the string that
 * reaches `localStorage`. Read them through that hook — addressing one directly
 * writes to the un-namespaced key every organization shares.
 *
 * Hoisted out of the view (ISS-8940) because both flag arms render the same
 * table and must address the SAME stored sort, grouping, search, column, and
 * scroll state: a key redeclared per arm would silently reset a reader's view
 * the moment the flag flipped, which is the opposite of the persistence AC6
 * asks for. One definition, both arms.
 */
export const DOCUMENTS_INDEX_COLUMN_VISIBILITY_KEY =
  "table:columns:documents-index";
export const DOCUMENTS_INDEX_COLUMN_ORDER_KEY =
  "table:column-order:documents-index";
export const DOCUMENTS_INDEX_STORAGE_KEY = "documents-index-artifacts";
export const DOCUMENTS_INDEX_SEARCH_KEY = "table:search:documents-index";
export const DOCUMENTS_INDEX_SORT_KEY = "table:sort:documents-index";
export const DOCUMENTS_INDEX_SCROLL_KEY = "table:scroll:documents-index";
/**
 * ISS-9157: rows-per-page for the paged index. Same org-namespaced store the
 * sort beside it uses, so the choice survives a reload and cannot leak across
 * organizations.
 */
export const DOCUMENTS_INDEX_PAGE_SIZE_KEY = "table:page-size:documents-index";
