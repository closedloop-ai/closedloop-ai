import { describe, expect, it } from "vitest";
import { desktopBranchDetailHashHref } from "../branch-hrefs";

describe("desktopBranchDetailHashHref", () => {
  it("builds a hash-prefixed branch-detail href", () => {
    expect(desktopBranchDetailHashHref({ id: "b-1" })).toBe("#/branches/b-1");
  });

  it("encodes ids containing path separators", () => {
    // A composite `owner/repo::branch` id must stay encoded so the hash router's
    // decodeSegment recovers it intact.
    expect(desktopBranchDetailHashHref({ id: "owner/repo::feat/x" })).toBe(
      "#/branches/owner%2Frepo%3A%3Afeat%2Fx"
    );
  });
});
