/**
 * @file The shared membership normaliser for const-object unions crossing a
 * trust boundary.
 *
 * Extracted because it was already written twice, byte-identically and privately
 * — once in `../github-read-model.ts` and once in `./repository-default-identity.ts`
 * — and ISS-8350 needed a third caller. A third copy would have been SSOT drift
 * by copy, so the two became one.
 *
 * NOT the only primitive of this shape in the package: `constValue` in
 * `./branch-activity.ts` answers the same membership question but returns
 * `undefined` so its callers can supply their own fallback. It is deliberately
 * left alone rather than folded in here — the two signatures are different
 * contracts, and collapsing them would change what every `branch-activity`
 * caller does with an unrecognised value.
 */

/**
 * `value` when it is one of `values`, else `values.Unknown`.
 *
 * The `Unknown` member is required by the type rather than passed per call, so a
 * union without an explicit unknown state cannot be normalised through here at
 * all — an absent answer has to have somewhere to land before a boundary is
 * allowed to fold into it.
 *
 * Matching is over `Object.values`, not a key lookup, so a hostile `"__proto__"`
 * on the wire is just a string that matches nothing and folds to `Unknown`.
 */
export function normalizeConstValue<Value extends string>(
  value: unknown,
  values: Record<string, Value> & { Unknown: Value }
): Value {
  const knownValues = Object.values(values) as Value[];
  const matchedValue =
    typeof value === "string"
      ? knownValues.find((knownValue) => knownValue === value)
      : undefined;
  return matchedValue ?? values.Unknown;
}
