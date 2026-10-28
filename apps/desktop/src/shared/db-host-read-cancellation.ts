import { AsyncLocalStorage } from "node:async_hooks";

/**
 * ISS-9802 — which main-process db-host call carries a renderer cancellation
 * token, scoped the same way ISS-6079's background marker is.
 *
 * The reason is identical to the one written out in `db-host-call-priority.ts`,
 * and so is the shape: the db-host proxy (`db-host-agent-database.ts`) forwards
 * every call as a dotted op path and nothing else — `apply` calls
 * `client.invoke(path, args)` — so there is no per-call seam to pass a token
 * through without changing the shape of every `agentDatabase.*` call site in the
 * app. An IPC read handler says "everything I do under here belongs to this
 * token" once, at the top, and `DbHostClient.invoke` reads it.
 *
 * Scoped rather than a module-level variable for the reason that file gives
 * too: reads interleave on one event loop, so a plain variable set around a
 * handler would stamp whatever else happened to be in flight with a token that
 * cancels somebody else's work.
 *
 * It lives in `src/shared/` beside that module, not under `src/main/database/`,
 * so a boot-sensitive importer never pulls the db-host runtime in behind it
 * (`boot-no-design-system-runtime` in `scripts/dependency-cruiser.config.cjs`).
 *
 * The default is UNCANCELLABLE, everywhere and always: a caller that does not
 * opt in — every write, every backfill, every existing read — sends no token and
 * therefore cannot be cancelled by anything.
 */
const readCancellationScope = new AsyncLocalStorage<string>();

/**
 * Run `fn` — and every db-host call it awaits — under `token`, so a later
 * `DbHostClient.cancelRead(token)` reaches the work rather than only the
 * caller's promise.
 *
 * An absent or unusable token runs `fn` unchanged, with no scope entered: a
 * renderer that sent nothing must be indistinguishable from one that predates
 * the field.
 */
export function runWithReadCancellationToken<T>(
  token: string | undefined,
  fn: () => Promise<T>
): Promise<T> {
  if (token === undefined) {
    return fn();
  }
  return readCancellationScope.run(token, fn);
}

/** The token of the enclosing {@link runWithReadCancellationToken}, if any. */
export function currentReadCancellationToken(): string | undefined {
  return readCancellationScope.getStore();
}
