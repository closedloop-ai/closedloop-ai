/**
 * `getPrismaRawQuerySqlState` — reading the PostgreSQL SQLSTATE out of a failed
 * raw query.
 *
 * This exists because the obvious implementation is wrong: for a raw query
 * Prisma puts its OWN code (`P2010`) on `error.code` and nests the driver's
 * SQLSTATE in `error.meta.code`. A caller that branches on `error.code` alone
 * compiles, type-checks, and silently never matches — the branch becomes dead
 * code that only shows up as mis-classified production errors.
 */

import { describe, expect, it } from "vitest";
import { getPrismaRawQuerySqlState } from "@/lib/db-utils";

/** The shape Prisma actually throws for a failed `$executeRawUnsafe`. */
function prismaRawQueryError(sqlState: string): Error {
  return Object.assign(new Error("Raw query failed"), {
    code: "P2010",
    meta: {
      code: sqlState,
      message: "canceling statement due to lock timeout",
    },
  });
}

describe("getPrismaRawQuerySqlState", () => {
  it("reads the SQLSTATE from meta.code on a Prisma raw-query error", () => {
    expect(getPrismaRawQuerySqlState(prismaRawQueryError("55P03"))).toBe(
      "55P03"
    );
  });

  it("does not return Prisma's own P2010 wrapper code", () => {
    // The whole point: P2010 is Prisma's envelope, not the server condition.
    expect(getPrismaRawQuerySqlState(prismaRawQueryError("57014"))).not.toBe(
      "P2010"
    );
  });

  it("accepts a SQLSTATE surfaced directly on code by other adapters", () => {
    const err = Object.assign(new Error("lock not available"), {
      code: "55P03",
    });
    expect(getPrismaRawQuerySqlState(err)).toBe("55P03");
  });

  it.each([
    "P2002",
    "P2010",
    "P1002",
  ])("ignores Prisma's own error code %s, which also looks like a SQLSTATE", (code) => {
    // These are five [0-9A-Z] characters too, so a naive SQLSTATE pattern
    // returns them and a caller mistakes a Prisma envelope for a server-side
    // condition.
    const err = Object.assign(new Error("prisma error"), { code });
    expect(getPrismaRawQuerySqlState(err)).toBeUndefined();
  });

  it("still accepts PostgreSQL's real P0xxx class", () => {
    // P0001 (raise_exception) is a genuine SQLSTATE and must not be swept up by
    // the Prisma-code exclusion.
    const err = Object.assign(new Error("raise_exception"), { code: "P0001" });
    expect(getPrismaRawQuerySqlState(err)).toBe("P0001");
  });

  it("returns undefined for errors carrying no code at all", () => {
    expect(getPrismaRawQuerySqlState(new Error("boom"))).toBeUndefined();
  });

  it("returns undefined for non-error values", () => {
    expect(getPrismaRawQuerySqlState(null)).toBeUndefined();
    expect(getPrismaRawQuerySqlState("55P03")).toBeUndefined();
    expect(getPrismaRawQuerySqlState(undefined)).toBeUndefined();
  });
});
