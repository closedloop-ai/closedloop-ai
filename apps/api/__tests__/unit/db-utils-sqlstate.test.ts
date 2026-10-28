/**
 * `getPrismaRawQuerySqlState` — reading the PostgreSQL SQLSTATE out of a failed
 * raw query.
 *
 * This exists because the obvious implementation is wrong: for a raw query
 * Prisma puts its OWN code (`P2010`) on `error.code` and leaves the driver's
 * SQLSTATE to the adapter. A caller that branches on `error.code` alone
 * compiles, type-checks, and silently never matches — the branch becomes dead
 * code that only shows up as mis-classified production errors. Reading only ONE
 * of the adapter shapes below fails exactly the same way, which is why each is
 * pinned here.
 */

import { describe, expect, it } from "vitest";
import {
  getPrismaDriverAdapterSqlState,
  getPrismaRawQuerySqlState,
} from "@/lib/db-utils";

/** The flat `meta.code` shape reported by adapters other than `@prisma/adapter-pg`. */
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

  it.each(["P2002", "P2010", "P1002"])(
    "ignores Prisma's own error code %s, which also looks like a SQLSTATE",
    (code) => {
      // These are five [0-9A-Z] characters too, so a naive SQLSTATE pattern
      // returns them and a caller mistakes a Prisma envelope for a server-side
      // condition.
      const err = Object.assign(new Error("prisma error"), { code });
      expect(getPrismaRawQuerySqlState(err)).toBeUndefined();
    }
  );

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

  // ISS-8556: the shape Prisma 7.10's adapter-pg actually raises for a raw
  // query. Copied verbatim from a real failure captured against Postgres by
  // __tests__/integration/p2010-raw-query-sqlstate-realdb.test.ts — that suite
  // proves the adapter emits this, and this one runs in the BLOCKING lane so a
  // regression in our handling of it cannot land behind a continue-on-error
  // amber.
  it("reads the SQLSTATE from the 7.10 driverAdapterError envelope", () => {
    const err = Object.assign(new Error("raw query failed"), {
      code: "P2010",
      meta: {
        driverAdapterError: {
          name: "DriverAdapterError",
          cause: {
            originalCode: "55P03",
            originalMessage: "could not obtain lock on relation",
            kind: "LockNotAvailable",
          },
        },
      },
    });

    expect(getPrismaRawQuerySqlState(err)).toBe("55P03");
  });

  it("prefers meta.code when an adapter still reports the older envelope", () => {
    const err = Object.assign(new Error("raw query failed"), {
      code: "P2010",
      meta: {
        code: "57014",
        driverAdapterError: { cause: { originalCode: "55P03" } },
      },
    });

    expect(getPrismaRawQuerySqlState(err)).toBe("57014");
  });

  it("does not answer for a P2002, which carries the same adapter envelope", () => {
    // A unique violation arrives with `driverAdapterError.cause.originalCode`
    // set to 23505. Without the P2010 gate this raw-query reader would answer
    // for it, silently widening its domain past its own name — and the next
    // caller that adds a 23505 or 40001 branch would get a match on a
    // non-raw error.
    const p2002 = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: {
        driverAdapterError: { cause: { originalCode: "23505" } },
      },
    });

    expect(getPrismaRawQuerySqlState(p2002)).toBeUndefined();
  });

  it("rejects a non-SQLSTATE value sitting on the legacy meta.code", () => {
    // `meta.code` is typed as a bare string, so the legacy branch validates the
    // VALUE rather than trusting it — otherwise a caller discriminating on the
    // result receives whatever the adapter happened to put there.
    const err = Object.assign(new Error("raw query failed"), {
      code: "P2010",
      meta: {
        code: "UniqueConstraintViolation",
        driverAdapterError: { cause: { originalCode: "55P03" } },
      },
    });

    expect(getPrismaRawQuerySqlState(err)).toBe("55P03");
  });
});

describe("getPrismaDriverAdapterSqlState", () => {
  it("reads the SQLSTATE a model query carries under its own Prisma code", () => {
    const refused = Object.assign(new Error("current transaction is aborted"), {
      code: "P2039",
      meta: {
        modelName: "BranchActivityAtom",
        driverAdapterError: { cause: { originalCode: "25P02" } },
      },
    });

    expect(getPrismaDriverAdapterSqlState(refused)).toBe("25P02");
    // The raw-query reader is pinned to P2010, which is why this one exists.
    expect(getPrismaRawQuerySqlState(refused)).toBeUndefined();
  });

  it("does not answer a Prisma code or a missing envelope", () => {
    const prismaCode = Object.assign(new Error("wrapped"), {
      code: "P2039",
      meta: { driverAdapterError: { cause: { originalCode: "P2010" } } },
    });

    expect(getPrismaDriverAdapterSqlState(prismaCode)).toBeUndefined();
    expect(
      getPrismaDriverAdapterSqlState(
        Object.assign(new Error("expired"), { code: "P2028" })
      )
    ).toBeUndefined();
  });
});
