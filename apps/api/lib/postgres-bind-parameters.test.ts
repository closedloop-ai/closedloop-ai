/**
 * ISS-7271: `countPredicateBindParameters` is what a chunker reserves against,
 * so an UNDER-count is not a wrong number — it is a statement the driver refuses
 * and a request that 500s. These pin the shapes this repo's predicates are built
 * from, in both directions: what binds, and what only looks like it does.
 */
import { describe, expect, it } from "vitest";

import { countPredicateBindParameters } from "./postgres-bind-parameters";

describe("countPredicateBindParameters (ISS-7271)", () => {
  it("counts one bind per leaf value", () => {
    expect(countPredicateBindParameters({})).toBe(0);
    expect(countPredicateBindParameters({ componentKind: "skill" })).toBe(1);
    expect(
      countPredicateBindParameters({ session: { artifact: { orgId: "o" } } })
    ).toBe(1);
  });

  it("counts every element of an `in` list, and nothing for an empty one", () => {
    expect(
      countPredicateBindParameters({ componentKind: { in: ["a", "b", "c"] } })
    ).toBe(3);
    // The chunked id predicate is measured at an empty chunk precisely so the
    // ids themselves fall out of the reserve.
    expect(countPredicateBindParameters({ agentComponentId: { in: [] } })).toBe(
      0
    );
  });

  it("counts each arm of an OR, including a per-identity readmission arm", () => {
    // The ISS-7271 shape: one `contains` arm plus two binds per readmitted
    // identity — the term a fixed reserve could not hold. The `contains` arm
    // counts two, not one, because `mode` is counted as though it bound a
    // parameter (it does not); see below.
    expect(
      countPredicateBindParameters({
        OR: [
          { componentKey: { contains: "x", mode: "insensitive" } },
          { componentKind: "skill", componentKeyNormalized: "a" },
          { componentKind: "skill", componentKeyNormalized: "b" },
        ],
      })
    ).toBe(6);
  });

  it("counts both window bounds, treating a Date as the scalar it is", () => {
    expect(
      countPredicateBindParameters({
        lastInvokedAt: { gte: new Date(0), lte: new Date(1) },
      })
    ).toBe(2);
  });

  it("counts a query mode rather than guessing it apart from a `mode` column", () => {
    // `mode: "insensitive"` selects ILIKE and binds nothing of its own, so this
    // is one slot of slack — the safe direction. A rule that skipped every key
    // spelled `mode` would instead UNDER-count the two below, where `mode` is
    // the column being filtered, and under-counting costs the request.
    expect(
      countPredicateBindParameters({ name: { contains: "x", mode: "default" } })
    ).toBe(2);
    expect(countPredicateBindParameters({ mode: "insensitive" })).toBe(1);
    expect(countPredicateBindParameters({ mode: { in: ["a", "b"] } })).toBe(2);
  });

  it("over-counts rather than under-counts what it cannot be exact about", () => {
    expect(countPredicateBindParameters(undefined)).toBe(0);
    // `IS NULL` binds nothing; counting it costs at most a round trip.
    expect(countPredicateBindParameters({ agentComponentId: null })).toBe(1);
  });
});
