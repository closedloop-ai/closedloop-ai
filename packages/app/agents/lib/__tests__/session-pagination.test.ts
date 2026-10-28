import {
  TABLE_PAGE_SIZE_OPTIONS,
  TABLE_PAGE_SIZE_OPTIONS_EXTENDED,
} from "@repo/design-system/components/ui/table-page-size-select";
import { describe, expect, it } from "vitest";
import {
  clampSessionsPageIndex,
  normalizeSessionsPageSize,
  parseSessionsPageIndex,
  parseSessionsPageSizeParam,
  SESSIONS_PAGE_SIZE_PARAM,
  writeSessionsPageParam,
  writeSessionsPageSizeParam,
} from "../session-pagination";

const PAGE_SIZE = 25;
// A ceiling low enough that the ROW count alone would leave the pages below in
// range, so only the cap can exclude them.
const MAX_OFFSET = 200;
const LAST_SERVABLE_PAGE = MAX_OFFSET / PAGE_SIZE;

describe("session pagination", () => {
  it.each([
    [null, 0],
    ["", 0],
    ["0", 0],
    ["-1", 0],
    ["1.5", 0],
    ["Infinity", 0],
    ["abc", 0],
    ["1", 0],
    ["2", 1],
    ["12", 11],
  ])("parses %s to page index %s", (value, expected) => {
    expect(parseSessionsPageIndex(value)).toBe(expected);
  });

  it("writes canonical page params while preserving unrelated params", () => {
    const params = new URLSearchParams("userId=user-123&page=3");

    writeSessionsPageParam(params, 0);
    expect(params.toString()).toBe("userId=user-123");

    writeSessionsPageParam(params, 2);
    expect(params.toString()).toBe("userId=user-123&page=3");
  });

  it.each([
    [3, 0, 0],
    [3, 10, 0],
    [3, 51, 2],
    [1, 51, 1],
    [-1, 51, 0],
    [-3, 51, 0],
  ])(
    "clamps page index %s against total %s to %s",
    (pageIndex, total, expected) => {
      expect(clampSessionsPageIndex(pageIndex, total, PAGE_SIZE)).toBe(
        expected
      );
    }
  );

  it("uses the supplied page size when computing the final page", () => {
    expect(clampSessionsPageIndex(4, 250, 100)).toBe(2);
  });

  /**
   * ISS-9074, absorbed here by ISS-9555 slice 1: the ceiling is THREADED, so the
   * one clamp serves a capped cloud read and an uncapped local one. The
   * no-ceiling assertion is what makes the capped case non-vacuous — both pages
   * are in range on row count alone.
   */
  it("clamps a page past the threaded offset ceiling, and leaves it alone without one", () => {
    expect(
      clampSessionsPageIndex(
        LAST_SERVABLE_PAGE + 1,
        10_000,
        PAGE_SIZE,
        MAX_OFFSET
      )
    ).toBe(LAST_SERVABLE_PAGE);
    expect(
      clampSessionsPageIndex(LAST_SERVABLE_PAGE, 10_000, PAGE_SIZE, MAX_OFFSET)
    ).toBe(LAST_SERVABLE_PAGE);
    expect(
      clampSessionsPageIndex(LAST_SERVABLE_PAGE + 1, 10_000, PAGE_SIZE)
    ).toBe(LAST_SERVABLE_PAGE + 1);
  });
});

/**
 * The rows-per-page family moved here with the page family (ISS-9555 slice 1),
 * and its one caller is the desktop host — see the module comment for why that
 * is intended. Covered here because this module is where it is declared.
 */
describe("sessions page-size params", () => {
  it("parses only supported rows-per-page values", () => {
    expect(
      parseSessionsPageSizeParam(
        new URLSearchParams({ [SESSIONS_PAGE_SIZE_PARAM]: "50" }),
        TABLE_PAGE_SIZE_OPTIONS,
        PAGE_SIZE
      )
    ).toBe(50);
    expect(
      parseSessionsPageSizeParam(
        new URLSearchParams({ [SESSIONS_PAGE_SIZE_PARAM]: "17" }),
        TABLE_PAGE_SIZE_OPTIONS,
        PAGE_SIZE
      )
    ).toBe(PAGE_SIZE);
    expect(
      parseSessionsPageSizeParam(
        new URLSearchParams({ [SESSIONS_PAGE_SIZE_PARAM]: "100.5" }),
        TABLE_PAGE_SIZE_OPTIONS,
        PAGE_SIZE
      )
    ).toBe(PAGE_SIZE);
    expect(
      parseSessionsPageSizeParam(
        new URLSearchParams({ [SESSIONS_PAGE_SIZE_PARAM]: "500" }),
        TABLE_PAGE_SIZE_OPTIONS_EXTENDED,
        PAGE_SIZE
      )
    ).toBe(500);
    expect(
      parseSessionsPageSizeParam(
        new URLSearchParams(),
        TABLE_PAGE_SIZE_OPTIONS,
        PAGE_SIZE
      )
    ).toBe(PAGE_SIZE);
  });

  it("falls back to the current value for an unsupported host page size", () => {
    expect(
      normalizeSessionsPageSize(100, TABLE_PAGE_SIZE_OPTIONS, PAGE_SIZE)
    ).toBe(100);
    expect(normalizeSessionsPageSize(15, TABLE_PAGE_SIZE_OPTIONS, 50)).toBe(50);
  });

  it("omits the default page size and writes non-default values", () => {
    const params = new URLSearchParams({ [SESSIONS_PAGE_SIZE_PARAM]: "100" });

    writeSessionsPageSizeParam(params, PAGE_SIZE, PAGE_SIZE);
    expect(params.has(SESSIONS_PAGE_SIZE_PARAM)).toBe(false);

    writeSessionsPageSizeParam(params, 50, PAGE_SIZE);
    expect(params.get(SESSIONS_PAGE_SIZE_PARAM)).toBe("50");
  });
});
