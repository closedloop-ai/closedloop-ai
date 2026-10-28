import { describe, expect, it } from "vitest";
import { compareOwner, compareStrings } from "./branch-actor-sort";

describe("compareOwner", () => {
  it("treats two equal owners, including two nulls, as unordered", () => {
    expect(compareOwner("ada", "ada")).toBe(0);
    expect(compareOwner(null, null)).toBe(0);
  });

  it("sorts the unattributed bucket after every named owner", () => {
    expect(compareOwner(null, "ada")).toBe(1);
    expect(compareOwner("ada", null)).toBe(-1);
  });

  it("orders named owners lexicographically", () => {
    expect(compareOwner("ada", "grace")).toBe(-1);
    expect(compareOwner("grace", "ada")).toBe(1);
  });

  /**
   * Code-unit ordering, not locale collation. Both the desktop main process and
   * the renderer sort the same actor rows, so the comparison has to give one
   * answer regardless of the process locale — `localeCompare` would put "ada"
   * before "Grace" here and let the same branch order its actors two ways.
   */
  it("compares by code unit so the two producers cannot disagree", () => {
    expect(compareOwner("Grace", "ada")).toBe(-1);
  });

  it("puts the unattributed bucket last when sorting a list", () => {
    expect(["grace", null, "ada"].sort(compareOwner)).toEqual([
      "ada",
      "grace",
      null,
    ]);
  });
});

describe("compareStrings", () => {
  it("treats equal keys as unordered", () => {
    expect(compareStrings("claude-opus", "claude-opus")).toBe(0);
  });

  it("orders keys by code unit", () => {
    expect(compareStrings("claude-opus", "claude-sonnet")).toBe(-1);
    expect(compareStrings("claude-sonnet", "claude-opus")).toBe(1);
  });

  /**
   * Group keys are machine identifiers (model names, ISO hour buckets), so a
   * digit sorting before a letter is the contract both producers rely on — the
   * same reason `compareOwner` avoids `localeCompare`.
   */
  it("sorts digits ahead of letters, as both producers expect", () => {
    expect(compareStrings("2026-01-01T00:00:00.000Z", "gpt-5")).toBe(-1);
  });

  /**
   * The one pair that separates this function's class from the other one the
   * ISS-9585 ruling declares. `"ä"` is U+00E4, so it follows every ASCII letter
   * by code unit and precedes `"z"` under the root collation — an ASCII-only
   * fixture agrees under both and cannot tell them apart. Written out rather
   * than derived from the comparator, so retuning the shared implementation to
   * the collated class reddens this instead of moving with it.
   */
  it("keeps the code-unit class the ruling assigns these keys", () => {
    expect(compareStrings("ärger", "zeta")).toBe(1);
  });
});
