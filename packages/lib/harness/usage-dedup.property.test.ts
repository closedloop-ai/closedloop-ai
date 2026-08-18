/**
 * @file usage-dedup.property.test.ts
 * @description Property-based coverage for the harness's pure validators.
 *
 * These functions are total, deterministic, and have invariants their docstrings
 * state in words. That is exactly the shape a property test covers better than
 * examples: an example test asserts the cases someone thought of, while a
 * property asserts the RULE over the whole input space and reports the smallest
 * input that breaks it.
 *
 * The distinction that matters for this suite: every property below is taken
 * from a requirement the module already documents, not from reading the
 * implementation. A property derived from the code would be as
 * implementation-coupled as an example derived from it — more thoroughly so,
 * because it would look rigorous while restating the same assumption.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isoTs } from "./claude/parse-claude";
import { toIso } from "./parser-utils";
import { validateCacheWriteTtl } from "./usage-dedup";

/** Non-negative safe integers — the only members a valid split may carry. */
const validMember = fc.integer({ min: 0, max: 2 ** 31 });

/**
 * The `cacheWrite` domain, taken from its producer rather than from the whole
 * value space: every call site reads it through `readStorageTokenCount`, which
 * returns a non-negative safe integer or 0.
 */
const producedCacheWrite = fc.maxSafeNat();

describe("validateCacheWriteTtl — properties", () => {
  it("accepts any well-formed split that fits the budget, unchanged", () => {
    // The requirement: a split within budget is returned VERBATIM. Members are
    // never rounded, clamped, or recomputed — the value the provider reported is
    // the value stored, or nothing is.
    fc.assert(
      fc.property(validMember, validMember, (fiveM, oneH) => {
        const cacheWrite = fiveM + oneH;
        expect(validateCacheWriteTtl({ fiveM, oneH }, cacheWrite)).toEqual({
          fiveM,
          oneH,
        });
      })
    );
  });

  it("never returns a PARTIAL split — the result is whole or absent", () => {
    // The provenance rule, stated as an invariant over arbitrary input rather
    // than over the cases someone enumerated: whatever comes back, it is either
    // `undefined` or carries both members exactly as supplied. There is no input
    // that produces a fabricated member, and no input that produces one real
    // member beside a defaulted one.
    fc.assert(
      fc.property(
        fc.anything(),
        fc.anything(),
        fc.integer({ min: 0, max: 2 ** 31 }),
        (fiveM, oneH, cacheWrite) => {
          const result = validateCacheWriteTtl(
            { fiveM, oneH } as never,
            cacheWrite
          );
          if (result === undefined) {
            return;
          }
          expect(result.fiveM).toBe(fiveM);
          expect(result.oneH).toBe(oneH);
        }
      )
    );
  });

  it("rejects any split whose members exceed the budget", () => {
    // The sum rule over the whole space above the boundary, not one example.
    fc.assert(
      fc.property(
        validMember,
        validMember,
        fc.integer({ min: 1, max: 1000 }),
        (fiveM, oneH, overshoot) => {
          const cacheWrite = fiveM + oneH - overshoot;
          fc.pre(cacheWrite >= 0);
          expect(
            validateCacheWriteTtl({ fiveM, oneH }, cacheWrite)
          ).toBeUndefined();
        }
      )
    );
  });

  it("rejects any member that is not a non-negative integer", () => {
    // One rule for every malformed case, asserted as one property instead of a
    // case per shape. `fc.anything()` reaches values no example list would:
    // boxed numbers, -0, sparse arrays, objects with valueOf.
    fc.assert(
      fc.property(fc.anything(), validMember, (bad, good) => {
        fc.pre(!(typeof bad === "number" && Number.isInteger(bad) && bad >= 0));
        expect(
          validateCacheWriteTtl({ fiveM: bad, oneH: good } as never, 2 ** 31)
        ).toBeUndefined();
        expect(
          validateCacheWriteTtl({ fiveM: good, oneH: bad } as never, 2 ** 31)
        ).toBeUndefined();
      })
    );
  });

  it("is total across every shape its producer can emit", () => {
    // A parser guard that throws is worse than one that rejects: it takes the
    // whole transcript with it, and the docstring promises "Never throws".
    //
    // Scoped to the REACHABLE domain on purpose, on BOTH parameters.
    // `readRawCacheWriteTtl` is the only producer of `raw`, and it returns
    // `undefined` or an object carrying two `unknown` members — it guards
    // `cacheCreation === null` itself, so a null `raw` cannot arrive. An
    // unscoped `fc.anything()` there does find a throw on `null`, but that is a
    // type-forbidden input inside the type boundary, which the repo's test
    // guidance says not to assert on. `cacheWrite` is narrower still: it is a
    // `number` its callers have already put through `readStorageTokenCount`.
    // Both generators land inside the declared parameter types, so neither
    // needs a cast — a property is only as honest as the domain it quantifies
    // over, and a cast is how that dishonesty gets past the compiler.
    fc.assert(
      fc.property(
        fc.option(fc.record({ fiveM: fc.anything(), oneH: fc.anything() }), {
          nil: undefined,
        }),
        producedCacheWrite,
        (raw, cacheWrite) => {
          expect(() => validateCacheWriteTtl(raw, cacheWrite)).not.toThrow();
        }
      )
    );
  });
});

