import type { DocumentListPage } from "@repo/api/src/types/document";
import type { DocumentsIndexPagination } from "@repo/app/documents/components/documents-index-pagination";
import {
  type DocumentsIndexPaging,
  resolveDocumentsIndexPageBounds,
} from "@repo/app/documents/hooks/use-documents-index-paging";
import { keepSamePageSizePlaceholder } from "@repo/app/documents/hooks/use-my-tasks-card-page";
import { buildTableRangeReadout } from "@repo/design-system/components/ui/table-page-size-select";
import { z } from "zod";

/**
 * ISS-9157: the pure half of the paged Documents index read — what the
 * container derives from ONE server envelope, kept beside the paging hook so
 * the container stays the read-selection module and nothing else.
 */

/** The unit the paged footer's range sentence counts in. */
const DOCUMENTS_INDEX_READOUT_NOUN = "documents";

/**
 * The `search` the previous paged query was keyed on. `documentKeys.list`
 * places the filter object third in the key; a key shaped any other way (or no
 * previous query at all) reads as "no term", which never matches a typed one.
 */
export function readSearchFromQueryKey(
  queryKey: readonly unknown[] | undefined
): string | undefined {
  const parsed = queryKeyFiltersSchema.safeParse(queryKey?.[2]);
  return parsed.success ? parsed.data.search : undefined;
}

/**
 * The `placeholderData` for the paged read. Reuse the previous page's rows only
 * for a turn WITHIN the same window: the same term, at the same server-clamped
 * size. Across a size change the shared helper drops it (a 500-row envelope
 * must never stand in for a 25-row read); across a term change this drops it
 * (rows for the old term must never render under the new one). The previous
 * term is read from the previous query's KEY, so a key `documentKeys.list` no
 * longer shapes reads as "no term" and can only ever match a cleared box —
 * which the direct cases on this function pin against the real key builder.
 */
export function buildDocumentsIndexPlaceholder({
  pageSize,
  search,
  recencyDays,
}: {
  pageSize: number;
  search: string | undefined;
  recencyDays?: number;
}): (
  previous: DocumentListPage | undefined,
  previousQuery: { queryKey: readonly unknown[] } | undefined
) => DocumentListPage | undefined {
  const keepSameSize = keepSamePageSizePlaceholder(pageSize);
  return (previous, previousQuery) =>
    readSearchFromQueryKey(previousQuery?.queryKey) === search &&
    readRecencyFromQueryKey(previousQuery?.queryKey) === recencyDays
      ? keepSameSize(previous)
      : undefined;
}

/**
 * Everything the pager states comes from the ENVELOPE, not the request: an
 * older API that ignores `limit` answers a bare array, which
 * `normalizeDocumentListResponse` folds into one page with `limit: null`, and
 * the strip must describe that page rather than the one that was asked for. The
 * size floors at 1 so an empty legacy answer cannot divide by zero.
 */
export function readDocumentsIndexEnvelope({
  envelope,
  isPlaceholderData,
  requestedPage,
  requestedPageSize,
}: {
  envelope: DocumentListPage | undefined;
  isPlaceholderData: boolean;
  requestedPage: number;
  requestedPageSize: number;
}): DocumentsIndexEnvelopeRead {
  const pagedItems = envelope?.items ?? NO_DOCUMENTS;
  const total = envelope?.total ?? 0;
  const envelopeOffset = envelope?.offset ?? 0;
  const effectivePageSize = Math.max(1, envelope?.limit ?? pagedItems.length);
  const effectivePage = envelope
    ? Math.floor(envelopeOffset / effectivePageSize)
    : requestedPage;
  const { totalPages } = resolveDocumentsIndexPageBounds({
    page: effectivePage,
    pageSize: effectivePageSize,
    total,
  });
  const hasSettledEnvelope = envelope !== undefined && !isPlaceholderData;
  return {
    pagedItems,
    total,
    envelopeOffset,
    effectivePageSize,
    effectivePage,
    totalPages,
    hasSettledEnvelope,
    // A server that applied the size the reader chose is one whose page size
    // the reader can change. A legacy answer with `limit: null` sent the whole
    // set, and a server that narrowed the request (a version-skewed cap below
    // the ladder's rung) served a size the ladder does not name; a rows-per-page
    // control over either would state a bound nothing applies (whitlockk review,
    // #7568). The readout still describes the page actually served.
    isRequestedPageSizeApplied: envelope?.limit === requestedPageSize,
    // A settled page past the end of the population (the last row on it was
    // deleted, or the total shrank under it) is a page the clamp is about to
    // move the reader off, not an empty index; it holds as loading so neither
    // body can classify it as one. Keyed on the OFFSET, not the total: a
    // nonzero page whose whole population was deleted answers `total: 0` and is
    // still a page the clamp moves off, while the genuine empty index is only
    // ever the first page (davetho review, #7568).
    isOutOfRange:
      hasSettledEnvelope &&
      pagedItems.length === 0 &&
      envelopeOffset > 0 &&
      envelopeOffset >= total,
  };
}

