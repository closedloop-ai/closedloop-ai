import { z } from "zod";
import { isPlainRecord } from "./plain-record";

/**
 * ISS-8565. `z.record` DROPS an own `__proto__` key. It validates the entry
 * normally and then assigns it onto a plain `{}` result, where the inherited
 * `__proto__` setter swallows the write and creates no own key — so the entry
 * is gone from `Object.keys`, `Object.entries` and `JSON.stringify`, with no
 * throw and no issue raised. `Object.prototype` is never written; the harm is
 * DATA LOSS, not prototype pollution.
 *
 * At a process or wire boundary that silently deletes whatever the key carried.
 * For `tokensByModel` it is a whole session's token spend, and the cost derived
 * from it then reads as unknown — the defect this module closes, on the
 * boundary the collector-side folds hand their output to.
 *
 * The mechanism is the boundary twin of the Idiom A already used across the
 * parsers: build into a null-prototype container, which has no inherited
 * accessor to intercept the write, then spread on return so consumers get a
 * normally-prototyped object with the own key intact.
 *
 * Reach for this over `z.record` for ANY map whose keys arrive from outside
 * this process — a model id, an OTLP attribute name, a session id.
 *
 * The container gate is {@link isPlainRecord}, NOT `typeof input === "object"`.
 * A looser gate lets `Date`, `Map` and `Set` reach the entry loop, where each
 * reports zero own enumerable keys — so the codec would hand back `{}` with
 * `success: true` on exactly the field whose silent loss it exists to stop,
 * turning the `z.record` rejection it replaced into a confident zero. The worker
 * hop is `child.postMessage` structured clone, which carries those three across
 * intact, so this is reachable rather than a JSON-wire impossibility.
 *
 * Entries are validated one at a time against the caller's schemas rather than
 * by delegating to `z.record`, so an issue's `path` names the key as the
 * producer spelled it. Delegating and renaming the hostile key to carry it past
 * `z.record` was the first shape of this, and it reported failures against a
 * key that did not exist on the wire.
 */

/**
 * Name what arrived so a rejection stays triageable. `z.record` reported the
 * received half in its own message, and `summarizeHistoricalWorkerResponseIssues`
 * renders exactly `path:code:message` — so dropping it would leave whoever is
 * chasing a worker failure with "Expected an object" and nothing to go on.
 */
function describeReceived(input: unknown): string {
  return Object.prototype.toString.call(input).slice(8, -1);
}

export function protoSafeRecord<
  Key extends z.ZodType<string, string>,
  Value extends z.ZodTypeAny,
>(keySchema: Key, valueSchema: Value) {
  return z
    .custom<Record<string, unknown>>(isPlainRecord, {
      error: (issue) =>
        `Expected a plain object, received ${describeReceived(issue.input)}`,
    })
    .transform((input, ctx): Record<string, z.output<Value>> => {
      // Null-prototype: it carries no inherited `__proto__` accessor, so the
      // write below lands as a real own key instead of being swallowed.
      const built: Record<string, z.output<Value>> = Object.create(null);
      for (const name of Object.getOwnPropertyNames(input)) {
        const own = Object.getOwnPropertyDescriptor(input, name);
        if (own === undefined || !own.enumerable) {
          continue;
        }
        const key = keySchema.safeParse(name);
        if (!key.success) {
          for (const issue of key.error.issues) {
            ctx.addIssue({ ...issue, path: [name, ...issue.path] });
          }
          continue;
        }
        const value = valueSchema.safeParse(own.value);
        if (!value.success) {
          for (const issue of value.error.issues) {
            ctx.addIssue({ ...issue, path: [name, ...issue.path] });
          }
          continue;
        }
        built[key.data] = value.data;
      }
      // Spread DEFINES, so the own `__proto__` key survives onto an object with
      // the ordinary prototype every consumer expects.
      return { ...built };
    });
}
