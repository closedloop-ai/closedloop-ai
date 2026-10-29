import { describe, expect, it } from "vitest";
import {
  type MergedPullRequestTwinRow,
  mergedPullRequestLoc,
  resolveMergedPullRequestTwins,
} from "./merged-pr-twin-resolution";

type Row = MergedPullRequestTwinRow & { id: string; identity: string };

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "row-1",
    identity: "repo:acme/web#42",
    githubId: null,
    additions: 10,
    deletions: 5,
    ...overrides,
  };
}

const identityOf = (value: Row) => value.identity;

describe("mergedPullRequestLoc", () => {
  it("treats a half-projected row as unknown, not as a one-sided diff", () => {
    expect(
      mergedPullRequestLoc(row({ additions: 10, deletions: null }))
    ).toBeNull();
    expect(
      mergedPullRequestLoc(row({ additions: null, deletions: 5 }))
    ).toBeNull();
  });

  it("distinguishes a known-zero PR from an unknown one", () => {
    expect(mergedPullRequestLoc(row({ additions: 0, deletions: 0 }))).toBe(0);
    expect(
      mergedPullRequestLoc(row({ additions: null, deletions: null }))
    ).toBeNull();
  });

  it("treats a non-finite or absent count as unknown, never as NaN", () => {
    // This reads a persistence boundary: a row that never selected the column
    // presents as `undefined`, and a corrupt projection can carry NaN or
    // Infinity. A `=== null` check alone let those through and produced a NaN
    // KLOC — garbage on screen instead of the honest unknown the caller handles.
    const absent = {
      additions: undefined,
      deletions: undefined,
    } as unknown as Pick<Row, "additions" | "deletions">;

    expect(mergedPullRequestLoc(row(absent))).toBeNull();
    expect(
      mergedPullRequestLoc(row({ additions: Number.NaN, deletions: 5 }))
    ).toBeNull();
    expect(
      mergedPullRequestLoc(
        row({ additions: Number.POSITIVE_INFINITY, deletions: 5 })
      )
    ).toBeNull();
  });

  it("treats a negative count as unknown, not as a subtraction", () => {
    // `Number.isFinite(-5)` is true, so a corrupt projection would otherwise
    // subtract from the KLOC sum and could drive lines-per-dollar below zero —
    // a figure no diff can produce.
    expect(
      mergedPullRequestLoc(row({ additions: -5, deletions: 5 }))
    ).toBeNull();
    expect(
      mergedPullRequestLoc(row({ additions: 10, deletions: -1 }))
    ).toBeNull();
  });
});

describe("resolveMergedPullRequestTwins", () => {
  it("lets a sized twin win over an unsized one, whatever the arrival order", () => {
    const unsized = row({
      id: "row-unsized",
      additions: null,
      deletions: null,
    });
    const sized = row({ id: "row-sized", additions: 7, deletions: 3 });

    expect(
      resolveMergedPullRequestTwins([unsized, sized], identityOf).values
    ).toEqual([sized]);
    expect(
      resolveMergedPullRequestTwins([sized, unsized], identityOf).values
    ).toEqual([sized]);
  });

  it("lets the App-owned row settle a size disagreement, not arrival order", () => {
    const appRow = row({
      id: "row-app",
      githubId: "PR_node_1",
      additions: 100,
    });
    const desktopRow = row({ id: "row-desktop", additions: 7 });

    expect(
      resolveMergedPullRequestTwins([appRow, desktopRow], identityOf).values
    ).toEqual([appRow]);
    expect(
      resolveMergedPullRequestTwins([desktopRow, appRow], identityOf).values
    ).toEqual([appRow]);
    expect(
      resolveMergedPullRequestTwins([desktopRow, appRow], identityOf)
        .unsettledDisagreementCount
    ).toBe(0);
  });

  it("keeps the pull request when two rows disagree and neither claims authority", () => {
    // ISS-11589: the defect being fixed is a disagreement ERASING the PR. With
    // no githubId on either side the first row stands, but the identity stays
    // in the population either way — and the fact that arrival order decided it
    // is reported, so a caller cannot publish the winner as settled.
    const first = row({ id: "row-a", additions: 30, deletions: 0 });
    const second = row({ id: "row-b", additions: 40, deletions: 0 });

    const resolved = resolveMergedPullRequestTwins([first, second], identityOf);

    expect(resolved.values).toEqual([first]);
    expect(resolved.unidentifiedCount).toBe(0);
    expect(resolved.unsettledDisagreementCount).toBe(1);
  });

  it("reports no unsettled disagreement when the twins agree on size", () => {
    const first = row({ id: "row-a", additions: 30, deletions: 0 });
    const second = row({ id: "row-b", additions: 30, deletions: 0 });

    expect(
      resolveMergedPullRequestTwins([first, second], identityOf)
        .unsettledDisagreementCount
    ).toBe(0);
  });

  it("keeps distinct identities apart and preserves first-seen order", () => {
    const first = row({ id: "row-a", identity: "repo:acme/web#1" });
    const second = row({ id: "row-b", identity: "repo:acme/web#2" });

    expect(
      resolveMergedPullRequestTwins([first, second], identityOf).values
    ).toEqual([first, second]);
  });

  it("drops and counts a row whose identity key is empty", () => {
    const anonymous = row({ id: "row-anon", identity: "" });
    const keyed = row({ id: "row-keyed" });

    const resolved = resolveMergedPullRequestTwins(
      [anonymous, keyed],
      identityOf
    );

    expect(resolved.values).toEqual([keyed]);
    expect(resolved.unidentifiedCount).toBe(1);
  });
});
