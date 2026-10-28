import { describe, expect, it } from "vitest";
import {
  normalizeRepoFullName,
  parseRepositoryFullName,
} from "./branch-repository.ts";

describe("parseRepositoryFullName", () => {
  it.each([
    {
      fullName: "a/b",
      expected: { owner: "a", repo: "b" },
      why: "exactly two non-empty segments is the only accepted shape",
    },
    {
      fullName: "a/b/c",
      expected: null,
      why: "over-segmented: truncating to a/b would rebind the identity to a different repository",
    },
    {
      fullName: "a",
      expected: null,
      why: "no separator, so there is no repo segment",
    },
    { fullName: "", expected: null, why: "empty is not an identity" },
    { fullName: "/b", expected: null, why: "empty owner segment" },
    { fullName: "a/", expected: null, why: "empty repo segment" },
    {
      fullName: "a/b/",
      expected: null,
      why: "a trailing slash is a third (empty) segment, so it is over-segmented — not a well-formed name with cruft",
    },
    {
      fullName: " a/b ",
      expected: { owner: " a", repo: "b " },
      why: "structural only — trimming belongs to normalizeRepoFullName, and this parser must not silently do a second job",
    },
  ])("$fullName -> $why", ({ fullName, expected }) => {
    expect(parseRepositoryFullName(fullName)).toEqual(expected);
  });

  it("rejects an inner double slash, which normalization does not collapse", () => {
    // normalizeRepoFullName strips LEADING and TRAILING slashes only, so `a//b`
    // survives it intact and must be rejected here rather than read as `a/b`.
    expect(parseRepositoryFullName(normalizeRepoFullName("a//b"))).toBeNull();
  });

  it("rejects every extra segment, not just the third", () => {
    expect(parseRepositoryFullName("a/b/c/d")).toBeNull();
  });

  it("accepts a normalized name, so normalize-then-parse is the composed contract", () => {
    expect(
      parseRepositoryFullName(normalizeRepoFullName(" Acme/Widgets.git "))
    ).toEqual({ owner: "acme", repo: "widgets" });
  });
});

describe("normalizeRepoFullName", () => {
  it.each([
    { fullName: "acme/widgets", expected: "acme/widgets" },
    { fullName: "Acme/Widgets", expected: "acme/widgets" },
    { fullName: "  acme/widgets  ", expected: "acme/widgets" },
    { fullName: "acme/widgets.git", expected: "acme/widgets" },
    { fullName: "acme/widgets.GIT", expected: "acme/widgets" },
    { fullName: "/acme/widgets/", expected: "acme/widgets" },
    { fullName: "  /Acme/Widgets.git/  ", expected: "acme/widgets" },
  ])("$fullName -> $expected", ({ fullName, expected }) => {
    expect(normalizeRepoFullName(fullName)).toBe(expected);
  });

  it("is idempotent, so it is safe to apply defensively at every read and write site", () => {
    const once = normalizeRepoFullName("  /Acme/Widgets.git/  ");
    expect(normalizeRepoFullName(once)).toBe(once);
  });
});
