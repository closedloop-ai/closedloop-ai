/**
 * @description ISS-7249 (whitlockk review, `SessionsView.tsx:664`): "the page is
 * past the end" is a claim only a SUCCESSFUL read can support, and the dead-end
 * classifier suppresses its record whenever that claim is true.
 *
 * The render model falls back to a total of ZERO, which is indistinguishable
 * from a real empty scope. So on `?page=2` with a failed initial read the raw
 * clamp comparison said "out of range" and swallowed the `unavailable` record
 * for the failure the user was actually looking at. The clamp cannot repair
 * that without a response, which is why the settled-total precondition lives
 * inside this predicate rather than in each caller.
 */
import { SESSION_LIST_MAX_OFFSET } from "@repo/api/src/types/agent-session-list-limits";
import { clampSessionsPageIndex } from "@repo/app/agents/lib/session-pagination";
import { describe, expect, it } from "vitest";
import { isSessionsPageOutOfRange } from "../sessions-page-bounds";

const PAGE_SIZE = 25;
// The last page the capped cloud read can serve, and the first it cannot.
const LAST_SERVABLE_PAGE = SESSION_LIST_MAX_OFFSET / PAGE_SIZE;
const FIRST_UNSERVABLE_PAGE = LAST_SERVABLE_PAGE + 1;
// Far more rows than the ceiling can reach, so the ROW count alone would leave
// the page above in range — the cap is the only thing that can exclude it.
const TOTAL_BEYOND_CEILING = 30_000;

describe("isSessionsPageOutOfRange", () => {
  it("does not call a page out of range on a total no read established", () => {
    // The reported defect, exactly: `?page=2`, failed first read, fallback zero.
    expect(
      isSessionsPageOutOfRange({
        hasSettledTotal: false,
        pageIndex: 1,
        pageSize: PAGE_SIZE,
        total: 0,
      })
    ).toBe(false);
    // The raw clamp is what said otherwise — kept as the contrast, so a
    // regression that dropped the precondition cannot pass this file.
    expect(clampSessionsPageIndex(1, 0, PAGE_SIZE)).not.toBe(1);
  });

  it("calls a page out of range once a successful read establishes the total", () => {
    expect(
      isSessionsPageOutOfRange({
        hasSettledTotal: true,
        pageIndex: 1,
        pageSize: PAGE_SIZE,
        total: 0,
      })
    ).toBe(true);
    expect(
      isSessionsPageOutOfRange({
        hasSettledTotal: true,
        pageIndex: 4,
        pageSize: PAGE_SIZE,
        total: 40,
      })
    ).toBe(true);
  });

  it("leaves a page the settled total supports in range", () => {
    expect(
      isSessionsPageOutOfRange({
        hasSettledTotal: true,
        pageIndex: 1,
        pageSize: PAGE_SIZE,
        total: 40,
      })
    ).toBe(false);
    expect(
      isSessionsPageOutOfRange({
        hasSettledTotal: true,
        pageIndex: 0,
        pageSize: PAGE_SIZE,
        total: 0,
      })
    ).toBe(false);
  });

  it("calls a negative page out of range", () => {
    expect(
      isSessionsPageOutOfRange({
        hasSettledTotal: true,
        pageIndex: -1,
        pageSize: PAGE_SIZE,
        total: 51,
      })
    ).toBe(true);
  });
});

/**
 * ISS-9074: the clamp effect and the dead-end classifier must answer "past the
 * end" identically once a host read has an offset ceiling. Capping only one of
 * them left a page between the ceiling and the row count repairable by the
 * clamp and in-range to the classifier.
 *
 * ISS-9555 slice 1 moved the clamp to `@repo/app/agents/lib/session-pagination`,
 * so its half of that agreement is pinned in that module's own suite; what this
 * file owns is the CLASSIFIER reaching the same answer. Every case here is in
 * range on row count alone, so it fails if the ceiling stops being applied.
 */
describe("offset ceiling (ISS-9074)", () => {
  it("agrees with the clamp: a page past the ceiling is out of range", () => {
    expect(
      isSessionsPageOutOfRange({
        hasSettledTotal: true,
        maxOffset: SESSION_LIST_MAX_OFFSET,
        pageIndex: FIRST_UNSERVABLE_PAGE,
        pageSize: PAGE_SIZE,
        total: TOTAL_BEYOND_CEILING,
      })
    ).toBe(true);
    // Without the ceiling the same page is in range — so this pins the cap
    // reaching the CLASSIFIER, not merely the clamp.
    expect(
      isSessionsPageOutOfRange({
        hasSettledTotal: true,
        pageIndex: FIRST_UNSERVABLE_PAGE,
        pageSize: PAGE_SIZE,
        total: TOTAL_BEYOND_CEILING,
      })
    ).toBe(false);
  });

  it("still needs a settled total before the ceiling can rule anything out", () => {
    expect(
      isSessionsPageOutOfRange({
        hasSettledTotal: false,
        maxOffset: SESSION_LIST_MAX_OFFSET,
        pageIndex: FIRST_UNSERVABLE_PAGE,
        pageSize: PAGE_SIZE,
        total: TOTAL_BEYOND_CEILING,
      })
    ).toBe(false);
  });
});
