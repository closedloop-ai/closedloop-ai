import { describe, expect, it } from "vitest";
import { computeLineDelta, countDiffFiles } from "./parser-utils";

// ---------------------------------------------------------------------------
// computeLineDelta — null/undefined inputs (lines 196-197)
// ---------------------------------------------------------------------------

describe("computeLineDelta — null/undefined inputs", () => {
  it("treats null oldText as an empty line set (no deletions)", () => {
    // null oldText → oldLines = [] → all new lines are additions
    expect(computeLineDelta(null, "a\nb")).toEqual({ add: 2, del: 0 });
  });

  it("treats undefined oldText as an empty line set", () => {
    expect(computeLineDelta(undefined, "x")).toEqual({ add: 1, del: 0 });
  });

  it("treats null newText as an empty line set (only deletions)", () => {
    // null newText → newLines = [] → all old lines are deletions
    expect(computeLineDelta("a\nb", null)).toEqual({ add: 0, del: 2 });
  });

  it("treats undefined newText as an empty line set", () => {
    expect(computeLineDelta("x", undefined)).toEqual({ add: 0, del: 1 });
  });

  it("returns {add:0,del:0} when both inputs are null", () => {
    expect(computeLineDelta(null, null)).toEqual({ add: 0, del: 0 });
  });

  it("counts N duplicate lines as N additions (multiset, not Set)", () => {
    // "x" appears twice in new, 0 times in old → add = 2, not 1
    expect(computeLineDelta("", "x\nx")).toEqual({ add: 2, del: 0 });
  });

  it("counts a pure content change as add=1, del=1", () => {
    expect(computeLineDelta("old line", "new line")).toEqual({
      add: 1,
      del: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// countDiffFiles — lines 235-248
// ---------------------------------------------------------------------------

describe("countDiffFiles — '--- ' unified-diff header (branch 39[0])", () => {
  it("counts a single '--- ' header", () => {
    expect(countDiffFiles("--- a/file.ts\n+++ b/file.ts")).toBe(1);
  });

  it("does not count '---' without trailing space as a file header", () => {
    // The separator line in some diff formats; must NOT match
    expect(countDiffFiles("---\nsome content")).toBe(0);
  });
});

describe("countDiffFiles — '*** Add File:' header (branch 39[1])", () => {
  it("counts a single '*** Add File:' header", () => {
    expect(countDiffFiles("*** Add File: src/new.ts\n+hello")).toBe(1);
  });
});

describe("countDiffFiles — '*** Update File:' header (branch 39[2])", () => {
  it("counts a single '*** Update File:' header", () => {
    expect(
      countDiffFiles("*** Update File: src/changed.ts\n@@\n-old\n+new")
    ).toBe(1);
  });
});

describe("countDiffFiles — '*** Delete File:' header (branch 39[3])", () => {
  it("counts a single '*** Delete File:' header", () => {
    expect(countDiffFiles("*** Delete File: src/gone.ts\n-bye")).toBe(1);
  });
});

describe("countDiffFiles — non-matching lines (branch 38[1] FALSE path)", () => {
  it("returns 0 for a patch containing only +/- content lines", () => {
    expect(countDiffFiles("+added line\n-removed line\n context line")).toBe(0);
  });

  it("returns 0 for an empty string", () => {
    expect(countDiffFiles("")).toBe(0);
  });

  it("returns 0 for lines that almost match but lack the required prefix", () => {
    expect(countDiffFiles("--  a/foo.ts\n** Update File: bar.ts")).toBe(0);
  });
});

describe("countDiffFiles — multiple headers", () => {
  it("counts all four header types in a combined patch", () => {
    const patch = [
      "--- a/old.ts",
      "+++ b/new.ts",
      "*** Add File: src/added.ts",
      "*** Update File: src/updated.ts",
      "*** Delete File: src/deleted.ts",
    ].join("\n");
    // "--- a/old.ts" counts, the three *** headers count → 4 total
    expect(countDiffFiles(patch)).toBe(4);
  });

  it("counts each '--- ' occurrence independently", () => {
    const patch = "--- a/foo.ts\n+++ b/foo.ts\n--- a/bar.ts\n+++ b/bar.ts";
    expect(countDiffFiles(patch)).toBe(2);
  });
});
