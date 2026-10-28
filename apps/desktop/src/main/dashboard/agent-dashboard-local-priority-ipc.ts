/**
 * @file agent-dashboard-local-priority-ipc.ts
 * @description ISS-10332 / PLN-2086 Milestone 3 step 16 — the renderer→main
 * channels that set a session's or a branch's priority in the local store.
 *
 * Sender trust is `withDb`'s gate (every `desktop:db:*` handler's), and the
 * payload is Zod-validated HERE against the priority vocabulary plus `null`:
 * the renderer is untrusted at this boundary, so a malformed or off-vocabulary
 * request is refused before it can reach the writer, and nothing outside the
 * vocabulary is ever stored. The db-host child re-parses the same shape,
 * because it is a second process boundary.
 *
 * `invokeStoreOp` rather than `withPrisma` because this WRITES — a write cannot
 * cross the db-host proxy. A committed write nudges the renderer through
 * `desktop:db:changed`, the push the local data sources' live bridges already
 * refetch on.
 */
import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { DesktopRendererEventChannel } from "../../shared/desktop-renderer-event-channel.js";
import {
  LOCAL_BRANCH_PRIORITY_WRITE_CHANNEL,
  LOCAL_SESSION_PRIORITY_WRITE_CHANNEL,
  type LocalPriorityWriteResult,
  LocalPriorityWriteStatus,
} from "../../shared/local-priority-write-contract.js";
import {
  LOCAL_BRANCH_PRIORITY_WRITE_STORE_OP,
  LOCAL_SESSION_PRIORITY_WRITE_STORE_OP,
  localBranchPriorityWriteRequestSchema,
  localPriorityWriteResultSchema,
  localSessionPriorityWriteRequestSchema,
} from "../database/local-priority-store.js";
import { sendToRendererWindow } from "../ipc/renderer-ipc.js";
import type { WithDb } from "./agent-dashboard-ipc-handler-wrappers.js";
import type { InvokeStoreOp } from "./agent-dashboard-runtime-options.js";

const DB_CHANGED_CHANNEL = DesktopRendererEventChannel.DbChanged;

type LocalPriorityIpcDeps = {
  withDb: WithDb;
  invokeStoreOp: InvokeStoreOp;
  getWindow: () => BrowserWindow | null;
  now?: () => Date;
};

export function registerLocalPriorityIpcHandlers(
  deps: LocalPriorityIpcDeps
): void {
  registerPriorityWriteChannel(deps, {
    channel: LOCAL_SESSION_PRIORITY_WRITE_CHANNEL,
    requestSchema: localSessionPriorityWriteRequestSchema,
    storeOp: LOCAL_SESSION_PRIORITY_WRITE_STORE_OP,
    changedPayload: (id) => ({ sessionId: id }),
  });
  registerPriorityWriteChannel(deps, {
    channel: LOCAL_BRANCH_PRIORITY_WRITE_CHANNEL,
    requestSchema: localBranchPriorityWriteRequestSchema,
    storeOp: LOCAL_BRANCH_PRIORITY_WRITE_STORE_OP,
    // A branch has no session id of its own; the broad nudge is the one the
    // Branches live bridge already maps to a whole-list refetch.
    changedPayload: () => ({}),
  });
}

function registerPriorityWriteChannel(
  deps: LocalPriorityIpcDeps,
  lane: {
    channel: string;
    requestSchema: typeof localSessionPriorityWriteRequestSchema;
    storeOp: string;
    changedPayload: (id: string) => { sessionId?: string };
  }
): void {
  const now = deps.now ?? (() => new Date());
  ipcMain.handle(
    lane.channel,
    deps.withDb(
      async (_db, raw: unknown): Promise<LocalPriorityWriteResult> => {
        const request = lane.requestSchema.safeParse(raw);
        if (!request.success) {
          throw new Error("Invalid priority write IPC payload.");
        }
        const result = localPriorityWriteResultSchema.parse(
          // The bare op name: `invokeStoreOp` adds the `store:` prefix itself.
          await deps.invokeStoreOp(lane.storeOp, [
            request.data,
            now().toISOString(),
          ])
        );
        if (result.status === LocalPriorityWriteStatus.Written) {
          sendToRendererWindow(
            deps.getWindow(),
            DB_CHANGED_CHANNEL,
            lane.changedPayload(request.data.id)
          );
        }
        return result;
      }
    )
  );
}