/**
 * The pager descriptor for one settled (or in-flight) server page. Everything it
 * states comes from the ENVELOPE the read answered with, never the request, so
 * an older API that ignored or narrowed `limit` is described as the page it
 * actually sent — and offered no rows-per-page control over it.
 */
export function buildDocumentsIndexPagination({
  envelopeRead,
  isPagerUnsettled,
  paging,
  noun = DOCUMENTS_INDEX_READOUT_NOUN,
}: {
  envelopeRead: DocumentsIndexEnvelopeRead;
  isPagerUnsettled: boolean;
  paging: DocumentsIndexPaging;
  /** The listing's own plural, the one its empty and loading states use. */
  noun?: string;
}): DocumentsIndexPagination {
  const {
    effectivePage,
    effectivePageSize,
    envelopeOffset,
    isRequestedPageSizeApplied,
    pagedItems,
    total,
    totalPages,
  } = envelopeRead;
  return {
    page: effectivePage,
    totalPages,
    ...(isRequestedPageSizeApplied
      ? {
          pageSize: paging.pageSize,
          pageSizeOptions: paging.pageSizeOptions,
          onPageSizeChange: paging.onPageSizeChange,
        }
      : {}),
    readout: isPagerUnsettled
      ? null
      : buildTableRangeReadout({
          page: effectivePage,
          pageSize: effectivePageSize,
          total,
          noun,
          // The rows this page actually holds, so a page the server trimmed
          // short is not read out as a full one.
          range: {
            from: envelopeOffset + 1,
            to: envelopeOffset + pagedItems.length,
          },
        }),
    disabled: isPagerUnsettled,
    // Strided by the size this page was SERVED at, so the next page is asked
    // for where this one ended even when the server narrowed the request.
    onPageChange: (page) => paging.onPageChange(page, effectivePageSize),
  };
}

export type DocumentsIndexEnvelopeRead = {
  pagedItems: DocumentListPage["items"];
  total: number;
  envelopeOffset: number;
  effectivePageSize: number;
  effectivePage: number;
  totalPages: number;
  hasSettledEnvelope: boolean;
  isRequestedPageSizeApplied: boolean;
  isOutOfRange: boolean;
};

const queryKeyFiltersSchema = z.object({
  search: z.string().optional(),
  recencyDays: z.number().optional(),
});

const NO_DOCUMENTS: DocumentListPage["items"] = [];

function readRecencyFromQueryKey(
  queryKey: readonly unknown[] | undefined
): number | undefined {
  const parsed = queryKeyFiltersSchema.safeParse(queryKey?.[2]);
  return parsed.success ? parsed.data.recencyDays : undefined;
}

/**
 * How long the search box must be idle before the term becomes a query key
 * (ISS-9724). Long enough that a typed word is one request, short enough that
 * the wait is not itself the thing the reader notices.
 */
export const DOCUMENTS_INDEX_SEARCH_DEBOUNCE_MS = 300;
