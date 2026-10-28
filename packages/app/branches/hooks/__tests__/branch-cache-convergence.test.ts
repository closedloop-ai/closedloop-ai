import { describe, expect, it } from "vitest";
import {
  coveringPrefixes,
  excludedFamilies,
  isQueryKeyPrefixOf,
} from "../../../shared/query/list-cache-convergence";
import {
  branchAlwaysConvergePrefixes,
  branchBroadConvergePrefixes,
  branchCacheConvergence,
} from "../branch-cache-convergence";
import { branchesKeys } from "../use-branches";

const SCOPE = "scope-under-test";
const BRANCH_ID = "branch-1";
const SERVED_ORDERING_REASON_PATTERN = /producer is serving/;

/** Compare prefix sets without pinning an order invalidation does not carry. */
function sortedKeys(
  prefixes: readonly (readonly unknown[])[]
): readonly string[] {
  return prefixes.map((prefix) => JSON.stringify(prefix)).sort();
}

/**
 * Every family of `branchesKeys`, written out by hand rather than derived from
 * the key object, so a new or deleted family fails here instead of agreeing
 * with whatever the object currently holds.
 */
const EXPECTED_FAMILIES = [
  "all",
  "lists",
  "list",
  "details",
  "detail",
  "commentsRoot",
  "comments",
  "traces",
  "trace",
  "usages",
  "usage",
  "analyticsRoot",
  "analytics",
  "cohortAnalyticsRoot",
  "cohortAnalytics",
  "pageDataRoot",
  "pageData",
  "listStatusOrdering",
];

describe("branchCacheConvergence", () => {
  it("classifies every family the key object exposes, and no others", () => {
    expect(Object.keys(branchesKeys).sort()).toEqual(
      [...EXPECTED_FAMILIES].sort()
    );
    expect(Object.keys(branchCacheConvergence).sort()).toEqual(
      [...EXPECTED_FAMILIES].sort()
    );
  });

  it("converges every corpus-derived read on every flush, including the standalone list", () => {
    // `["branches", "list"]` is the gap this contract was written for: the
    // bridge's hand-maintained set omitted it. Latent rather than live — its
    // only reader, the split page-data path, has no live-source consumer today —
    // so this pins the classification, not a visible bug. Literals throughout,
    // never reads of `branchesKeys`.
    expect(sortedKeys(branchAlwaysConvergePrefixes())).toEqual(
      sortedKeys([
        ["branches", "list"],
        ["branches", "usage"],
        ["branches", "analytics"],
        ["branches", "cohort-analytics"],
        ["branches", "page-data"],
      ])
    );
  });

  it("sweeps detail, trace, and comments on a broad change", () => {
    expect(sortedKeys(branchBroadConvergePrefixes())).toEqual(
      sortedKeys([
        ["branches", "detail"],
        ["branches", "trace"],
        ["branches", "comments"],
      ])
    );
  });

  it("reaches the exact key the split page-data list read registers", () => {
    // The positive proof that the fix is wired end to end: the exact list key
    // the split path of `useBranchesPageData` registers must be matched by a
    // converging prefix. That path has no live-source consumer today, so this
    // pins the contract for the first one rather than reproducing a
    // currently-visible staleness bug.
    const listKey = branchesKeys.list(SCOPE, { owner: "alice" });

    expect(
      branchAlwaysConvergePrefixes().some((prefix) =>
        isQueryKeyPrefixOf(prefix, listKey)
      )
    ).toBe(true);
  });

  it("never converges the served status ordering, and records why", () => {
    const excluded = excludedFamilies(branchCacheConvergence);

    expect([...excluded.keys()]).toEqual(["listStatusOrdering"]);
    expect(excluded.get("listStatusOrdering")).toMatch(
      SERVED_ORDERING_REASON_PATTERN
    );
  });

  it("keeps the served status ordering out of the converging set", () => {
    const orderingKey = branchesKeys.listStatusOrdering(SCOPE, {});
    const converging = [
      ...branchAlwaysConvergePrefixes(),
      ...branchBroadConvergePrefixes(),
    ];

    expect(
      converging.some((prefix) => isQueryKeyPrefixOf(prefix, orderingKey))
    ).toBe(false);
  });

  it("proves each exact key is actually reached by the prefix the CONTRACT claims covers it", () => {
    // The covering prefix comes from the contract, not from a hand-written pair:
    // a pair keeps agreeing with itself after the declaration it polices moved.
    const sampleExactKeys: Readonly<Record<string, readonly unknown[]>> = {
      analytics: branchesKeys.analytics(SCOPE, {}),
      cohortAnalytics: branchesKeys.cohortAnalytics(SCOPE, null),
      comments: branchesKeys.comments(SCOPE, BRANCH_ID),
      detail: branchesKeys.detail(SCOPE, BRANCH_ID),
      list: branchesKeys.list(SCOPE, {}),
      pageData: branchesKeys.pageData(SCOPE, {}),
      trace: branchesKeys.trace(SCOPE, BRANCH_ID),
      usage: branchesKeys.usage(SCOPE, {}),
    };
    const covering = coveringPrefixes(branchesKeys, branchCacheConvergence);

    expect([...covering.keys()].sort()).toEqual(
      Object.keys(sampleExactKeys).sort()
    );
    for (const [familyName, prefix] of covering) {
      expect(isQueryKeyPrefixOf(prefix, sampleExactKeys[familyName])).toBe(
        true
      );
    }
  });

  it("keeps every family under the shared namespace root", () => {
    const root = branchesKeys.all;

    expect(root).toEqual(["branches"]);
    for (const prefix of [
      ...branchAlwaysConvergePrefixes(),
      ...branchBroadConvergePrefixes(),
    ]) {
      expect(isQueryKeyPrefixOf(root, prefix)).toBe(true);
    }
  });
});
