import {
  type DocumentListPage,
  DocumentType,
} from "@repo/api/src/types/document";
import { documentsPageQueryKey } from "@repo/app/documents/hooks/use-documents";
import { TABLE_PAGE_SIZE_OPTIONS } from "@repo/design-system/components/ui/table-page-size-select";
import { describe, expect, it, vi } from "vitest";
import {
  buildDocumentsIndexPagination,
  buildDocumentsIndexPlaceholder,
  readDocumentsIndexEnvelope,
  readSearchFromQueryKey,
} from "../documents-index-paged-read";

/**
 * ISS-9157 — the placeholder predicate, executed directly (marisolashgrove
 * review, #7568): every view suite mocks `useDocumentsPage`, so the closure the
 * container hands it is never invoked there. The previous term is read out of
 * the previous query's KEY, so these cases build that key with the REAL
 * `documentsPageQueryKey` — a key shaped any other way reads as "no term",
 * which is exactly the drift that would let a searched page's rows stand in
 * for an unsearched read.
 */
const PAGE_SIZE = TABLE_PAGE_SIZE_OPTIONS[0];
const LARGER_PAGE_SIZE = TABLE_PAGE_SIZE_OPTIONS[1];

const INDEX_PARAMS = { type: DocumentType.Doc, unassignedProject: true };

function envelope(overrides: Partial<DocumentListPage> = {}): DocumentListPage {
  return {
    items: [],
    total: 137,
    limit: PAGE_SIZE,
    offset: 0,
    hasMore: true,
    ...overrides,
  };
}

function previousQueryFor(search: string | undefined) {
  return {
    queryKey: documentsPageQueryKey({
      ...INDEX_PARAMS,
      limit: PAGE_SIZE,
      offset: PAGE_SIZE,
      ...(search === undefined ? {} : { search }),
    }),
  };
}

describe("readSearchFromQueryKey", () => {
  it("reads the term the paged hook keyed the previous query on", () => {
    expect(readSearchFromQueryKey(previousQueryFor("runbook").queryKey)).toBe(
      "runbook"
    );
  });

  it("reads no term from a key the hook built without one", () => {
    expect(
      readSearchFromQueryKey(previousQueryFor(undefined).queryKey)
    ).toBeUndefined();
  });

  it.each([
    ["no previous query", undefined],
    ["a key with no filters slot", ["documents", "list"]],
    ["a key whose filters slot is not an object", ["documents", "list", 7]],
    [
      "a key whose search is not a string",
      ["documents", "list", { search: 3 }],
    ],
  ])("reads no term from %s", (_label, queryKey) => {
    expect(readSearchFromQueryKey(queryKey)).toBeUndefined();
  });
});

describe("buildDocumentsIndexPlaceholder", () => {
  const previous = envelope({ offset: PAGE_SIZE });

  it("keeps the previous page for a turn within the same term at the same size", () => {
    const placeholder = buildDocumentsIndexPlaceholder({
      pageSize: PAGE_SIZE,
      search: "runbook",
    });

    expect(placeholder(previous, previousQueryFor("runbook"))).toBe(previous);
  });

  it("keeps the previous page for a turn with no term on either side", () => {
    const placeholder = buildDocumentsIndexPlaceholder({
      pageSize: PAGE_SIZE,
      search: undefined,
    });

    expect(placeholder(previous, previousQueryFor(undefined))).toBe(previous);
  });

  it("drops the previous page when the term changed", () => {
    const placeholder = buildDocumentsIndexPlaceholder({
      pageSize: PAGE_SIZE,
      search: "playbook",
    });

    expect(placeholder(previous, previousQueryFor("runbook"))).toBeUndefined();
  });

  it("drops a searched page when the box was cleared, and an unsearched page when a term was typed", () => {
    const cleared = buildDocumentsIndexPlaceholder({
      pageSize: PAGE_SIZE,
      search: undefined,
    });
    expect(cleared(previous, previousQueryFor("runbook"))).toBeUndefined();

    const typed = buildDocumentsIndexPlaceholder({
      pageSize: PAGE_SIZE,
      search: "runbook",
    });
    expect(typed(previous, previousQueryFor(undefined))).toBeUndefined();
  });

  it("drops the previous page across a size change even for the same term", () => {
    const placeholder = buildDocumentsIndexPlaceholder({
      pageSize: LARGER_PAGE_SIZE,
      search: "runbook",
    });

    expect(placeholder(previous, previousQueryFor("runbook"))).toBeUndefined();
  });

  it("drops the previous page when the recency range changed", () => {
    const placeholder = buildDocumentsIndexPlaceholder({
      pageSize: PAGE_SIZE,
      search: undefined,
      recencyDays: 30,
    });
    expect(placeholder(previous, previousQueryFor(undefined))).toBeUndefined();
  });

  it("has nothing to keep with no previous query", () => {
    const placeholder = buildDocumentsIndexPlaceholder({
      pageSize: PAGE_SIZE,
      search: undefined,
    });

    expect(placeholder(undefined, undefined)).toBeUndefined();
  });
});

describe("readDocumentsIndexEnvelope", () => {
  it.each([
    ["the size the reader chose", PAGE_SIZE, true],
    ["a narrower size than the reader chose", PAGE_SIZE - 5, false],
    ["no bound at all", null, false],
  ])(
    "offers the rows-per-page control only when the server applied %s",
    (_label, limit, isRequestedPageSizeApplied) => {
      expect(
        readDocumentsIndexEnvelope({
          envelope: envelope({ limit }),
          isPlaceholderData: false,
          requestedPage: 0,
          requestedPageSize: PAGE_SIZE,
        }).isRequestedPageSizeApplied
      ).toBe(isRequestedPageSizeApplied);
    }
  );
});

describe("buildDocumentsIndexPagination", () => {
  it("turns the page at the size the server served, not the size asked for", () => {
    const served = PAGE_SIZE - 5;
    const onPageChange = vi.fn();
    const envelopeRead = readDocumentsIndexEnvelope({
      envelope: envelope({ limit: served, offset: served }),
      isPlaceholderData: false,
      requestedPage: 1,
      requestedPageSize: PAGE_SIZE,
    });

    const pagination = buildDocumentsIndexPagination({
      envelopeRead,
      isPagerUnsettled: false,
      paging: {
        page: 1,
        offset: served,
        pageSize: PAGE_SIZE,
        pageSizeOptions: TABLE_PAGE_SIZE_OPTIONS,
        isPageSizeReady: true,
        setPage: vi.fn(),
        onPageChange,
        onPageSizeChange: vi.fn(),
      },
    });
    pagination.onPageChange(2);

    expect(pagination.page).toBe(1);
    expect(onPageChange).toHaveBeenCalledWith(2, served);
  });
});
