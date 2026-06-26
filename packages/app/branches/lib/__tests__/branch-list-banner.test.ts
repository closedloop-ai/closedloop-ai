import { describe, expect, it } from "vitest";
import { resolveBranchListBanner } from "../branch-list-banner";

const row = (repoFullName: string | null, prNumber: number | null) => ({
  repoFullName,
  prNumber,
});

describe("resolveBranchListBanner", () => {
  it("returns null for an empty corpus", () => {
    expect(resolveBranchListBanner([])).toBe(null);
  });

  it("returns connect-github when no row has a repo identity", () => {
    expect(resolveBranchListBanner([row(null, null), row(null, 12)])).toBe(
      "connect-github"
    );
  });

  it("returns net-new when repos are present but no row has a PR", () => {
    expect(
      resolveBranchListBanner([row("acme/web", null), row("acme/api", null)])
    ).toBe("net-new");
  });

  it("returns null when at least one row carries a PR", () => {
    expect(
      resolveBranchListBanner([row("acme/web", 42), row("acme/web", null)])
    ).toBe(null);
  });

  it("prefers connect-github over net-new (no repo implies no PR)", () => {
    expect(resolveBranchListBanner([row(null, null)])).toBe("connect-github");
  });
});
