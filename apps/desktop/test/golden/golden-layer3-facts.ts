/**
 * FEA-2649 Layer 3 — divergence-aware fact checking.
 *
 * Extracted from `golden-layer3.ts` so that file owns the suite (fixture,
 * per-query assertions, registration) while this module owns one responsibility:
 * resolving a single aggregation fact against the Layer 3 divergence registry
 * and accumulating human-readable failures, plus the small ordering/multiset
 * comparators the suite's assertions are phrased in.
 *
 * `firedL3` is the sweep's record of which registered divergences actually fired
 * during a run; the suite's end-of-run self-guard reads it to fail an entry that
 * was never exercised. It lives here with `checkFact`, the only writer.
 */
import { isDeepStrictEqual } from "node:util";
import {
  findLayer3Divergence,
  type Layer3Scope,
  scopeSessionId,
} from "./golden-layer3-divergences.js";

export const firedL3 = new Set<string>();

export function l3Key(scope: Layer3Scope, key: string): string {
  return `${scopeSessionId(scope) ?? "corpus"} ${key}`;
}

/**
 * Assert `actual` equals `expected` for an aggregation fact, resolving the L3
 * registry: a registered divergence whose pinned `actual` matches stays green
 * (and is recorded for the sweep); a registered divergence that stops
 * reproducing, drifts to a third value, or an unregistered mismatch collects a
 * failure message.
 */
export function checkFact(
  failures: string[],
  scope: Layer3Scope,
  key: string,
  actual: unknown,
  expected: unknown,
  detail?: string
): void {
  const entry = findLayer3Divergence(scope, key);
  if (isDeepStrictEqual(actual, expected)) {
    if (entry) {
      failures.push(
        `${l3Key(scope, key)}: registered divergence (${entry.ticket}) NO LONGER REPRODUCES — ` +
          "delete the registry entry and let the key become a hard assertion"
      );
    }
    return;
  }
  if (entry) {
    if (isDeepStrictEqual(actual, entry.actual)) {
      firedL3.add(l3Key(scope, key));
      return; // known divergence, ticket-keyed expected-fail
    }
    failures.push(
      `${l3Key(scope, key)}: drifted to a THIRD value — expected ${JSON.stringify(expected)}, ` +
        `registry pins ${JSON.stringify(entry.actual)} (${entry.ticket}), got ${JSON.stringify(actual)}`
    );
    return;
  }
  failures.push(
    `${l3Key(scope, key)}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}` +
      (detail ? ` — ${detail}` : "") +
      " | if the expectation is confirmed under packages/golden-sessions/AGENTS.md, file a ticket and PROPOSE a golden-layer3-divergences.ts entry pinning the actual value"
  );
}

export function assertNoFailures(failures: string[], label: string): void {
  // Plain throw (not node:assert) — this helper runs outside test bodies per
  // the noMisplacedAssertion contract; a throw fails the calling test the
  // same way.
  if (failures.length > 0) {
    throw new Error(
      `${label}: ${failures.length} fact(s) diverged:\n  - ${failures.join("\n  - ")}`
    );
  }
}

/** Multiset equality for outputs whose SQL declares no total order on ties. */
export function asCountMap(
  entries: { key: string; count: number }[]
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) {
    out[e.key] = (out[e.key] ?? 0) + e.count;
  }
  return out;
}

export function assertNonIncreasing(
  failures: string[],
  label: string,
  values: number[]
): void {
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[i - 1]) {
      failures.push(
        `${label}: ordering contract violated — value[${i}]=${values[i]} > value[${i - 1}]=${values[i - 1]}`
      );
      return;
    }
  }
}

/**
 * `num`'s null-preserving twin, for the fact predicates that match rows by
 * IDENTITY rather than sum them. `num` folds an absent value into 0 — right for
 * an accumulator, wrong for a key, because it makes "no PR number"
 * indistinguishable from a literal "PR 0" on BOTH sides of an equality. Use
 * this wherever a nullable column participates in a row-identity match, so a
 * null can only ever match another null.
 *
 * ISS-5179: the parameter accepts `undefined` and the check is `== null`
 * (loose), deliberately. These values come off a raw `SELECT *` read, where the
 * hand-declared row type is an unenforced assertion, not a runtime guarantee —
 * a row missing the column hands back `undefined`. A `=== null` check lets that
 * fall through to `Number(undefined)` → `NaN`, and because `NaN !== NaN` the
 * result then matches NOTHING, not even another absent value: two rows that
 * genuinely agree ("neither has a PR number") are reported as disagreeing, and
 * any row selection keyed on the comparison comes back empty. Depending on the
 * caller's shape that surfaces either as a recorded failure or — for a
 * `filter()`-then-assert shape — as a vacuously green assertion over an empty
 * set, which in a frozen-oracle suite is the worse of the two.
 */
export function nullableNum(
  value: number | bigint | null | undefined
): number | null {
  return value == null ? null : Number(value);
}
