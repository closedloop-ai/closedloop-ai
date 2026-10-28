/**
 * @file claude-code-telemetry-decimal.ts
 * @description The Claude Code telemetry lane's SQLite-`Decimal`-to-wire-string
 * conversion, in one place for the two domains that need it.
 *
 * Never a `Number`. `cost_usd` and `active_time.seconds` are SQLite decimals and
 * the cloud columns are `Decimal(14,6)` and `Decimal(14,3)`, so routing either
 * through a float would publish a rounded value under the name of an exact one.
 *
 * CANONICALISED, because `toString()` on a decimal is not guaranteed to be the
 * plain fixed-point form the wire contract accepts — decimal.js switches to
 * exponent notation outside a middle band, and an exponent string reaches the
 * cloud's column as a value Prisma throws on. The wire schemas refuse that shape,
 * so this is the half that makes a legitimate value pass rather than getting
 * rejected at the boundary.
 *
 * A value outside the column's domain — negative, non-finite, or past the
 * integer-digit ceiling — is OMITTED rather than clamped. Omission is this lane's
 * word for unknown, and it is the honest answer for a magnitude that cannot be
 * represented; a clamped number would publish a wrong value as a measured one.
 */

import {
  CLAUDE_CODE_MAX_SECONDS_EXCLUSIVE,
  CLAUDE_CODE_MAX_USD_EXCLUSIVE,
  CLAUDE_CODE_SECONDS_DECIMAL_PATTERN,
  CLAUDE_CODE_SECONDS_DECIMAL_PLACES,
  CLAUDE_CODE_USD_DECIMAL_PATTERN,
  CLAUDE_CODE_USD_DECIMAL_PLACES,
} from "@repo/api/src/types/desktop-claude-code-telemetry-sync";

/**
 * A column's domain, IMPORTED from the wire contract that owns it rather than
 * re-declared here.
 *
 * The two halves cannot drift harmlessly and that is why they are one symbol: the
 * wire schema REFUSES any shape but this, and this helper exists to make a
 * legitimate value pass it. Widen the column and the schema to four fractional
 * places with a local copy here, and the producer keeps dropping legal values as
 * unrepresentable; narrow the schema, and the producer keeps emitting strings the
 * boundary rejects as a session-attributable 400 the lane re-earns every tick.
 */
type DecimalDomain = {
  /** The plain fixed-point form the matching wire schema accepts. */
  pattern: RegExp;
  /** Fractional digits the column holds. */
  places: number;
  /** One past the largest integer part the column can hold. */
  maxExclusive: number;
};

/** `Decimal(14,6)`, non-negative. */
const USD_DOMAIN: DecimalDomain = {
  pattern: CLAUDE_CODE_USD_DECIMAL_PATTERN,
  places: CLAUDE_CODE_USD_DECIMAL_PLACES,
  maxExclusive: CLAUDE_CODE_MAX_USD_EXCLUSIVE,
};

/** `Decimal(14,3)`, non-negative. */
const SECONDS_DOMAIN: DecimalDomain = {
  pattern: CLAUDE_CODE_SECONDS_DECIMAL_PATTERN,
  places: CLAUDE_CODE_SECONDS_DECIMAL_PLACES,
  maxExclusive: CLAUDE_CODE_MAX_SECONDS_EXCLUSIVE,
};

function decimalTextWithin(
  value: { toString(): string } | null,
  domain: DecimalDomain
): string | undefined {
  if (value === null) {
    return undefined;
  }
  const raw = value.toString().trim();
  if (domain.pattern.test(raw)) {
    return raw;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed >= domain.maxExclusive) {
    return undefined;
  }
  const fixed = parsed.toFixed(domain.places);
  return domain.pattern.test(fixed) ? fixed : undefined;
}

/** A USD amount as the wire's `Decimal(14,6)` string, or omitted. */
export function usdDecimalText(
  value: { toString(): string } | null
): string | undefined {
  return decimalTextWithin(value, USD_DOMAIN);
}

/** A seconds amount as the wire's `Decimal(14,3)` string, or omitted. */
export function secondsDecimalText(
  value: { toString(): string } | null
): string | undefined {
  return decimalTextWithin(value, SECONDS_DOMAIN);
}
