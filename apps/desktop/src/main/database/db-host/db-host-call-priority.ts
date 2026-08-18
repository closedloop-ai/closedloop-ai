import { AsyncLocalStorage } from "node:async_hooks";

/**
 * ISS-6079: which db-host bounded reads must yield the lane to interactive work.
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
