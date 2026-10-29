/**
 * @file usage-facet-projections.test.ts
 * @description ISS-10851 — the LIVE facet projections' published order, and
 * that it is the same order the SQL candidate publishes.
 *
 * This module had no test file at all, so every tiebreak clause in it could be
 * deleted without a suite going red. The cases below are the counterfactual:
 * each feeds EQUAL session counts in an input order that is the reverse of the
 * published one, so each one fails on exactly the deletion it names.
 *
 * WHY THE PARITY CASE AT THE END. A tiebreak added to only one of the two
 * producers recreates the divergence this work exists to close — the two are
 * meant to be interchangeable for one population. Pinning each side's order
 * separately cannot catch a pair that drifts apart while each stays internally
 * consistent; feeding both the same tied population and comparing the two
 * outputs can.
 */
import type { BasicUser } from "@repo/api/src/types/user";
import { describe, expect, it } from "vitest";
import {
  buildUsageByHarness,
  buildUsageByRepository,
  buildUsageByUser,
} from "./usage-facet-projections";
import {
  projectByHarness,
  projectByRepository,
  projectByUser,
} from "./usage-sql-projections";
import type { UsageSqlFacetCount } from "./usage-sql-reader";

/** Equal on every side, so only the tiebreak can decide. */
const TIED = 7;

const sums = () => ({
  _count: { _all: TIED },
  _sum: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 0,
  },
});

/**
 * One display name for every owner. Names collide in production and are the
 * default shape of a fixture, which is why neither producer may key on them.
 */
const user = (id: string): BasicUser =>
  ({
    id,
    email: `${id}@example.com`,
    firstName: "Test",
    lastName: "User",
    avatarUrl: null,
  }) as BasicUser;

const sqlRow = (over: Partial<UsageSqlFacetCount>): UsageSqlFacetCount => ({
  dimension: "owner",
  value: "u1",
  sessionCount: TIED,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimatedCost: 0,
  errorCount: 0,
  ...over,
});

const USERS = new Map([
  ["u-a", user("u-a")],
  ["u-b", user("u-b")],
  ["u-c", user("u-c")],
]);

describe("buildUsageByUser", () => {
  it("orders a session-count tie by userId, not by the input order", () => {
    const out = buildUsageByUser(
      [
        { userId: "u-c", ...sums() },
        { userId: "u-a", ...sums() },
        { userId: "u-b", ...sums() },
      ],
      USERS
    );
    expect(out.map((r) => r.userId)).toEqual(["u-a", "u-b", "u-c"]);
    // All three share one display name, so a name-keyed tiebreak would have
    // left the input order standing and this assertion would not hold.
    expect(new Set(out.map((r) => r.userName)).size).toBe(1);
  });

  it("still ranks a higher session count above the tiebreak", () => {
    const out = buildUsageByUser(
      [
        { userId: "u-a", ...sums() },
        { userId: "u-c", _count: { _all: TIED + 1 }, _sum: sums()._sum },
      ],
      USERS
    );
    // `u-a` wins the tiebreak but loses the count; count leads.
    expect(out.map((r) => r.userId)).toEqual(["u-c", "u-a"]);
  });
});

describe("buildUsageByHarness", () => {
  it("orders a session-count tie by harness", () => {
    const out = buildUsageByHarness([
      { harness: "codex", ...sums() },
      { harness: "claude", ...sums() },
    ]);
    expect(out.map((r) => r.harness)).toEqual(["claude", "codex"]);
  });
});

describe("buildUsageByRepository", () => {
  it("orders a session-count tie by repositoryFullName", () => {
    const out = buildUsageByRepository([
      {
        repositoryFullName: "o/z",
        _count: { _all: TIED },
        _sum: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
      },
      {
        repositoryFullName: "o/a",
        _count: { _all: TIED },
        _sum: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
      },
    ]);
    expect(out.map((r) => r.repositoryFullName)).toEqual(["o/a", "o/z"]);
  });
});

describe("ISS-10851 — the live and SQL-candidate paths publish one order", () => {
  it("agrees on a tied owner facet fed to both in opposite input orders", () => {
    // Opposite input orders on purpose: identical inputs would agree even if
    // both producers fell through to their own row order.
    const live = buildUsageByUser(
      [
        { userId: "u-c", ...sums() },
        { userId: "u-b", ...sums() },
        { userId: "u-a", ...sums() },
      ],
      USERS
    );
    const candidate = projectByUser(
      [
        sqlRow({ value: "u-a" }),
        sqlRow({ value: "u-b" }),
        sqlRow({ value: "u-c" }),
      ],
      USERS
    );
    expect(candidate.map((r) => r.userId)).toEqual(live.map((r) => r.userId));
  });

  it("agrees on a tied harness facet", () => {
    const live = buildUsageByHarness([
      { harness: "codex", ...sums() },
      { harness: "claude", ...sums() },
    ]);
    const candidate = projectByHarness([
      sqlRow({ dimension: "harness", value: "claude" }),
      sqlRow({ dimension: "harness", value: "codex" }),
    ]);
    expect(candidate.map((r) => r.harness)).toEqual(live.map((r) => r.harness));
  });

  it("agrees on a tied repository facet", () => {
    const live = buildUsageByRepository([
      {
        repositoryFullName: "o/z",
        _count: { _all: TIED },
        _sum: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
      },
      {
        repositoryFullName: "o/a",
        _count: { _all: TIED },
        _sum: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
      },
    ]);
    const candidate = projectByRepository([
      sqlRow({ dimension: "repository", value: "o/a" }),
      sqlRow({ dimension: "repository", value: "o/z" }),
    ]);
    expect(candidate.map((r) => r.repositoryFullName)).toEqual(
      live.map((r) => r.repositoryFullName)
    );
  });
});
