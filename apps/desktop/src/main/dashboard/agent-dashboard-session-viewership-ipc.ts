/**
 * @file agent-dashboard-session-viewership-ipc.ts
 * @description ISS-7830 — the renderer→main channel that records a user having
 * navigated INTO one thread.
 *
 * The renderer is the only process that knows a person opened a thread and the
 * db-host child is the only one that can write it, so the fact crosses two
 * boundaries. It is re-validated at each: `coerceDbId` here, the same guard every
 * session-keyed `desktop:db:*` channel applies, and
 * `sessionViewershipRecordArgsSchema` again inside the child, because a process
 * boundary is where the annotations stop constraining the value.
 *
 * This is also where the `threadViewershipSignal` Labs gate is read, and it has
 * to be: the resolver is a module singleton registered by the composition root in
 * Electron main, and the db-host child has its own module registry, so a gate read
 * from the child would be the `false` default forever.
 *
 * `invokeStoreOp` rather than `withPrisma` because this WRITES, and a write cannot
 * cross the db-host proxy — `DbHostPrisma` omits `write` so it would not compile.
 */
import { ipcMain } from "electron";
import type { ThreadViewedResult } from "../../shared/thread-viewership-contract.js";
import { THREAD_VIEWED_CHANNEL } from "../../shared/thread-viewership-contract.js";
import { DB_HOST_STORE_OP_PREFIX } from "../database/db-host/db-host-store-op-registry.js";
import { coerceDbId } from "../database/ipc-validation.js";
import { SESSION_VIEWERSHIP_RECORD_STORE_OP } from "../database/session-viewership-store.js";
import { isThreadViewershipSignalEnabled } from "../session/thread-viewership-gate.js";
import type { WithDb } from "./agent-dashboard-ipc-handler-wrappers.js";
import type { InvokeStoreOp } from "./agent-dashboard-runtime-options.js";

/** Register the thread-viewership capture channel. */
export function registerSessionViewershipIpcHandlers(deps: {
  withDb: WithDb;
  invokeStoreOp: InvokeStoreOp;
  now?: () => Date;
  /** Seam for tests; production reads the Labs flag through the gate. */
  isEnabled?: () => boolean;
}): void {
  const now = deps.now ?? (() => new Date());
  const isEnabled = deps.isEnabled ?? isThreadViewershipSignalEnabled;
  ipcMain.handle(
    THREAD_VIEWED_CHANNEL,
    deps.withDb(
      async (_db, rawSessionId: unknown): Promise<ThreadViewedResult> => {
        const sessionId = coerceDbId(rawSessionId);
        // `recorded` is whether a view is ON RECORD afterwards, never whether the
        // channel was reached. A flat `true` over a refused gate, a rejected id,
        // or a session this device holds no row for would make a dropped capture
        // look delivered — and a dropped capture is this feature's failure mode.
        if (sessionId === null || !isEnabled()) {
          return { recorded: false };
        }
        const recorded = await deps.invokeStoreOp(
          `${DB_HOST_STORE_OP_PREFIX}${SESSION_VIEWERSHIP_RECORD_STORE_OP}`,
          [sessionId, now().toISOString()]
        );
        return { recorded: recorded === true };
      }
    )
  );
}
