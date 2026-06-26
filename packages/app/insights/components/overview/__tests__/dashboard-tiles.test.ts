import { getTile } from "@repo/app/insights/lib/tile-catalog";
import { describe, expect, it } from "vitest";
import { DASHBOARD_ROWS, resolveRowTiles } from "../dashboard-tiles";

/**
 * Makes the "a typo fails fast in tests" guarantee real: every tile id wired
 * into DASHBOARD_ROWS must resolve in the shared catalog. Without this,
 * `resolveRowTiles` silently drops an unknown id at render and the row just
 * goes missing in the running app.
 */
describe("DASHBOARD_ROWS tile ids", () => {
  const wiredIds = DASHBOARD_ROWS.flatMap((row) => row.tileIds);

  it.each(wiredIds)("'%s' resolves in the shared tile catalog", (id) => {
    expect(getTile(id)).toBeDefined();
  });

  it("resolveRowTiles drops nothing for any configured row", () => {
    for (const row of DASHBOARD_ROWS) {
      expect(resolveRowTiles(row)).toHaveLength(row.tileIds.length);
    }
  });
});
