import type { DbHostAgentDatabase } from "../sqlite.js";
import type { DbHostClient } from "./db-host-client.js";

function noop(): void {
  // Proxy `apply` target; never called directly.
}

// Property names that must not resolve to an op path: `then` would make every
// proxy look thenable (breaking `await`), and there is no DB op by these names.
//
// `bind`/`call`/`apply` are here because the trap below would otherwise answer
// them like any other property — turning the ordinary idiom `db.someOp.bind(db)`
// into the op path `someOp.bind`, invoked over IPC with the proxy itself as an
// argument. That is not structured-clone-safe, so the post rejects with
// `DbHostDataCloneError`; unawaited, it reaches `handleUnhandledRejection`, which
// shows the crash dialog and exits the app. It has cost us two crashes now
// (ISS-4620 `syncSource.advanceSyncState`, then the ISS-4818 store-integrity
// probe), and in both the reported op name — `<op>.bind` — pointed at a DB op
// that does not exist rather than at the caller. Resolving them to `undefined`
// makes the mistake fail as a plain, local `TypeError: ... is not a function` at
// the call site, with no rejected promise to take the process down. Detaching a
// proxy method is never valid: call it through the proxy, or wrap it in a
// closure.
//
// No `SqliteAgentDatabase` method is named for one of these, so nothing real is
// shadowed. The `store:`-prefixed op `packScanner.apply` is not a
// counter-example: store ops are dispatched by op-name STRING through
// `invokeStoreOp`/`rawStoreOp`, never by property access on this proxy, so they
// never reach this trap.
const NON_OP_PROPS = new Set([
  "then",
  "catch",
  "finally",
  "bind",
  "call",
  "apply",
]);

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
): DbHostAgentDatabase {
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
  return build("") as DbHostAgentDatabase;
}
