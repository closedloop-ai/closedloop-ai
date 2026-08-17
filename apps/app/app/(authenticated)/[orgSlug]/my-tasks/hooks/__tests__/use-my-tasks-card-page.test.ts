import {
  DOCUMENT_LIST_MAX_OFFSET,
  type DocumentListPage,
} from "@repo/api/src/types/document";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  keepSamePageSizePlaceholder,
  useMyTasksCardPage,
  useMyTasksCardPageBounds,
} from "../use-my-tasks-card-page";

const PAGE_SIZE = 50;
const LIST_LIMIT = 500;

function buildPage(overrides: Partial<DocumentListPage>): DocumentListPage {
  return {
    items: [],
    total: 0,
    limit: PAGE_SIZE,
    offset: 0,
    hasMore: false,
    ...overrides,
  };
}

describe("useMyTasksCardPage (ISS-4576)", () => {
  it("starts at the first page with a zero offset", () => {
    const { result } = renderHook(() => useMyTasksCardPage(PAGE_SIZE));

    expect(result.current.page).toBe(0);
    expect(result.current.offset).toBe(0);
  });

  it("translates the requested page into the offset the read sends", () => {
    const { result } = renderHook(() => useMyTasksCardPage(PAGE_SIZE));

    act(() => result.current.setPage(3));

    expect(result.current.page).toBe(3);
    expect(result.current.offset).toBe(150);
  });

  it("floors a negative page at 0 so the read never asks for a negative offset", () => {
    const { result } = renderHook(() => useMyTasksCardPage(PAGE_SIZE));

    act(() => result.current.setPage(-4));

    expect(result.current.page).toBe(0);
    expect(result.current.offset).toBe(0);
  });

  it("floors a non-positive page size at 1", () => {
    const { result } = renderHook(() => useMyTasksCardPage(0));

    act(() => result.current.setPage(2));

    expect(result.current.offset).toBe(2);
  });
});

describe("useMyTasksCardPageBounds (ISS-4576)", () => {
  it("reports the page count the server total implies", () => {
    const { result } = renderHook(() =>
      useMyTasksCardPageBounds({
        page: 0,
        setPage: vi.fn(),
        total: 137,
        pageSize: PAGE_SIZE,
      })
    );

    expect(result.current).toBe(3);
  });

  it("reports a single page for an empty queue", () => {
    const { result } = renderHook(() =>
      useMyTasksCardPageBounds({
        page: 0,
        setPage: vi.fn(),
        total: 0,
        pageSize: PAGE_SIZE,
      })
    );

    expect(result.current).toBe(1);
  });

  it("does NOT clamp while the total is unknown, so a refetch cannot snap the page back", () => {
    // The regression this guards: treating an unknown total as zero would reset
    // an in-flight page 4 to page 1 on every refetch and request the wrong
    // window.
    const setPage = vi.fn();

    renderHook(() =>
      useMyTasksCardPageBounds({
        page: 3,
        setPage,
        total: undefined,
        pageSize: PAGE_SIZE,
      })
    );

    expect(setPage).not.toHaveBeenCalled();
  });

  it("writes the page back down when the total shrinks under it", () => {
    const setPage = vi.fn();

    renderHook(() =>
      useMyTasksCardPageBounds({
        page: 7,
        setPage,
        total: 137,
        pageSize: PAGE_SIZE,
      })
    );

    expect(setPage).toHaveBeenCalledWith(2);
  });

  it("clamps a bookmarked page past the end of an empty queue to the first page", () => {
    const setPage = vi.fn();

    renderHook(() =>
      useMyTasksCardPageBounds({
        page: 4,
        setPage,
        total: 0,
        pageSize: PAGE_SIZE,
      })
    );

    expect(setPage).toHaveBeenCalledWith(0);
  });

  it("leaves an in-range page alone", () => {
    const setPage = vi.fn();

    renderHook(() =>
      useMyTasksCardPageBounds({
        page: 1,
        setPage,
        total: 137,
        pageSize: PAGE_SIZE,
      })
    );

    expect(setPage).not.toHaveBeenCalled();
  });

  it("caps the exposed page count so the last page's offset stays within the API ceiling (codex P2)", () => {
    // A queue far larger than the offset ceiling can reach at this page size:
    // ceil(total / pageSize) would advertise pages whose offset exceeds
    // DOCUMENT_LIST_MAX_OFFSET, and clicking one 400s the read. The bounds hook
    // must cap the count so the last advertised page is a request the server
    // accepts.
    const hugeTotal = 1_000_000;
    const { result } = renderHook(() =>
      useMyTasksCardPageBounds({
        page: 0,
        setPage: vi.fn(),
        total: hugeTotal,
        pageSize: PAGE_SIZE,
      })
    );

    const reportedPages = result.current;
    const lastPageOffset = (reportedPages - 1) * PAGE_SIZE;
    expect(lastPageOffset).toBeLessThanOrEqual(DOCUMENT_LIST_MAX_OFFSET);
    // And it is exactly the ceiling-derived cap, not the raw total-derived count.
    expect(reportedPages).toBe(
      Math.floor(DOCUMENT_LIST_MAX_OFFSET / PAGE_SIZE) + 1
    );
    expect(reportedPages).toBeLessThan(Math.ceil(hugeTotal / PAGE_SIZE));
  });

  it("clamps a page whose offset would exceed the ceiling back to the last reachable page", () => {
    const setPage = vi.fn();
    const cappedLastPage = Math.floor(DOCUMENT_LIST_MAX_OFFSET / PAGE_SIZE);

    renderHook(() =>
      useMyTasksCardPageBounds({
        page: cappedLastPage + 5,
        setPage,
        total: 1_000_000,
        pageSize: PAGE_SIZE,
      })
    );

    expect(setPage).toHaveBeenCalledWith(cappedLastPage);
  });
});

