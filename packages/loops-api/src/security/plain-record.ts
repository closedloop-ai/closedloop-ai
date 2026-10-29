/**
 * ISS-8565. The plain-object predicate the historical-parse worker boundary and
 * the `protoSafeRecord` codec both gate on. One definition, because the two
 * disagreeing is how a record schema ends up looser than the `z.record` it
 * replaced.
 *
 * `typeof value === "object"` alone is NOT this predicate. It admits `Date`,
 * `Map`, `Set` and every class instance, each of which reports zero own
 * enumerable keys — so an entry-by-entry record codec built on it hands back an
 * empty map and reports success where `z.record` raised. On `tokensByModel`
 * that is a confident "this session spent no tokens" replacing a loud
 * rejection, and the worker hop is `child.postMessage` structured clone, which
 * carries `Date`/`Map`/`Set` across intact rather than flattening them the way
 * a JSON wire would.
 *
 * A null prototype is accepted deliberately: it is what the ISS-8565 builders
 * produce, and it is the one shape that carries no inherited `__proto__`
 * accessor to swallow a write.
 */
export function isPlainRecord(
  value: unknown
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
