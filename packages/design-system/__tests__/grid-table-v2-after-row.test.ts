import {
  AFTER_ROWS_ROW_ID,
  buildAfterGroupRowId,
  buildAfterItemRowId,
  buildAfterRowCellKeys,
} from "@closedloop-ai/design-system/lib/grid-table-v2-after-row";
import { describe, expect, it } from "vitest";

describe("after-row id builders", () => {
  it("AFTER_ROWS_ROW_ID is a namespaced constant", () => {
    expect(AFTER_ROWS_ROW_ID).toContain("__grid-after__");
  });

  it("buildAfterGroupRowId namespaces a group key", () => {
    const id = buildAfterGroupRowId("myGroup");
    expect(id).toContain("__grid-after__");
    expect(id).toContain("group:");
    expect(id).toContain("myGroup");
  });

  it("buildAfterGroupRowId produces distinct ids for distinct groups", () => {
    expect(buildAfterGroupRowId("a")).not.toBe(buildAfterGroupRowId("b"));
  });

  it("buildAfterItemRowId namespaces an item row id", () => {
    const id = buildAfterItemRowId("row-42");
    expect(id).toContain("__grid-after__");
    expect(id).toContain("item:");
    expect(id).toContain("row-42");
  });

  it("buildAfterItemRowId produces distinct ids for distinct items", () => {
    expect(buildAfterItemRowId("a")).not.toBe(buildAfterItemRowId("b"));
  });

  it("group and item ids do not collide even with the same input string", () => {
    expect(buildAfterGroupRowId("x")).not.toBe(buildAfterItemRowId("x"));
  });
});

describe("buildAfterRowCellKeys", () => {
  it("returns exactly one key per after-row", () => {
    const keys = buildAfterRowCellKeys("r1");
    expect(keys).toHaveLength(1);
  });

  it("returns distinct keys for distinct row ids", () => {
    const keysA = buildAfterRowCellKeys("a");
    const keysB = buildAfterRowCellKeys("b");
    expect(keysA[0]).not.toBe(keysB[0]);
  });
});
