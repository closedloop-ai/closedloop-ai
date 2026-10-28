import { NumeratorProvider } from "@repo/api/src/types/numerator-provider";
import { describe, expect, it } from "vitest";
import { resolveSessionsListPerDollar } from "../sessions-list-per-dollar";

/**
 * ISS-11117 — the Sessions listing's per-dollar arm.
 *
 * Label and figure are asserted TOGETHER in every case: drift between them is
 * the failure this resolver exists to prevent, and either assertion alone would
 * stay green while the other went wrong. Expectations are independent literals,
 * never re-derived from the helper the code reads.
 */
const LOC_COPY = {
  label: "LOC / $",
  detail: "across sessions in range",
  what: "Lines of code merged per dollar, output efficiency. Higher is better.",
  how: "Merged gross lines divided by the total estimated cost across matched sessions.",
};

describe("ISS-11117 Sessions listing per-dollar", () => {
  it("renders Pts / $ from the Pensero numerator when points resolve", () => {
    const resolved = resolveSessionsListPerDollar(
      { penseroPointsPerDollar: 12.34 },
      { locValue: 42.5, locCopy: LOC_COPY }
    );

    expect(resolved.providerId).toBe(NumeratorProvider.Pensero);
    expect(resolved.label).toBe("Pts / $");
    expect(resolved.value).toBe(12.34);
    expect(resolved.format(resolved.value)).toBe("12.3");
    expect(resolved.info.how).toContain("Pensero-scored interaction");
    expect(resolved.info.what).toContain("Pensero delivery points per dollar");
  });

  it("publishes a MEASURED zero rather than falling back to LOC", () => {
    const resolved = resolveSessionsListPerDollar(
      { penseroPointsPerDollar: 0 },
      { locValue: 42.5, locCopy: LOC_COPY }
    );

    expect(resolved.label).toBe("Pts / $");
    expect(resolved.value).toBe(0);
    expect(resolved.format(resolved.value)).toBe("0");
  });

  it("renders LOC/$ unchanged, WITH its LOC label, when the field is absent", () => {
    // AC2, asserted positively: a bare `not.toContain("Pts")` would be
    // satisfied by a card that rendered nothing at all.
    const resolved = resolveSessionsListPerDollar(
      {},
      { locValue: 42.5, locCopy: LOC_COPY }
    );

    expect(resolved.providerId).toBe(NumeratorProvider.Loc);
    expect(resolved.label).toBe("LOC / $");
    expect(resolved.value).toBe(42.5);
    expect(resolved.format(resolved.value)).toBe("43");
    expect(resolved.detail).toBe("across sessions in range");
    expect(resolved.info.what).toBe(LOC_COPY.what);
  });

  it("keeps every LOC string on the arm the basis fold resolved", () => {
    // The unrecognized-basis arm: a newer server's basis coarsens all four
    // strings, and this resolver must pass them through rather than re-spell
    // any of them.
    const coarsened = {
      label: "Efficiency ratio",
      detail: "scope not stated",
      what: "Numerator and denominator are not stated by this response.",
      how: "This figure was computed on a basis this version of the app does not recognize.",
    };

    const resolved = resolveSessionsListPerDollar(
      {},
      { locValue: 1, locCopy: coarsened }
    );

    expect(resolved.label).toBe("Efficiency ratio");
    expect(resolved.detail).toBe("scope not stated");
    expect(resolved.info).toEqual({ what: coarsened.what, how: coarsened.how });
  });

  it("keeps LOC/$ when the producer sent a non-finite points value", () => {
    // A wire value the type forbids but JSON does not. Rendering it would put
    // an em dash under a `Pts / $` heading while a real LOC ratio was available.
    const resolved = resolveSessionsListPerDollar(
      { penseroPointsPerDollar: Number.POSITIVE_INFINITY },
      { locValue: 42.5, locCopy: LOC_COPY }
    );

    expect(resolved.providerId).toBe(NumeratorProvider.Loc);
    expect(resolved.label).toBe("LOC / $");
    expect(resolved.value).toBe(42.5);
  });
});
