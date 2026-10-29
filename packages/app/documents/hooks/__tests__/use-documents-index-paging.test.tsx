import { DOCUMENT_LIST_MAX_OFFSET } from "@repo/api/src/types/document";
import { resolveMaxPageIndex } from "@repo/api/src/utils/math";
import {
  resolveLegalTablePageSize,
  TABLE_PAGE_SIZE_OPTIONS,
  TABLE_PAGE_SIZE_OPTIONS_EXTENDED,
} from "@repo/design-system/components/ui/table-page-size-select";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DocumentsIndexPagingIdentity,
  useDocumentsIndexPageClamp,
  useDocumentsIndexPaging,
} from "../use-documents-index-paging";

/**
 * ISS-9157 — the paged index's cursor bindings: the offset it derives, when it
 * resets, what it persists, and when the post-response clamp is allowed to
 * move the reader.
 */
const mocks = vi.hoisted(() => ({
  useViewStatePersistence: vi.fn(),
  useTablePageSizeOptions: vi.fn(),
  setPersistedPageSize: vi.fn(),
}));

vi.mock("@repo/app/shared/hooks/use-view-state-persistence", () => ({
  useViewStatePersistence: mocks.useViewStatePersistence,
}));
vi.mock("@repo/app/shared/hooks/use-table-page-size-options", () => ({
  useTablePageSizeOptions: mocks.useTablePageSizeOptions,
}));

const PAGE_SIZE = TABLE_PAGE_SIZE_OPTIONS[0];
const LARGER_PAGE_SIZE = TABLE_PAGE_SIZE_OPTIONS[1];
const LARGEST_EXTENDED_RUNG = TABLE_PAGE_SIZE_OPTIONS_EXTENDED.at(-1) as number;
const LARGEST_CLOSED_RUNG = TABLE_PAGE_SIZE_OPTIONS.at(-1) as number;

const IDENTITY: DocumentsIndexPagingIdentity = {
  pageSizeStorageKey: "org-a::table:page-size:documents-index",
  search: undefined,
  sortBy: "stackRank",
  sortDir: "asc",
};

function givenLadder({
  extended = false,
  isReady = true,
}: {
  extended?: boolean;
  isReady?: boolean;
} = {}) {
  const options = extended
    ? TABLE_PAGE_SIZE_OPTIONS_EXTENDED
    : TABLE_PAGE_SIZE_OPTIONS;
  mocks.useTablePageSizeOptions.mockImplementation((requested: number) => ({
    isExtendedLadderEnabled: extended,
    isReady,
    options,
    pageSize: resolveLegalTablePageSize(requested, options),
  }));
}

function givenPersistedPageSize(size: number | undefined) {
  mocks.useViewStatePersistence.mockImplementation(
    (_key: string | null, defaultValue: number) => [
      size ?? defaultValue,
      mocks.setPersistedPageSize,
      vi.fn(),
    ]
  );
}

function scrollable(scrollTop: number): HTMLElement {
  const element = document.createElement("div");
  element.scrollTop = scrollTop;
  return element;
}

beforeEach(() => {
  vi.clearAllMocks();
  givenLadder();
  givenPersistedPageSize(undefined);
});

