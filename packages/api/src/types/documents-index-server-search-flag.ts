/**
 * ISS-9724 (ISS-4779 closed-by-default policy): gates whether the Documents
 * index's search box is answered by the database or by the rows the browser
 * already holds. Off by default.
 *
 * WEB-ONLY, for the same reason its sibling
 * `documents-index-states-flag` is: the desktop shell has no Documents
 * destination, so there is no second surface for the gate to leak on.
 */
export const DOCUMENTS_INDEX_SERVER_SEARCH_FLAG_KEY =
  "documents-index-server-search" as const;
