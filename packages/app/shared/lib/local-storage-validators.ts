import { isRecord } from "@repo/lib/harness/type-guards";

/**
 * Coercers for {@link useLocalStorageState}'s `validate` parameter.
 *
 * `useLocalStorageState` returns `JSON.parse(raw)` under a bare `as T` cast, so a
 * well-formed JSON scalar reaches a consumer typed for something else — where it
 * either throws during render or renders a confident wrong value (ISS-8533). These
 * turn "the stored bytes are not a T" into the caller's default, which is what an
 * absent key already produces.
 *
 * Each must satisfy the parameter's contract: pure in `(value, fallback)`, and
 * content-preserving for every valid `T`.
 */

/**
 * Boolean, or the caller's default.
 *
 * The `typeof` test is load-bearing and a `value === true` shorthand is wrong: it
 * would flip a deliberately stored `false` to a `true` default, which at the dev-mode
 * switch means silently returning a viewer who chose the customer view to the internal
 * view — with the control that turns it back off hidden behind a rollout gate.
 */
export function booleanOrFallback(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * The string members of an array; the caller's default only for a NON-array.
 *
 * The name carries the split, because the two halves land differently. A non-array
 * reaches the fallback. An ARRAY never does — it yields its surviving string members,
 * which for a fully corrupt `[1, 2]` is `[]` and NOT the fallback, whatever the caller
 * passed. That is invisible at the one call site today (`useGroupExpansion`'s default
 * is itself `[]`), so the name is what has to warn the next caller with a meaningful
 * default that it would get "nothing selected" rather than its default.
 *
 * Filtering members rather than rejecting the array is deliberate and is the ticket's
 * prescribed shape: a stored `[1, 2]` compares equal to no string key, so an
 * `Array.isArray`-only guard would read as "nothing toggled" with no error.
 */
export function stringMembersOrEmpty(
  value: unknown,
  fallback: string[]
): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  return value.filter((member): member is string => typeof member === "string");
}

/**
 * A record whose every own value is a boolean, or the caller's default.
 *
 * WHOLESALE, not member-wise, and the distinction is the whole point. A legitimately
 * PARTIAL record is a valid stored value — one written before a column existed omits
 * that key — and "partial" is a claim about which KEYS are present, while "corrupt" is
 * a claim about a VALUE's type. Every own value being a boolean admits the first and
 * rejects the second. Dropping just the corrupt member would be worse than either: the
 * raw record is handed to the column menu while the backfilled copy drives the table,
 * so a missing key renders an unchecked switch for a column that is still showing.
 *
 * Own keys are read with `Object.keys`, NOT a schema. `z.record(z.string(),
 * z.boolean())` silently DROPS a `__proto__` key before validating it, so a stored
 * `{"__proto__": "notabool"}` parses as valid and the non-boolean survives into the
 * caller. `Object.keys` sees the own key `JSON.parse` created, so it falls back.
 *
 * The cast asserts what the predicate cannot: `T` may be a total record while a valid
 * stored value is partial. It is the same shape as the `JSON.parse(raw) as T` this
 * validator exists to narrow, and the `extends` bound is what keeps it from being
 * wired to an unrelated key.
 */
export function booleanRecordOrFallback<T extends Record<string, boolean>>(
  value: unknown,
  fallback: T
): T {
  if (!isRecord(value)) {
    return fallback;
  }
  const everyValueIsBoolean = Object.keys(value).every(
    (key) => typeof value[key] === "boolean"
  );
  return everyValueIsBoolean ? (value as T) : fallback;
}

/**
 * A member of a closed string union, or the caller's default.
 *
 * `allowed` must be DERIVED from a shape that names every member (an exhaustive
 * `Record<Union, true>`), never hand-listed. A hand-listed array is the side-inventory
 * failure: adding a member to the union still compiles, and every value of the new
 * member silently coerces to the fallback.
 */
export function stringUnionOrFallback<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  return typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}
