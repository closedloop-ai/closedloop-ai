import { describe, expect, it } from "vitest";
import { z } from "zod";
import { findIssue } from "./zod-issue.test-helpers";

const ISSUES = [
  { path: [], message: "root rejected", code: "custom" },
  { path: ["slug"], message: "too short", code: "too_small" },
  { path: ["slug"], message: "also reserved", code: "custom" },
  {
    path: ["evidence", "reason"],
    message: "bad reason",
    code: "invalid_value",
  },
  { path: ["items", 0], message: "bad element", code: "invalid_type" },
];

describe("findIssue", () => {
  it("returns the issue raised at that exact path", () => {
    expect(findIssue(ISSUES, ["evidence", "reason"])).toEqual({
      path: ["evidence", "reason"],
      message: "bad reason",
      code: "invalid_value",
    });
  });

  it("returns undefined when no issue was raised at that path", () => {
    expect(findIssue(ISSUES, ["branchName"])).toBeUndefined();
  });

  it("matches the whole path, not a prefix of it in either direction", () => {
    expect(findIssue(ISSUES, ["evidence"])).toBeUndefined();
    expect(findIssue(ISSUES, ["evidence", "reason", "detail"])).toBeUndefined();
  });

  it("distinguishes the root path from a field path", () => {
    expect(findIssue(ISSUES, [])?.message).toBe("root rejected");
  });

  it("distinguishes an array index from the string that spells it", () => {
    expect(findIssue(ISSUES, ["items", 0])?.message).toBe("bad element");
    expect(findIssue(ISSUES, ["items", "0"])).toBeUndefined();
  });

  it("returns the FIRST issue when one path collected several", () => {
    expect(findIssue(ISSUES, ["slug"])?.code).toBe("too_small");
  });

  it("selects one field's issue out of a real multi-issue Zod rejection", () => {
    const schema = z.object({
      slug: z.string().min(3),
      count: z.number().int(),
    });

    const result = schema.safeParse({ slug: "x", count: 1.5 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(1);
      expect(findIssue(result.error.issues, ["count"])?.code).toBe(
        "invalid_type"
      );
      expect(findIssue(result.error.issues, ["slug"])?.code).toBe("too_small");
    }
  });
});
