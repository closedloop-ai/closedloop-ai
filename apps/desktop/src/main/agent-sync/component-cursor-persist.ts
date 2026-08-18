/**
 * @file component-cursor-persist.ts
 * @description ISS-4620 — build the clone-safe cursor-persist callback for the
 * component-inventory sync lane.
 *
 * `AgentSessionSyncSource` (the DB-host method proxy, `createDbHostAgentDatabase`)
 * is NOT structured-clone-safe, and its property access is overloaded: the proxy
 * only special-cases `then`/`catch`/`finally`; EVERY other property — including
 * `bind`/`call`/`apply` — resolves to a nested op PATH. So the tempting
 * `source.advanceSyncState.bind(source)` did NOT bind the method: it dispatched
 * `invoke("syncSource.advanceSyncState.bind", [<proxy>])`, posting the
 * non-cloneable `source` proxy as an arg. `child.postMessage` then threw the
 * fatal "An object could not be cloned" on the initial dashboard-load path, and
 * the invoke's Promise return made the resulting "persist" handle not a function.
 *
 * The fix (kept HERE as its own cohesive concern, so the oversized
 * `agent-session-sync-service.ts` does not carry it) is to return a plain closure
 * that calls the method through its parent object. That way the proxy's own
 * `apply` fires on the correct op path and only the clone-safe
 * `(sourceKey, PersistedSyncState)` args cross the boundary — never the proxy.
 */

import type {
  AgentSessionSyncSource,
  PersistedSyncState,
} from "./agent-session-sync-source.js";

/**
 * The clone-safe cursor-persist callback: `(sourceKey, state) => void|Promise`.
 * Matches `advanceComponentCursor`'s `persist` parameter shape.
 */
export type ComponentCursorPersist = (
  sourceKey: string,
  state: PersistedSyncState
) => void | Promise<void>;

/**
 * Build the clone-safe persist callback for a component-sync source, or
 * `undefined` when the source does not implement `advanceSyncState` (fake/legacy
 * sources fall back to no durable persist, as before).
 *
 * The closure calls `source.advanceSyncState(key, state)` through `source` so the
 * DB-host proxy's `apply` fires on the `syncSource.advanceSyncState` op path with
 * only the clone-safe args — never reaching a `.bind`/`.call`/`.apply` op path
 * that would post the proxy itself (the ISS-4620 fatal crash).
 */
export function buildComponentCursorPersist(
  source: AgentSessionSyncSource | null
): ComponentCursorPersist | undefined {
  if (!source?.advanceSyncState) {
    return undefined;
  }
  return (key: string, state: PersistedSyncState) =>
    source.advanceSyncState?.(key, state);
}
