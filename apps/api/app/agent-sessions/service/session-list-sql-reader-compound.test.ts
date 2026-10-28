import { describe, expect, it } from "vitest";
import { resolveSqlNativeCompoundSortRequest } from "./session-list-sql-reader";

describe("resolveSqlNativeCompoundSortRequest", () => {
  it("resolves a two-rule chain the live page orders in memory", () => {
    expect(
      resolveSqlNativeCompoundSortRequest({
        sorts: [
          { column: "updated", dir: "desc" },
          { column: "repo", dir: "asc" },
        ],
      })
    ).toEqual({
      rules: [
        { column: "updated", dir: "desc" },
        { column: "repo", dir: "asc" },
      ],
    });
  });

  it("resolves the four-rule boundary", () => {
    const rules = [
      { column: "cost", dir: "asc" },
      { column: "repo", dir: "desc" },
      { column: "duration", dir: "asc" },
      { column: "user", dir: "desc" },
    ] as const;
    expect(resolveSqlNativeCompoundSortRequest({ sorts: [...rules] })).toEqual({
      rules,
    });
  });

  it("is null for a single rule — the dedicated statements already serve it", () => {
    expect(
      resolveSqlNativeCompoundSortRequest({
        sorts: [{ column: "cost", dir: "asc" }],
      })
    ).toBeNull();
    expect(
      resolveSqlNativeCompoundSortRequest({ sortBy: "cost", sortDir: "asc" })
    ).toBeNull();
  });

  it("is null with no explicit sort", () => {
    expect(resolveSqlNativeCompoundSortRequest({})).toBeNull();
  });

  it("is null past the four-rule cap (D15 amended) — the in-memory path keeps a five-rule chain", () => {
    expect(
      resolveSqlNativeCompoundSortRequest({
        sorts: [
          { column: "cost", dir: "asc" },
          { column: "repo", dir: "desc" },
          { column: "duration", dir: "asc" },
          { column: "user", dir: "desc" },
          { column: "status", dir: "asc" },
        ],
      })
    ).toBeNull();
  });

  // The ARM gate: this statement mirrors the in-memory comparators, so a chain
  // Prisma orders itself is not one it can be the candidate for (marisolashgrove
  // and tamsinb on #8732). The pair of cases below holds the rule COUNT at a
  // value the cap already accepts and varies only whether a display column is
  // present, so the cap cannot be what makes the null case pass.
  it("is null for an all-DB-native chain — Prisma orders that arm itself, under a different collation", () => {
    expect(
      resolveSqlNativeCompoundSortRequest({
        sorts: [
          { column: "cost", dir: "asc" },
          { column: "repo", dir: "desc" },
        ],
      })
    ).toBeNull();
    // An all-DB chain ending in `lastActivity` also picks up
    // `dbColumnNarrowing`'s `sessionStartedAt desc` on the live side, which no
    // slot in this statement emits.
    expect(
      resolveSqlNativeCompoundSortRequest({
        sorts: [
          { column: "cost", dir: "asc" },
          { column: "lastActivity", dir: "desc" },
        ],
      })
    ).toBeNull();
  });

  it("resolves those same chains once ONE display column joins them", () => {
    expect(
      resolveSqlNativeCompoundSortRequest({
        sorts: [
          { column: "cost", dir: "asc" },
          { column: "repo", dir: "desc" },
          { column: "user", dir: "asc" },
        ],
      })
    ).not.toBeNull();
    expect(
      resolveSqlNativeCompoundSortRequest({
        sorts: [
          { column: "cost", dir: "asc" },
          { column: "lastActivity", dir: "desc" },
          { column: "duration", dir: "asc" },
        ],
      })
    ).not.toBeNull();
  });
});