/** The ECMAScript time-value limit: `Date` represents ±8.64e15 ms, no more. */
const MAX_DATE_MS = 8_640_000_000_000_000;

/** Every epoch a `Date` can hold — `isoTs` passes its number straight through. */
const dateRepresentableEpoch = fc.integer({
  min: -MAX_DATE_MS,
  max: MAX_DATE_MS,
});

/**
 * `toIso`'s narrower domain. It reads anything below 1e12 as seconds and
 * multiplies by 1000, and every negative epoch is below 1e12, so the negative
 * floor is the time-value limit over 1000. The ceiling is the full limit,
 * reached unscaled once the value is read as milliseconds.
 */
const toIsoRepresentableEpoch = fc.integer({
  min: -MAX_DATE_MS / 1000,
  max: MAX_DATE_MS,
});

/** Each normalizer paired with the epoch domain it can actually represent. */
const epochNormalizers = [
  [isoTs, dateRepresentableEpoch],
  [toIso, toIsoRepresentableEpoch],
] as const;

describe("isoTs / toIso — properties", () => {
  it("are total — no input throws, on either normalizer", () => {
    // The failure this prevents is documented and real: one unrepresentable
    // stamp used to abort a whole scan, which desktop retried every pass and the
    // cloud rendered as a blank transcript.
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(() => isoTs(value)).not.toThrow();
        expect(() => toIso(value)).not.toThrow();
      })
    );
  });

  it("return a string or null, never undefined", () => {
    // Callers distinguish "no stamp" (null) from a stamp. A third answer would
    // make every `?? fallback` and `|| fallback` disagree, which is the defect
    // the empty-string case was fixed for.
    fc.assert(
      fc.property(fc.anything(), (value) => {
        for (const result of [isoTs(value), toIso(value)]) {
          expect(result === null || typeof result === "string").toBe(true);
        }
      })
    );
  });

  it("isoTs never emits an empty string as a timestamp", () => {
    // An empty stamp sorts before every real one, and `??` keeps it while `||`
    // replaces it — so the same absent value behaves differently depending on
    // which operator a caller reached for. `null` is the one answer for absence.
    //
    // Deliberately NOT asserted for `toIso`, which fails it: `toIso("")` returns
    // `""` today, because `new Date("")` is invalid and the string branch falls
    // back to the raw text. `isoTs` was fixed for exactly this and `toIso` never
    // was — the same split ISS-6738 records for the epoch and non-ISO-string
    // rules. Fixing it changes parser output, so it belongs in that ticket's
    // decision rather than being smuggled in here.
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(isoTs(value)).not.toBe("");
      })
    );
  });

  it("normalise every representable epoch to a parseable ISO stamp", () => {
    // Whatever the seconds-vs-milliseconds question is decided to be (ISS-6738),
    // the answer has to BE a timestamp. This holds that without asserting which
    // of the two readings is correct.
    //
    // Each normalizer is quantified over the epochs IT can represent, which are
    // not the same range — and that difference is the seconds-vs-milliseconds
    // split itself, not a gap in the property. `isoTs` passes the number to
    // `Date` untouched, so it spans the full time-value limit both ways.
    // `toIso` reads anything below 1e12 as SECONDS and multiplies by 1000, so
    // every negative epoch is scaled and its floor is the limit over 1000;
    // above 1e12 it reads milliseconds and reaches the limit unscaled. Pinning
    // one shared range would either understate `isoTs` or assert a `null` out
    // of `toIso`.
    for (const [normalise, representableEpoch] of epochNormalizers) {
      fc.assert(
        fc.property(representableEpoch, (epoch) => {
          const result = normalise(epoch);
          expect(result).not.toBeNull();
          expect(Number.isNaN(Date.parse(result ?? ""))).toBe(false);
        })
      );
    }
  });
});
