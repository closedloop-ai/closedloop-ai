/**
 * ISS-9157 (ISS-4779 closed-by-default policy): gates whether the Documents
 * index reads ONE server page of documents — `limit`/`offset` on the existing
 * `GET /documents` contract, with the real total from `includeTotal` — and
 * renders a pager, or reads every matching document in one unbounded request
 * as it shipped. Off by default, and off is byte-identical to the shipped
 * request: the flag decides which of two reads is issued, never the shape of
 * either.
 *
 * WEB-ONLY, for the reason its siblings `documents-index-states-flag` and
 * `documents-index-server-search-flag` are: the desktop shell has no Documents
 * destination, so there is no second surface for the gate to leak on.
 */
export const DOCUMENTS_INDEX_PAGED_FLAG_KEY = "documents-index-paged" as const;