describe("keepSamePageSizePlaceholder (ISS-4576, shafty023 review)", () => {
  it("reuses the previous page on an offset-only move within the same page size", () => {
    // A page turn inside the card board: same `limit`, only the offset advances.
    // The placeholder holds the previous page so the pagination control does not
    // unmount under the cursor.
    const placeholder = keepSamePageSizePlaceholder(PAGE_SIZE);
    const previous = buildPage({
      limit: PAGE_SIZE,
      offset: 0,
      total: 137,
      items: Array.from({ length: PAGE_SIZE }, (_unused, i) => ({
        id: `card-${i}`,
      })) as DocumentListPage["items"],
    });

    expect(placeholder(previous)).toBe(previous);
  });

  it("drops the wide list page when the card view requests a narrower page (crash guard)", () => {
    // The held P1 this PR fixes: switching list (limit 500) → card (limit 50)
    // must NOT reuse the 500-row envelope as placeholder, or the card branch
    // transiently mounts all 500 draggable cards while the 50-row read is in
    // flight. The card request's placeholder must reject the wider previous page.
    const cardPlaceholder = keepSamePageSizePlaceholder(PAGE_SIZE);
    const previousListPage = buildPage({
      limit: LIST_LIMIT,
      offset: 0,
      total: 500,
      items: Array.from({ length: LIST_LIMIT }, (_unused, i) => ({
        id: `row-${i}`,
      })) as DocumentListPage["items"],
    });

    expect(cardPlaceholder(previousListPage)).toBeUndefined();
  });

  it("drops the narrow card page when the list view requests the wide page", () => {
    // The reverse switch (card → list) is equally scoped: the list read must not
    // inherit the 50-row card envelope as its placeholder.
    const listPlaceholder = keepSamePageSizePlaceholder(LIST_LIMIT);
    const previousCardPage = buildPage({ limit: PAGE_SIZE, total: 137 });

    expect(listPlaceholder(previousCardPage)).toBeUndefined();
  });

  it("returns undefined when there is no previous page", () => {
    const placeholder = keepSamePageSizePlaceholder(PAGE_SIZE);

    expect(placeholder(undefined)).toBeUndefined();
  });

  it("compares against the server-clamped envelope limit, not the raw request", () => {
    // The envelope carries the `limit` the server actually applied after
    // clamping. A previous page the server narrowed to a different size must not
    // be reused for a request at this size.
    const placeholder = keepSamePageSizePlaceholder(PAGE_SIZE);
    const previousDifferentlyClamped = buildPage({ limit: PAGE_SIZE + 1 });

    expect(placeholder(previousDifferentlyClamped)).toBeUndefined();
  });

  it("floors a non-positive requested limit at 1 before comparing", () => {
    const placeholder = keepSamePageSizePlaceholder(0);
    const previousUnitPage = buildPage({ limit: 1 });

    expect(placeholder(previousUnitPage)).toBe(previousUnitPage);
  });
});
