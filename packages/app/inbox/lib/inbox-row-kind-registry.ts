/**
 * ISS-9406 — the row-kind lookup, over keys the surface does not control.
 *
 * A notification's `kind` arrives on the record, so `kinds[notification.kind]`
 * is an index by an untrusted string. On an object literal that index is not
 * total: `"__proto__"` answers with `Object.prototype`, `"constructor"` with the
 * `Object` function, `"toString"` with a function. Each is truthy, so a
 * dispatcher that reads a hit as "this kind has a row" hands one of them to
 * React as a component type for a kind nobody registered.
 *
 * A null-prototype table makes the lookup total: every unregistered key answers
 * `undefined` and the dispatcher's existing miss path runs. Frozen too — a
 * registry a caller can extend at runtime is the same untrusted write one level
 * up.
 */

/**
 * Build the row-kind table a notification dispatcher indexes by `kind`. The
 * input type is carried through unchanged; what this adds is runtime, not type.
 */
export function createInboxRowKindRegistry<T extends object>(
  kinds: T
): Readonly<T> {
  const registry = Object.create(null) as T;
  // Own enumerable keys only, onto a target with no prototype to inherit from.
  Object.assign(registry, kinds);
  return Object.freeze(registry);
}
