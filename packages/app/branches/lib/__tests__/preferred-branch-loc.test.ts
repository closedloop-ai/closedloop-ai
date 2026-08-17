import { describe, expect, it } from "vitest";
import { makeBranchDetail } from "../../__tests__/branch-fixtures";
import {
  resolveChurn,
  resolvePreferredBranchLoc,
} from "../preferred-branch-loc";

describe("resolvePreferredBranchLoc", () => {
  it("reads the projection's changed-LOC and sums gross churn", () => {
    const detail = makeBranchDetail({
      repoFullName: "octo/repo",
      prNumber: 42,
      additions: 10,
      deletions: 6,
    });

    const loc = resolvePreferredBranchLoc(detail);

    expect(loc.additions).toBe(10);
    expect(loc.deletions).toBe(6);
    // Deletions ADD to churn — this is gross churn, never a net figure.
    expect(loc.churn).toBe(16);
  });

  it("is unavailable — not zero — when the projection holds no LOC", () => {
    const detail = makeBranchDetail({
      repoFullName: "octo/repo",
      prNumber: null,
      additions: null,
      deletions: null,
    });

    const loc = resolvePreferredBranchLoc(detail);

    expect(loc.additions).toBeNull();
    expect(loc.deletions).toBeNull();
    expect(loc.churn).toBeNull();
  });

  it.each([
    { additions: 12, deletions: null },
    { additions: null, deletions: 4 },
  ])("refuses to fabricate the missing side when only one dimension is present (%o)", (columns) => {
    const detail = makeBranchDetail({
      repoFullName: "octo/repo",
      prNumber: 42,
      ...columns,
    });

    const loc = resolvePreferredBranchLoc(detail);

    expect(loc.additions).toBeNull();
    expect(loc.deletions).toBeNull();
    expect(loc.churn).toBeNull();
  });

  it("tolerates a detail that has not loaded yet", () => {
    expect(resolvePreferredBranchLoc(undefined).churn).toBeNull();
    expect(resolvePreferredBranchLoc(null).churn).toBeNull();
  });
});

describe("resolveChurn", () => {
  it("prefers a pre-resolved loc over the detail columns", () => {
    const detail = makeBranchDetail({ additions: 999, deletions: 999 });

    expect(resolveChurn({ additions: 3, deletions: 4, churn: 7 }, detail)).toBe(
      7
    );
  });

  it("carries a pre-resolved unavailable through instead of falling back", () => {
    const detail = makeBranchDetail({ additions: 999, deletions: 999 });

    expect(
      resolveChurn({ additions: null, deletions: null, churn: null }, detail)
    ).toBeNull();
  });

  it("falls back to the detail columns when no loc is supplied", () => {
    const detail = makeBranchDetail({ additions: 12, deletions: 4 });

    expect(resolveChurn(undefined, detail)).toBe(16);
  });

  it("is null when neither loc nor complete detail columns are available", () => {
    const detail = makeBranchDetail({ additions: null, deletions: null });

    expect(resolveChurn(undefined, detail)).toBeNull();
  });
});