describe("useDocumentsIndexPaging", () => {
  it("starts on the first page at the resolved default size", () => {
    const { result } = renderHook(() =>
      useDocumentsIndexPaging({ identity: IDENTITY, scrollContainer: null })
    );

    expect(result.current).toMatchObject({
      page: 0,
      offset: 0,
      pageSize: PAGE_SIZE,
      isPageSizeReady: true,
    });
  });

  it("derives the offset from the page and the size", () => {
    const { result } = renderHook(() =>
      useDocumentsIndexPaging({ identity: IDENTITY, scrollContainer: null })
    );

    act(() => result.current.onPageChange(3, PAGE_SIZE));

    expect(result.current.page).toBe(3);
    expect(result.current.offset).toBe(3 * PAGE_SIZE);
  });

  it("strides a turn by the size the server served, not the size asked for", () => {
    // A version-skewed API that narrows the requested 50 to 25: the next page
    // starts where the served one ended, or rows 26–50 never render (whitlockk
    // review, #7568). The request still ASKS for 50.
    givenPersistedPageSize(LARGER_PAGE_SIZE);
    const { result } = renderHook(() =>
      useDocumentsIndexPaging({ identity: IDENTITY, scrollContainer: null })
    );
    expect(result.current.pageSize).toBe(LARGER_PAGE_SIZE);

    act(() => result.current.onPageChange(1, PAGE_SIZE));

    expect(result.current.offset).toBe(PAGE_SIZE);
    expect(result.current.pageSize).toBe(LARGER_PAGE_SIZE);

    act(() => result.current.onPageChange(2, PAGE_SIZE));
    expect(result.current.offset).toBe(2 * PAGE_SIZE);
  });

  it("resets to the first page in the same render that the identity changes", () => {
    const { result, rerender } = renderHook(
      ({ identity }) =>
        useDocumentsIndexPaging({ identity, scrollContainer: null }),
      { initialProps: { identity: IDENTITY } }
    );
    act(() => result.current.onPageChange(2, PAGE_SIZE));

    rerender({ identity: { ...IDENTITY, search: "runbook" } });

    // Asserted on the very first render after the change: an effect-based
    // reset would let one read go out at the old offset first.
    expect(result.current.page).toBe(0);
    expect(result.current.offset).toBe(0);
  });

  it("treats the organization key, the sort, and the size as identity too", () => {
    const changes: Partial<DocumentsIndexPagingIdentity>[] = [
      { pageSizeStorageKey: "org-b::table:page-size:documents-index" },
      { sortBy: "title" },
      { sortDir: "desc" },
    ];
    for (const change of changes) {
      const { result, rerender } = renderHook(
        ({ identity }) =>
          useDocumentsIndexPaging({ identity, scrollContainer: null }),
        { initialProps: { identity: IDENTITY } }
      );
      act(() => result.current.onPageChange(1, PAGE_SIZE));

      rerender({ identity: { ...IDENTITY, ...change } });

      expect(result.current.offset).toBe(0);
    }
  });

  it("scrolls the container to the top on a page turn and on an identity change that moved the cursor, but not on mount", () => {
    const container = scrollable(120);
    const { result, rerender } = renderHook(
      ({ identity }) =>
        useDocumentsIndexPaging({ identity, scrollContainer: container }),
      { initialProps: { identity: IDENTITY } }
    );
    // Mount leaves a restored offset alone: `useScrollRestore` owns it.
    expect(container.scrollTop).toBe(120);

    act(() => result.current.onPageChange(1, PAGE_SIZE));
    expect(container.scrollTop).toBe(0);

    container.scrollTop = 80;
    rerender({ identity: { ...IDENTITY, search: "runbook" } });
    expect(container.scrollTop).toBe(0);
  });

  it("leaves the scroll position alone when the identity changes on the first page", () => {
    // The reader never left page 0, so the reset re-reads the page they are
    // on; their offset into it is still theirs. This is also what keeps the
    // shipped unbounded arm untouched: it mounts this hook and never turns a
    // page, so a sort or search change there must not move the container.
    const container = scrollable(120);
    const { rerender } = renderHook(
      ({ identity }) =>
        useDocumentsIndexPaging({ identity, scrollContainer: container }),
      { initialProps: { identity: IDENTITY } }
    );

    rerender({ identity: { ...IDENTITY, sortBy: "title" } });
    expect(container.scrollTop).toBe(120);

    rerender({ identity: { ...IDENTITY, sortBy: "title", search: "runbook" } });
    expect(container.scrollTop).toBe(120);
  });

  it("re-reads from the first page at the new size, and does nothing for a size that resolves to the current one", () => {
    const { result } = renderHook(() =>
      useDocumentsIndexPaging({ identity: IDENTITY, scrollContainer: null })
    );
    act(() => result.current.onPageChange(2, PAGE_SIZE));

    act(() => result.current.onPageSizeChange(LARGER_PAGE_SIZE));
    expect(result.current).toMatchObject({
      page: 0,
      offset: 0,
      pageSize: LARGER_PAGE_SIZE,
    });

    act(() => result.current.onPageChange(1, LARGER_PAGE_SIZE));
    // With the closed ladder a 500 resolves to the largest closed rung, which
    // is not the current size, so it IS a change…
    act(() => result.current.onPageSizeChange(LARGEST_EXTENDED_RUNG));
    expect(result.current.pageSize).toBe(LARGEST_CLOSED_RUNG);
    expect(result.current.page).toBe(0);
    act(() => result.current.onPageChange(1, LARGEST_CLOSED_RUNG));
    // …and asking for it again resolves to the same rung: a no-op, so the
    // reader stays where they were.
    act(() => result.current.onPageSizeChange(LARGEST_EXTENDED_RUNG));
    expect(result.current.page).toBe(1);
  });

  it("persists a size change only when the extended ladder is on", () => {
    givenLadder({ extended: false });
    const closed = renderHook(() =>
      useDocumentsIndexPaging({ identity: IDENTITY, scrollContainer: null })
    );
    act(() => closed.result.current.onPageSizeChange(LARGER_PAGE_SIZE));
    expect(mocks.setPersistedPageSize).not.toHaveBeenCalled();
    expect(closed.result.current.pageSize).toBe(LARGER_PAGE_SIZE);

    givenLadder({ extended: true });
    const open = renderHook(() =>
      useDocumentsIndexPaging({ identity: IDENTITY, scrollContainer: null })
    );
    act(() => open.result.current.onPageSizeChange(LARGER_PAGE_SIZE));
    expect(mocks.setPersistedPageSize).toHaveBeenCalledWith(LARGER_PAGE_SIZE);
  });

  it("does not carry a size chosen in one organization into the next one's first read", () => {
    const orgB: DocumentsIndexPagingIdentity = {
      ...IDENTITY,
      pageSizeStorageKey: "org-b::table:page-size:documents-index",
    };
    const { result, rerender } = renderHook(
      ({ identity }) =>
        useDocumentsIndexPaging({ identity, scrollContainer: null }),
      { initialProps: { identity: IDENTITY } }
    );
    act(() => result.current.onPageSizeChange(LARGER_PAGE_SIZE));
    act(() => result.current.onPageChange(1, LARGER_PAGE_SIZE));
    expect(result.current.pageSize).toBe(LARGER_PAGE_SIZE);

    rerender({ identity: orgB });

    // Asserted on the first render after the switch: this is the size and
    // offset the new organization's first request is built from.
    expect(result.current).toMatchObject({
      page: 0,
      offset: 0,
      pageSize: PAGE_SIZE,
    });

    // Back in the organization the choice was made in, it still holds.
    rerender({ identity: IDENTITY });
    expect(result.current.pageSize).toBe(LARGER_PAGE_SIZE);
  });

  it("reads a persisted size the ladder no longer offers at the largest rung it does", () => {
    givenPersistedPageSize(LARGEST_EXTENDED_RUNG);
    givenLadder({ extended: false });
    const { result } = renderHook(() =>
      useDocumentsIndexPaging({ identity: IDENTITY, scrollContainer: null })
    );

    expect(result.current.pageSize).toBe(LARGEST_CLOSED_RUNG);
  });

  it("reports the size as not ready while the ladder flag is unresolved", () => {
    givenLadder({ isReady: false });
    const { result } = renderHook(() =>
      useDocumentsIndexPaging({ identity: IDENTITY, scrollContainer: null })
    );

    expect(result.current.isPageSizeReady).toBe(false);
  });

  it("hands the persistence hook the org-scoped key it was given, null included", () => {
    renderHook(() =>
      useDocumentsIndexPaging({
        identity: { ...IDENTITY, pageSizeStorageKey: null },
        scrollContainer: null,
      })
    );

    expect(mocks.useViewStatePersistence).toHaveBeenCalledWith(null, PAGE_SIZE);
  });
});

