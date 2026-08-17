/**
 * @file cost-math.ts
 * @description Desktop-main (ESM) integer money math for nightly cost
 * reconciliation (FEA-1435). The reconciliation worker compares the local
 * genai-prices estimate (reported in USD by the sidecar) against the amount the
 * vendor actually billed (Anthropic returns decimal-string CENTS; OpenAI returns
 * float USD). Floating-point dollars cannot be summed or differenced without
 * accumulating rounding error, so every amount is converted ONCE to an integer
 * number of MICRO-CENTS at the boundary and all aggregation/drift math is then
 * pure integer arithmetic.
 *
 * ── Why micro-cents, and why plain `number` (not BigInt) ─────────────────────
 * 1 cent = 10_000 micro-cents; 1 USD = 1_000_000 micro-cents. That gives four
 * decimal places of a cent — finer than any vendor reports — so the only
 * precision loss is a single deterministic round at the conversion boundary.
 * Plausible reconciled spend is bounded far below Number.MAX_SAFE_INTEGER
 * (2^53 ≈ 9.0e15 micro-cents ≈ $9.0 billion), so a JS `number` holds every
 * realistic total exactly as an integer. We therefore avoid BigInt (which would
 * leak into the IPC/DB serialization layer) and instead guard every result with
 * an explicit Number.isSafeInteger assertion — if a pathological input ever
 * pushes a total past the safe range the worker fails loudly rather than
 * silently losing precision.
 *
 * ── Scope ────────────────────────────────────────────────────────────────────
 * This module does NO pricing. It never calls genai-prices, never invents a
 * rate, never overrides one. It only converts already-computed amounts into a
 * common integer unit, sums them, and differences two of them. Pricing stays the
 * single responsibility of `token-cost.ts` / the sidecar cost engine, which
 * TRUST the library for every rate.
 */

/** Micro-cents per cent. 1 micro-cent = 1e-4 cent. */
export const MICRO_CENTS_PER_CENT = 10_000;

/** Micro-cents per US dollar (= 100 cents × 10_000). */
export const MICRO_CENTS_PER_USD = 1_000_000;

/**
 * Throw if `value` is not a safe integer. Money totals must round-trip exactly
 * through JS numbers, IPC JSON, and database integer columns; a non-integer or an
 * out-of-range value indicates a conversion bug or implausibly large input and
 * must fail loudly rather than be silently truncated.
 */
function assertSafeInteger(value: number, where: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `cost-math: ${where} produced a non-safe-integer micro-cents value: ${value}`
    );
  }
}

/**
 * Convert a USD amount (the sidecar's genai-prices estimate, or a vendor amount
 * already denominated in dollars such as OpenAI's costs API) to integer
 * micro-cents. The single rounding step happens here; downstream aggregation is
 * exact.
 */
export function usdToMicroCents(usd: number): number {
  if (!Number.isFinite(usd)) {
    throw new Error(
      `cost-math: usdToMicroCents got a non-finite value: ${usd}`
    );
  }
  const micro = Math.round(usd * MICRO_CENTS_PER_USD);
  assertSafeInteger(micro, "usdToMicroCents");
  return micro;
}

/**
 * Convert a numeric CENTS amount to integer micro-cents. Used for vendor payloads
 * already parsed into a JS number. For vendor amounts that arrive as decimal
 * strings (Anthropic's cost_report), prefer {@link parseDecimalCentsToMicroCents}
 * which avoids a float multiply over the whole magnitude.
 */
export function centsToMicroCents(cents: number): number {
  if (!Number.isFinite(cents)) {
    throw new Error(
      `cost-math: centsToMicroCents got a non-finite value: ${cents}`
    );
  }
  const micro = Math.round(cents * MICRO_CENTS_PER_CENT);
  assertSafeInteger(micro, "centsToMicroCents");
  return micro;
}

/**
 * Parse a decimal CENTS string (the shape Anthropic's
 * `/v1/organizations/cost_report` returns, e.g. "12.3456789") directly into
 * integer micro-cents WITHOUT a float multiply over the full magnitude. The
 * integer and fractional parts are scaled separately and the 5th fractional
 * digit decides a half-up round, so large values keep full micro-cent precision
 * instead of inheriting float64 error. Throws on anything that is not a plain
 * decimal number string.
 */
export function parseDecimalCentsToMicroCents(raw: string): number {
  const s = raw.trim();
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) {
    throw new Error(
      `cost-math: not a decimal cents string: ${JSON.stringify(raw)}`
    );
  }
  const sign = m[1] === "-" ? -1 : 1;
  const intPart = m[2];
  const fracPart = m[3] ?? "";

  const intMicro = Number(intPart) * MICRO_CENTS_PER_CENT;
  // First 4 fractional digits are the micro-cent resolution; the 5th rounds.
  const scaled = fracPart.slice(0, 4).padEnd(4, "0");
  let fracMicro = Number(scaled);
  const roundingDigit = fracPart.charAt(4);
  if (roundingDigit !== "" && Number(roundingDigit) >= 5) {
    // Carries naturally into the cent (e.g. "0.99995" → 10000 micro-cents).
    fracMicro += 1;
  }

  const micro = sign * (intMicro + fracMicro);
  assertSafeInteger(micro, "parseDecimalCentsToMicroCents");
  return micro;
}

/** Convert integer micro-cents back to a USD float for display/serialization. */
export function microCentsToUsd(microCents: number): number {
  assertSafeInteger(microCents, "microCentsToUsd input");
  return microCents / MICRO_CENTS_PER_USD;
}

/**
 * Sum a list of integer micro-cents amounts with pure integer arithmetic. Each
 * input and the running total are asserted safe so a bad value can never be
 * silently absorbed into an otherwise-plausible sum.
 */
export function sumMicroCents(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    assertSafeInteger(value, "sumMicroCents element");
    total += value;
    assertSafeInteger(total, "sumMicroCents running total");
  }
  return total;
}

/** Drift between the local estimate and what the vendor billed, in micro-cents. */
export type DriftResult = {
  /** local − vendor. Positive ⇒ we OVER-estimated; negative ⇒ UNDER-estimated. */
  driftMicroCents: number;
  /**
   * Drift as a percentage of the vendor-billed amount, or null when the vendor
   * billed nothing (percentage is undefined — caller should treat as "vendor
   * billed $0", e.g. a trial credit, rather than 0% drift).
   */
  driftPct: number | null;
};

/**
 * Compute the signed drift between a local estimate and the vendor-billed amount.
 * Both inputs must already be integer micro-cents (use the converters above).
 * The percentage uses the vendor amount as the denominator because the vendor
 * figure is the ground truth we are reconciling against.
 */
export function computeDrift(
  localMicroCents: number,
  vendorMicroCents: number
): DriftResult {
  assertSafeInteger(localMicroCents, "computeDrift local");
  assertSafeInteger(vendorMicroCents, "computeDrift vendor");
  const driftMicroCents = localMicroCents - vendorMicroCents;
  assertSafeInteger(driftMicroCents, "computeDrift difference");
  const driftPct =
    vendorMicroCents === 0 ? null : (driftMicroCents / vendorMicroCents) * 100;
  return { driftMicroCents, driftPct };
}
