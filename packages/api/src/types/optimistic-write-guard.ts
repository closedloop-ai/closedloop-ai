/**
 * ISS-9486 — the one rule every per-field optimistic guard evaluates.
 *
 * `expected` ABSENT (`undefined`) is unguarded last-write-wins, and `null` is a
 * real expectation ("this field holds nothing"), so a caller that omits the key
 * is never refused.
 *
 * A write whose requested value already equals the stored value is never
 * stale (Tamsin, 2026-09-23, ISS-9486 ruling 2): a retried commit would
 * otherwise 409 against its own earlier success, because the first attempt
 * moved the stored value off the `expected` the retry still carries. Pass
 * `requested` as `undefined` when the write does not set this field, which
 * leaves the plain comparison against `expected`.
 */
export function isStaleExpectation<T>(
  current: T,
  requested: T | undefined,
  expected: T | undefined
): boolean {
  if (expected === undefined || current === expected) {
    return false;
  }
  return requested === undefined || current !== requested;
}

/**
 * ISS-9486: a guard sent without the field it guards has nothing to guard, and
 * is refused with this 400 by every route that takes per-field guards.
 */
export function unguardedGuardMessage(field: string): string {
  const guard = `expected${field[0].toUpperCase()}${field.slice(1)}`;
  return `Send \`${guard}\` only together with \`${field}\``;
}
