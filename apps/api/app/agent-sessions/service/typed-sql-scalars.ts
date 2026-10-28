/**
 * ISS-8554 / PLN-1853 D11 — the boundary between what Postgres returns and what
 * the response contract declares.
 *
 * TypedSQL reports the types POSTGRES declares, which are not the types
 * `AgentSessionUsageSummary` wants:
 *
 *   count(*)                -> bigint | null
 *   sum(<bigint column>)    -> Decimal | null   (see below)
 *   sum(<numeric column>)   -> Decimal | null
 *   min/max(<timestamp>)    -> Date | null
 *
 * `sum(bigint)` returning NUMERIC rather than bigint is not a Prisma quirk:
 * Postgres promotes deliberately, because summing bigints can overflow bigint.
 * So all four token totals arrive as `Decimal` even though their columns are
 * `bigint`.
 *
 * Everything types as nullable because a Postgres row description carries no
 * NOT NULL for computed columns. That is a description of the protocol, not of
 * the data — see {@link countToNumber} for the one case where the nullability is
 * genuinely unreachable.
 */

/** The `Decimal` shape these statements return, structurally. */
type DecimalLike = { toString(): string };

/**
 * `count(*)` over zero rows is `0`, never NULL — that is defined aggregate
 * behaviour, not an assumption. The `| null` exists only because the row
 * description cannot say otherwise.
 *
 * Mapping the unreachable case to 0 anyway (rather than throwing) is deliberate:
 * a count is the one figure where 0 and "no answer" mean the same thing to every
 * consumer, so there is nothing to preserve and no reason to fail a request over
 * a branch that cannot be taken.
 */
export function countToNumber(value: bigint | null): number {
  return value === null ? 0 : Number(value);
}

/**
 * A summed aggregate, as a number, with NULL collapsed to 0.
 *
 * PLN-1853 D10 keeps `coalesce` OUT of the SQL so a null sum still means "no
 * rows fell here" at the point where that is cheap and honest. Collapsing it to
 * 0 *here* is safe for a different reason in each caller, and neither reason is
 * "0 is close enough":
 *
 *   - On the totals statement, sums are null EXACTLY when the population is
 *     empty — the same condition `session_count = 0` already reports. The
 *     distinction is fully recoverable from a field the response already
 *     carries, so collapsing loses nothing.
 *   - On the cost split, a null ledger means no row classified into it, and a
 *     ledger nothing classified into genuinely holds $0.
 *
 * This is NOT the coercion D4 rejects for LOC. There, a pull request with null
 * `additions` is dropped from the numerator and counted as excluded, because
 * treating unknown line counts as 0 would understate LOC with no surviving
 * signal that it had happened. Here there is a surviving signal. If a future
 * caller sums something whose emptiness is NOT recoverable from another field,
 * it must not use this function.
 */
export function sumToNumber(value: DecimalLike | null): number {
  return value === null ? 0 : Number(value.toString());
}

/** A summed aggregate that keeps its null, for callers with no recovery signal. */
export function sumToOptionalNumber(value: DecimalLike | null): number | null {
  return value === null ? null : Number(value.toString());
}

/**
 * `min`/`max` of a timestamp column, as the ISO string the contract declares.
 *
 * Null survives here because the contract already models it — `earliestSessionAt`
 * is documented as "null when none match" — so unlike the sums there is nothing
 * to collapse and no other field carrying the distinction.
 */
export function timestampToIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}
