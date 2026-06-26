import type { SqliteAgentDatabase } from "../sqlite.js";
import type { DbHostClient } from "./db-host-client.js";

function noop(): void {
  // Proxy `apply` target; never called directly.
}

// Property names that must not resolve to an op path: `then` would make every
// proxy look thenable (breaking `await`), and there is no DB op by these names.
const NON_OP_PROPS = new Set(["then", "catch", "finally"]);

// Full op paths that the real runtime does NOT implement and must resolve to
// `undefined` so optional-call sites (`source.close?.()`) no-op instead of
// forwarding an uncallable op. The SQLite syncSource has no `close` — the child
// owns the single SQLite handle and closes it via `agentDatabase.close()`, so
// main never closes the remote syncSource. (db-host-protocol.ts / FEA-2038.)
const ABSENT_OP_PATHS = new Set(["syncSource.close"]);

/**
 * FEA-2038 — a stand-in for the in-process `SqliteAgentDatabase` that forwards
 * every method call to the DB host child over IPC. Property access accumulates a
 * dotted op path (`sessions` → `getAll`); calling it issues one `invoke`. This
 * lets the existing IPC handlers and collector-manager keep consuming
 * `agentDatabase.*` unchanged while SQLite actually lives in the child process.
 *
 * Works for any method whose args + result are structured-clone-safe:
 *   - all runtime methods (sessions/agents/events/dashboard/tokenUsage/importer/
 *     processEvent/lifecycle), `prisma.client` reads (delegate args are plain
 *     objects), and `syncSource.*`.
 * Does NOT work for callback args — `prisma.write(fn)` — because a function
 * can't cross IPC. Those handlers are rerouted to dedicated
 * child ops; calling them through the proxy rejects loudly (DataCloneError),
 * which makes any missed reroute obvious rather than silently wrong.
 */
export function createDbHostAgentDatabase(
  client: DbHostClient
): SqliteAgentDatabase {
  const build = (path: string): unknown =>
    new Proxy(noop, {
      get(_target, prop) {
        if (typeof prop !== "string" || NON_OP_PROPS.has(prop)) {
          return undefined;
        }
        if (path === "") {
          if (prop === "backend") {
            return "sqlite";
          }
          if (prop === "connection") {
            return null;
          }
        }
        const nextPath = path === "" ? prop : `${path}.${prop}`;
        if (ABSENT_OP_PATHS.has(nextPath)) {
          return undefined;
        }
        return build(nextPath);
      },
      apply(_target, _thisArg, args: unknown[]) {
        return client.invoke(path, args);
      },
    });

  // Single IPC-boundary cast: the Proxy structurally answers every
  // SqliteAgentDatabase method path, which the type system can't infer.
  return build("") as SqliteAgentDatabase;
}
