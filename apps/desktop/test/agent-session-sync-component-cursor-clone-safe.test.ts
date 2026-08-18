/**
 * @file agent-session-sync-component-cursor-clone-safe.test.ts
 * @description ISS-4620 regression — the component-inventory sync lane persists
 * its keyset cursor through the DB-host method PROXY, so its persist dispatch
 * must be structured-clone-safe.
 *
 * ROOT-CAUSE BUG: `applyComponentCursorAdvance` passed
 * `source?.advanceSyncState?.bind(source)` as the persist callback. `source` is
 * the DB-host method proxy (`createDbHostAgentDatabase`), which only special-
 * cases `then`/`catch`/`finally`; every other property — including `bind` —
 * resolves to a nested op PATH. So `.bind(source)` did NOT bind: it dispatched
 * `invoke("syncSource.advanceSyncState.bind", [<proxy>])`, posting the non-
 * cloneable proxy as an arg. `child.postMessage` then threw the fatal
 * "An object could not be cloned" on the initial dashboard-load path, and the
 * invoke's Promise return made the "persist" handle not a function.
 *
 * FIX: pass a plain closure that calls `source.advanceSyncState(key, state)`
 * directly, so the proxy's own `apply` fires on the correct op path and only the
 * clone-safe (sourceKey, PersistedSyncState) args cross the boundary.
 *
 * This test wires the REAL DB-host proxy as the sync source, drives an accepted
 * component send through the public tick surface, and asserts the persist
 * invoke:
 *   - is dispatched as op "syncSource.advanceSyncState" (NOT "...bind"/"...call"),
 *   - carries only structured-clone-safe args, and
 *   - never posts the proxy itself.
 *
 * MUTATION: reverting the source fix to `.bind(source)` re-dispatches the
 * "syncSource.advanceSyncState.bind" op with the proxy in args — both assertions
 * below fail (wrong op + a non-cloneable arg).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import type { AgentSessionSyncServiceOptions } from "../src/main/agent-sync/agent-session-sync-service-options.js";
import type { AgentComponentCursorRow } from "../src/main/agent-sync/agent-session-sync-source.js";
import { createDbHostAgentDatabase } from "../src/main/database/db-host/db-host-agent-database.js";
import type { DbHostClient } from "../src/main/database/db-host/db-host-client.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import {
  acceptedResult,
  syncedFor,
} from "./agent-session-sync-component-test-utils.js";

const COMPUTE_TARGET = "target-clone-safe";
const BIND_OP_RE = /\.(bind|call|apply)$/;

type RecordedInvoke = { op: string; args: unknown[] };

/**
 * A capturing DbHostClient: every proxied method call lands here as one
 * `invoke(op, args)`. `advanceSyncState` resolves (its return is ignored by the
 * lane's fire-and-forget persist); any other op resolves to a benign value.
 */
function makeCapturingClient(recorded: RecordedInvoke[]): DbHostClient {
  return {
    invoke: (op: string, args: unknown[]) => {
      recorded.push({ op, args });
      return Promise.resolve();
    },
  } as unknown as DbHostClient;
}

test("component cursor persist dispatches a clone-safe advanceSyncState invoke through the DB-host proxy", async () => {
  gatewayLog.clear();

  const recorded: RecordedInvoke[] = [];
  const agentDatabase = createDbHostAgentDatabase(
    makeCapturingClient(recorded)
  );

  const rows: AgentComponentCursorRow[] = [
    { id: "cmp-1", last_seen_at: "2026-07-31T03:06:00.000Z" },
    { id: "cmp-2", last_seen_at: "2026-07-31T03:06:00.000Z" },
  ];
  const rowsById = new Map(rows.map((r) => [r.id, r]));

  const uploads: string[][] = [];
  const options: AgentSessionSyncServiceOptions = {
    isHttpReady: () => true,
    // The REAL DB-host proxy — its `syncSource` is the method proxy the broken
    // `.bind(source)` caller mis-used.
    getSource: () => agentDatabase.syncSource,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: async () => ({ accepted: true }),
    listComponentCursorRows: (sinceTs) => {
      // Deliver the batch only on the first read (sinceTs empty), then drain.
      if (sinceTs === "") {
        return Promise.resolve(rows);
      }
      return Promise.resolve([]);
    },
    loadComponentRows: (ids) =>
      Promise.resolve(
        ids.map((id) => syncedFor(id, rowsById.get(id)?.last_seen_at ?? null))
      ),
    sendComponents: (payload) => {
      uploads.push(payload.components.map((c) => c.externalId));
      return Promise.resolve(acceptedResult());
    },
  };

  const service = new AgentSessionSyncService(options);
  service.start();
  // whenComponentSyncSettled() is the REAL completion signal for the fire-and-
  // forget component lane — it awaits the lane's load/send/advance (and thus the
  // persist dispatch under test) instead of guessing a fixed flush count, so this
  // stays deterministic even if another await is later added to the persist path
  // (wongk review).
  await service.whenComponentSyncSettled();
  service.refresh();
  await service.whenComponentSyncSettled();
  service.stop();

  // The accepted send happened (proves the cursor-advance path ran).
  assert.deepEqual(uploads.flat().sort(), ["cmp-1", "cmp-2"]);

  const advanceInvokes = recorded.filter(
    (r) => r.op === "syncSource.advanceSyncState"
  );
  assert.ok(
    advanceInvokes.length >= 1,
    `expected an advanceSyncState invoke; recorded ops: ${recorded
      .map((r) => r.op)
      .join(", ")}`
  );

  // The proxy must NEVER be mis-invoked via a Function.prototype method path —
  // that was the ISS-4620 crash (it posts the proxy itself).
  const bindLike = recorded.filter((r) => BIND_OP_RE.test(r.op));
  assert.deepEqual(
    bindLike.map((r) => r.op),
    [],
    "no .bind/.call/.apply op path may be dispatched through the proxy"
  );

  // Every advance invoke's args must be structured-clone-safe (postMessage-safe).
  for (const invoke of advanceInvokes) {
    assert.doesNotThrow(
      () => structuredClone(invoke.args),
      "advanceSyncState args must be structured-clone-safe"
    );
    const [sourceKey, state] = invoke.args as [string, unknown];
    assert.equal(typeof sourceKey, "string");
    assert.deepEqual(state, {
      observedTopUpdatedAt: "2026-07-31T03:06:00.000Z",
      observedIdsAtTopUpdatedAt: ["cmp-2"],
      deadLetteredIds: [],
    });
  }
});
