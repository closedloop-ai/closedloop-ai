import { describe, expect, it } from "vitest";
import { resolveListSurfacePagination } from "../list-surface-pagination";

const EMPTY_ROWS: readonly string[] = [];

describe("resolveListSurfacePagination maxOffset cap", () => {
  it("caps totalPages when maxOffset is defined", () => {
    const { totalPages } = resolveListSurfacePagination({
      isGrouped: false,
      isServerDriven: true,
      maxOffset: 10_000,
      page: 0,
      pageSize: 25,
      rows: EMPTY_ROWS,
      serverTotalRows: 30_000,
    });
    expect(totalPages).toBe(401);
  });

  it("does not cap when maxOffset is undefined", () => {
    const { totalPages } = resolveListSurfacePagination({
      isGrouped: false,
      isServerDriven: true,
      page: 0,
      pageSize: 25,
      rows: EMPTY_ROWS,
      serverTotalRows: 30_000,
    });
    expect(totalPages).toBe(1200);
  });

  it("uses raw totalPages when it is lower than the cap", () => {
    const { totalPages } = resolveListSurfacePagination({
      isGrouped: false,
      isServerDriven: true,
      maxOffset: 10_000,
      page: 0,
      pageSize: 25,
      rows: EMPTY_ROWS,
      serverTotalRows: 500,
    });
    expect(totalPages).toBe(20);
  });

  it("caps totalPages when serverTotalRows exceeds the cap by a single row", () => {
    const { totalPages } = resolveListSurfacePagination({
      isGrouped: false,
      isServerDriven: true,
      maxOffset: 10_000,
      page: 0,
      pageSize: 25,
      rows: EMPTY_ROWS,
      serverTotalRows: 10_026,
    });
    expect(totalPages).toBe(401);
  });

  it("caps client-side totalPages derived from rows.length", () => {
    // ISS-9225 (BHA review): this case passed `rows: EMPTY_ROWS`, so `total`
    // was 0 and one page came back with or without the cap — the assertion
    // could not fail for the reason its name gave. Client-side the row count IS
    // the total, so capping it needs rows to count.
    const { totalPages } = resolveListSurfacePagination({
      isGrouped: true,
      isServerDriven: false,
      maxOffset: 10_000,
      page: 0,
      pageSize: 25,
      rows: new Array(30_000).fill("row"),
    });
    expect(totalPages).toBe(401);
  });
});
/**
 * ISS-9692 — a large page actually HOLDS that many rows. The ladder growing is
 * only half the ask; a slice that still stopped at 100 would render the same
 * page under a bigger label.
 *
 * ISS-9225 renamed the helper these drive and made its rows opaque, so they name
 * `resolveListSurfacePagination` and count plain objects: this bound is not a
 * Sessions fact, and Branches pages through the same slice.
 */
describe("resolveListSurfacePagination at the large ladder rungs", () => {
  const rowsOfLength = (length: number): readonly { id: string }[] =>
    Array.from({ length }, (_unused, index) => ({
      id: `session-${index}`,
    }));

  it("puts 250 rows on one page when the data supports it", () => {
    const { pagedRows, totalPages } = resolveListSurfacePagination({
      isGrouped: false,
      isServerDriven: false,
      page: 0,
      pageSize: 250,
      rows: rowsOfLength(600),
    });

    expect(pagedRows).toHaveLength(250);
    expect(totalPages).toBe(3);
  });

  it("puts 500 rows on one page when the data supports it", () => {
    const { pagedRows, totalPages } = resolveListSurfacePagination({
      isGrouped: false,
      isServerDriven: false,
      page: 0,
      pageSize: 500,
      rows: rowsOfLength(600),
    });

    expect(pagedRows).toHaveLength(500);
    expect(totalPages).toBe(2);
  });

  it("serves the short tail rather than padding it", () => {
    // A page size larger than the corpus must not claim rows that do not exist.
    const { pagedRows, totalPages } = resolveListSurfacePagination({
      isGrouped: false,
      isServerDriven: false,
      page: 0,
      pageSize: 500,
      rows: rowsOfLength(137),
    });

    expect(pagedRows).toHaveLength(137);
    expect(totalPages).toBe(1);
  });
});