describe("useDocumentsIndexPageClamp", () => {
  const clampInput = {
    enabled: true,
    hasData: true,
    isFetching: false,
    page: 7,
    pageSize: PAGE_SIZE,
    total: 30,
  };

  it("writes the page back down when the total no longer reaches it", () => {
    const setPage = vi.fn();
    renderHook(() => useDocumentsIndexPageClamp({ ...clampInput, setPage }));

    expect(setPage).toHaveBeenCalledWith(1);
  });

  it("leaves an in-range page alone", () => {
    const setPage = vi.fn();
    renderHook(() =>
      useDocumentsIndexPageClamp({ ...clampInput, page: 1, setPage })
    );

    expect(setPage).not.toHaveBeenCalled();
  });

  it.each([
    ["the read is disabled", { enabled: false }],
    ["there is no settled data", { hasData: false }],
    ["a read is in flight", { isFetching: true }],
  ])("does not clamp while %s", (_label, precondition) => {
    const setPage = vi.fn();
    renderHook(() =>
      useDocumentsIndexPageClamp({ ...clampInput, ...precondition, setPage })
    );

    expect(setPage).not.toHaveBeenCalled();
  });

  it("never advertises a page whose offset the route would refuse", () => {
    const setPage = vi.fn();
    const lastReachablePage = resolveMaxPageIndex(
      DOCUMENT_LIST_MAX_OFFSET,
      PAGE_SIZE
    );
    renderHook(() =>
      useDocumentsIndexPageClamp({
        ...clampInput,
        page: lastReachablePage + 5,
        total: 1_000_000,
        setPage,
      })
    );

    expect(setPage).toHaveBeenCalledWith(lastReachablePage);
    expect(lastReachablePage * PAGE_SIZE).toBeLessThanOrEqual(
      DOCUMENT_LIST_MAX_OFFSET
    );
  });
});
