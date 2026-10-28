import { BranchListPageMode } from "@repo/api/src/types/branch-list-contract";
import { describe, expect, it } from "vitest";
import { branchListQuerySchema } from "./branch-list-query";

/**
 * ISS-9585 — the parse boundary, which is where a date-window bound stops being
 * text and becomes an instant.
 *
 * `z.coerce.date()` is `new Date(value)`, so before this ruling a zone-less
 * bound took the parsing HOST's clock and the same saved query selected a
 * different population on each one. Driven through the real schema, because the
 * failure is a request that SUCCEEDS with the wrong instant.
 *
 * The instant is pinned here; that it is the same instant on every host is
 * pinned in `packages/api/src/types/__tests__/list-query-ordering-semantics.test.ts`,
 * because a `process.env.TZ` reassignment does not reach `Date` inside this
 * app's vitest worker and a loop over zones here would agree with itself.
 */
function parseStartDate(startDate: string) {
  return branchListQuerySchema.safeParse({
    pageMode: BranchListPageMode.Server,
    startDate,
  });
}

describe("Branch list date-window anchoring (ISS-9585)", () => {
  it("reads a zone-less bound as the UTC instant", () => {
    const result = parseStartDate("2026-09-25T00:00:00");

    expect(result.success).toBe(true);
    expect(result.data?.startDate).toEqual(new Date(Date.UTC(2026, 8, 25)));
    expect(parseStartDate("2026-09-25T12:30").data?.startDate).toEqual(
      new Date(Date.UTC(2026, 8, 25, 12, 30))
    );
  });

  it("keeps the instant a bound already named for itself", () => {
    expect(parseStartDate("2026-09-25T00:00:00Z").data?.startDate).toEqual(
      new Date(Date.UTC(2026, 8, 25))
    );
    expect(parseStartDate("2026-09-25T00:00:00+02:00").data?.startDate).toEqual(
      new Date(Date.UTC(2026, 8, 24, 22))
    );
    expect(parseStartDate("2026-09-25").data?.startDate).toEqual(
      new Date(Date.UTC(2026, 8, 25))
    );
  });

  it("refuses exactly what it refused before, anchoring nothing extra", () => {
    expect(parseStartDate("garbage").success).toBe(false);
    expect(parseStartDate("").success).toBe(false);
  });
});
