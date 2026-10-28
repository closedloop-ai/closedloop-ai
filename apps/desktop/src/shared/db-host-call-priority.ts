import { AsyncLocalStorage } from "node:async_hooks";

/**
 * ISS-6079: which db-host bounded reads must yield the lane to interactive work.
 *
 * Lives in `src/shared/` alongside `db-host-exit-error.ts` and
 * `db-host-shutdown-error.ts`, for the boundary reason those two record —
 * though not on their exact terms: both call themselves pure with zero imports,
 * whereas this module imports `node:async_hooks` and owns live process state.
 * What carries over is the constraint, not the purity. The boot graph reaches
 * it: `app.ts → desktop-sync-lane-composition.ts →
 * agent-session-sync-service.ts → agent-session-hydration-budget.ts` needs
 * `runAsBackgroundDbReads` as a value, and `boot-no-design-system-runtime`
 * (`scripts/dependency-cruiser.config.cjs`) forbids a boot entry from
 * statically reaching ANY module under `src/main/database/`. This module is the
 * lightweight half a boot-sensitive consumer can import without pulling in the
 * db-host runtime: one `node:async_hooks` primitive, no prisma, no write queue,
 * no I/O. It sat under `database/db-host/` until ISS-7240 restored the boundary
 * gate, which had been blind when the boot-path import landed.
 *
 * It must stay ONE module. The scope below is a singleton, and the writer
 * (`runAsBackgroundDbReads`, on the sync lane) and the reader
 * (`isBackgroundDbRead`, in `db-host-client.ts`) only agree because they close
 * over the same instance. Duplicating it per consumer would silently make every
 * background read read as interactive.
 *
 * The db-host proxy (`db-host-agent-database.ts`) forwards every call as a
 * dotted op path — `apply` calls `client.invoke(path, args)` and nothing else —
 * so there is no per-call seam to pass a priority through without changing the
 * shape of every `agentDatabase.*` call site in the app. An async-scoped marker
 * gives the sync drain a way to say "everything I do under here is background"
 * once, at the top of its pass, and have it apply to the reads it fans out.
 *
 * Scoped rather than a module-level boolean deliberately: the sync pass
 * interleaves with interactive reads on the same event loop, so a plain flag
 * set/cleared around the pass would mark whatever else happened to be in flight.
 * `AsyncLocalStorage` follows the await chain of THIS pass and nothing else.
 *
 * The default is interactive, everywhere and always. A caller that does not opt
 * in — including every existing one — keeps exactly its pre-ISS-6079 admission
 * behaviour. Only work explicitly wrapped here is deprioritised.
 */
const backgroundReadScope = new AsyncLocalStorage<true>();

/**
 * Mark everything `fn` does — including the db-host reads it awaits — as
 * background, so it yields the bounded read lane to interactive work.
 *
 * Use it at the TOP of a background pass rather than around an individual read:
 * the point is that the whole pass is background, and wrapping one read would
 * leave its siblings competing with the Sessions page.
 */
export function runAsBackgroundDbReads<T>(fn: () => Promise<T>): Promise<T> {
  return backgroundReadScope.run(true, fn);
}

/** True when the caller is running inside {@link runAsBackgroundDbReads}. */
export function isBackgroundDbRead(): boolean {
  return backgroundReadScope.getStore() === true;
}
