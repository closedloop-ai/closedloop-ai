import { describe, expect, it } from "vitest";
import { resolveSqlNativeSingleSortRequest } from "./session-list-sql-reader";

describe("resolveSqlNativeSingleSortRequest", () => {
  it("resolves a single updated rule", () => {
    expect(
      resolveSqlNativeSingleSortRequest({ sortBy: "updated", sortDir: "asc" })
    ).toEqual({ column: "updated", dir: "asc" });
  });

  it("defaults sortDir to desc, matching the scalar rule's own default", () => {
    expect(resolveSqlNativeSingleSortRequest({ sortBy: "updated" })).toEqual({
      column: "updated",
      dir: "desc",
    });
  });

  it("resolves a single user rule", () => {
    expect(
      resolveSqlNativeSingleSortRequest({ sortBy: "user", sortDir: "asc" })
    ).toEqual({ column: "user", dir: "asc" });
  });

  it("resolves a single duration rule", () => {
    expect(
      resolveSqlNativeSingleSortRequest({ sortBy: "duration", sortDir: "asc" })
    ).toEqual({ column: "duration", dir: "asc" });
  });

  it("is null for a DB-native column — already cheap via the existing path", () => {
    expect(
      resolveSqlNativeSingleSortRequest({ sortBy: "cost", sortDir: "asc" })
    ).toBeNull();
  });

  it("is null with no explicit sort", () => {
    expect(resolveSqlNativeSingleSortRequest({})).toBeNull();
  });

  it("is null for a compound chain, even one entirely on `updated`", () => {
    expect(
      resolveSqlNativeSingleSortRequest({
        sorts: [
          { column: "updated", dir: "asc" },
          { column: "repo", dir: "desc" },
        ],
      })
    ).toBeNull();
  });

  it("resolves a single-entry `sorts` list the same as the scalar spelling", () => {
    expect(
      resolveSqlNativeSingleSortRequest({
        sorts: [{ column: "updated", dir: "asc" }],
      })
    ).toEqual({ column: "updated", dir: "asc" });
  });
});
