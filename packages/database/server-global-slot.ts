// ---------------------------------------------------------------------------
// Process-wide registration slots (ISS-6942).
//
// A registration seam whose value lives in a module-local `let` does not
// survive bundling. Turbopack emits a module into every chunk group that
// imports it, so the `apps/api` build produces several copies: one that the
// instrumentation entry registers on, and one or more that route handlers
// read. Route-side importers pull only the readers, so the bundler tree-shakes
// the setter out of their copies entirely and the binding is emitted with no
// writer at all. Registration silently never arrives, with no error.
//
// ISS-5857 (`@repo/observability/trace-context`) and ISS-6817
// (`@repo/observability/tracing/hooks`) each fixed one instance of this by
// hand. This module is the same shape, factored out at its third and fourth
// occurrence in `@repo/database`. It is deliberately dependency-free so
// `pool-telemetry.ts` — which must stay importable from `apps/mcp`'s narrow
// Docker context — keeps carrying no `@repo/*` imports.
// ---------------------------------------------------------------------------

/**
 * Whether this runtime may touch a slot at all.
 *
 * `Symbol.for` returns a REGISTERED symbol, so every key created here is
 * discoverable and writable by anything sharing the realm. The module-local
 * bindings these slots replace were unreachable from outside their module; the
 * gate is what keeps that property rather than trading it away for the fix.
 * Nothing is lost by gating: every registrar in this package is server-only, so
 * a browser never had a value to register or read.
 */
const IS_SERVER_RUNTIME = typeof window === "undefined";

type SlotHolder = typeof globalThis & Record<symbol, unknown>;

/**
 * A registered value shared by every module instance a bundler emits. Only
 * function values are storable: a slot's whole purpose is to hold an injected
 * implementation, and a callability check is what keeps a planted non-callable
 * value from being read back as present.
 */
export type ServerGlobalSlot<T> = {
  /** Register `value`, or clear the slot when it is `null`. Inert off the server. */
  set(value: T | null): void;
  /** The registered value, or `undefined` when absent, off-server, or not callable. */
  read(): T | undefined;
};

/**
 * Create a process-wide slot keyed by `Symbol.for(key)` on `globalThis`.
 *
 * A registered symbol on `globalThis` is opaque to the bundler and shared by
 * every copy it emits, so registration and read meet whichever chunks they land
 * in. It is the same reason `@opentelemetry/api` keeps its own globals there
 * instead of in module scope.
 *
 * `key` must be unique across the realm; namespace it (`closedloop.<pkg>.<name>`).
 */
export function createServerGlobalSlot<T extends (...args: never[]) => unknown>(
  key: string
): ServerGlobalSlot<T> {
  const slotKey = Symbol.for(key);
  const holder = globalThis as SlotHolder;

  return {
    set(value: T | null): void {
      if (!IS_SERVER_RUNTIME) {
        return;
      }
      // A usable `T` is always truthy, so this is "clear" for `null` and for an
      // `undefined` that reached a caller the types do not constrain. Deletes
      // rather than assigns, so "cleared" and "never registered" stay the same
      // state for anything probing the slot with `in` or `Reflect` — a promise
      // an `undefined` write would quietly break.
      if (!value) {
        Reflect.deleteProperty(holder, slotKey);
        return;
      }
      holder[slotKey] = value;
    },

    read(): T | undefined {
      if (!IS_SERVER_RUNTIME) {
        return undefined;
      }
      const value = holder[slotKey];
      return typeof value === "function" ? (value as T) : undefined;
    },
  };
}
