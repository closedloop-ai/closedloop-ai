/**
 * ISS-7175 (review): the guarded total exists so a corrupt counter cannot reach a
 * rendered headline. These pin BOTH halves — that a good payload still totals, and
 * that a bad one returns null rather than a number wrong by exactly the bad term.
 */
import { describe, expect, it } from "vitest";
import {
  resolveSessionTokenTotal,
  sumSessionTokenCounters,
} from "./session-token-total";

const GOOD = { cacheRead: 300, cacheWrite: 40, input: 620, output: 640 };

describe("resolveSessionTokenTotal", () => {
  it("sums all four counters", () => {
    // 1600, not 1260: the whole point of ISS-7175 is that cache is included.
    expect(resolveSessionTokenTotal(GOOD)).toBe(1600);
  });

  it.each([
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])(
    "returns null when a counter is %s, rather than a total wrong by that term",
    (_label, bad) => {
      // The failure this guards: fold the bad term to 0 and the tile prints a
      // confident 1260 for a payload nobody can total, beside a Cost tile that
      // correctly dashes on the identical input.
      expect(resolveSessionTokenTotal({ ...GOOD, cacheRead: bad })).toBeNull();
    }
  );

  it("folds an ABSENT counter to 0 rather than dashing a version-skewed client", () => {
    // The distinction that matters, and the one this got wrong first: these
    // fields are required on the CURRENT contract, but a Desktop build predating
    // them omits them. Dashing there would punish an old client for a field it
    // never knew to send — the same reason `cost-card-presentation.ts` lets
    // `undefined` through. 1600 - 40 = 1560, not null.
    expect(resolveSessionTokenTotal({ ...GOOD, cacheWrite: undefined })).toBe(
      1560
    );
  });

  it("still returns null for a counter that is PRESENT and unusable", () => {
    // `null` is the case the optional type does not admit but an unparsed wire
    // payload still carries — present, and not a number anyone can add.
    expect(resolveSessionTokenTotal({ ...GOOD, input: null })).toBeNull();
  });

  it("totals a genuinely empty cohort as 0, which is not the same as unknown", () => {
    expect(
      resolveSessionTokenTotal({
        cacheRead: 0,
        cacheWrite: 0,
        input: 0,
        output: 0,
      })
    ).toBe(0);
  });
});

describe("sumSessionTokenCounters", () => {
  it("folds an absent aggregate term to 0, because no rows really is zero", () => {
    // Distinct from the guarded variant ON PURPOSE: a null Prisma `_sum` means the
    // period matched nothing. Returning null there would strip the delta chip off
    // every legitimately-empty period.
    expect(
      sumSessionTokenCounters({
        cacheRead: null,
        cacheWrite: undefined,
        input: 620,
        output: 640,
      })
    ).toBe(1260);
  });

  it("sums all four when present", () => {
    expect(sumSessionTokenCounters(GOOD)).toBe(1600);
  });
});
