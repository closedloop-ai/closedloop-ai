/**
 * @file desktop-component-sync-wiring.test.ts
 * @description Gap B (#2570 follow-up): the desktop→cloud component-inventory
 * sync lane was left unwired at `app.ts` — `AgentSessionSyncService` was
 * constructed WITHOUT `sendComponents` / `listComponentCursorRows` /
 * `loadComponentRows`, so `syncComponentsOnce` no-oped and locally-collected
 * `agent_components` never reached the cloud.
 *
 * These tests prove the two building blocks that make the wiring real:
 *   1. `createDesktopComponentsClient.sync` POSTs the inventory batch to
 *      `/desktop/components/sync?computeTargetId=…` with a Bearer JWT and
 *      resolves `true` only on 2xx (matching the `sendComponents` contract).
 *   2. The SQLite `syncSource` now exposes `listComponentCursorRows` /
 *      `loadComponentRows`, and feeding those (plus the client) into
 *      `AgentSessionSyncService` makes `syncComponentsOnce` actually upload —
 *      i.e. it no longer no-ops.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { AgentSessionSyncService } from "../src/main/agent-session-sync-service.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { createDesktopComponentsClient } from "../src/main/desktop-components-client.js";

const NOW = "2026-07-11T00:00:00.000Z";
const API_ORIGIN = "https://api.closedloop.test";
const COMPUTE_TARGET = "target-gap-b";

function componentsClientOptions(overrides: {
  fetch: typeof fetch;
  token?: string | null;
  origin?: string;
  computeTargetId?: string | null;
}) {
  return {
    fetch: overrides.fetch,
    getAccessToken: () =>
      Promise.resolve<string | null>(
        "token" in overrides ? (overrides.token ?? null) : "access-token"
      ),
    getApiOrigin: () => overrides.origin ?? API_ORIGIN,
    getComputeTargetId: () =>
      "computeTargetId" in overrides
        ? (overrides.computeTargetId ?? null)
        : COMPUTE_TARGET,
  };
}

function fetchStub(response: Response): {
  fetchImpl: typeof fetch;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(response);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const PAYLOAD = {
  schemaVersion: 1 as const,
  batchId: "batch-1",
  syncMode: AgentSessionSyncMode.Incremental,
  componentCount: 1,
  components: [
    {
      externalId: "comp-abc",
      componentKind: "mcp",
      componentKey: "myserver",
      harness: null,
      name: null,
      version: null,
      description: null,
      sourceUrl: null,
      installPath: null,
      packId: null,
      scope: null,
      projectPath: null,
      metadata: null,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      uninstalledAt: null,
    },
  ],
};

test("createDesktopComponentsClient POSTs the inventory to /desktop/components/sync with the compute target and Bearer auth", async () => {
  const { fetchImpl, calls } = fetchStub(
    new Response(JSON.stringify({ success: true, data: { synced: true } }), {
      status: 200,
    })
  );

  const client = createDesktopComponentsClient(
    componentsClientOptions({ fetch: fetchImpl })
  );
  const accepted = await client.sync(PAYLOAD);

  assert.equal(accepted, true, "2xx → accepted");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `${API_ORIGIN}/desktop/components/sync?computeTargetId=${COMPUTE_TARGET}`
  );
  assert.equal(calls[0].init.method, "POST");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer access-token");
  assert.equal(headers["Content-Type"], "application/json");
});

test("createDesktopComponentsClient returns false (no upload) without a compute target", async () => {
  const { fetchImpl, calls } = fetchStub(new Response("{}", { status: 200 }));
  const client = createDesktopComponentsClient(
    componentsClientOptions({ fetch: fetchImpl, computeTargetId: null })
  );

  const accepted = await client.sync(PAYLOAD);

  assert.equal(accepted, false);
  assert.equal(calls.length, 0, "offline/no-target → no POST");
});

test("createDesktopComponentsClient returns false (no upload) without an access token", async () => {
  const { fetchImpl, calls } = fetchStub(new Response("{}", { status: 200 }));
  const client = createDesktopComponentsClient(
    componentsClientOptions({ fetch: fetchImpl, token: null })
  );

  const accepted = await client.sync(PAYLOAD);

  assert.equal(accepted, false);
  assert.equal(calls.length, 0, "unauthenticated → no POST");
});

test("createDesktopComponentsClient returns false on a non-2xx response (cursor not advanced)", async () => {
  const { fetchImpl } = fetchStub(new Response("forbidden", { status: 403 }));
  const client = createDesktopComponentsClient(
    componentsClientOptions({ fetch: fetchImpl })
  );

  const accepted = await client.sync(PAYLOAD);

  assert.equal(accepted, false);
});

test("Gap B: SQLite syncSource exposes component readers and wiring them makes syncComponentsOnce upload (no longer a no-op)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gap-b-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  try {
    // Seed one component-existence row so the component lane has data to upload.
    await db.run(
      `INSERT OR IGNORE INTO agent_components
         (id, component_kind, external_id, component_key, first_seen_at, last_seen_at)
       VALUES ('comp-abc', 'mcp', 'comp-abc', 'myserver', $1, $1)`,
      NOW
    );

    // The source now exposes the two readers the sync lane depends on.
    assert.equal(
      typeof db.syncSource.listComponentCursorRows,
      "function",
      "syncSource.listComponentCursorRows is wired"
    );
    assert.equal(
      typeof db.syncSource.loadComponentRows,
      "function",
      "syncSource.loadComponentRows is wired"
    );

    // Direct reader smoke check: the cursor + full-row loaders return the seed.
    const cursorRows = await db.syncSource.listComponentCursorRows?.(
      "1970-01-01T00:00:00.000Z"
    );
    assert.ok(cursorRows && cursorRows.length === 1);
    assert.equal(cursorRows[0].id, "comp-abc");
    const fullRows = await db.syncSource.loadComponentRows?.(["comp-abc"]);
    assert.ok(fullRows && fullRows.length === 1);
    assert.equal(fullRows[0].componentKey, "myserver");
    assert.equal(fullRows[0].componentKind, "mcp");

    // Now assemble the sync service with the SAME three options app.ts wires:
    // the two source-backed readers plus the HTTP `sendComponents`. If any were
    // missing (the Gap B bug), `syncComponentsOnce` would no-op and nothing is
    // uploaded.
    const uploaded: unknown[] = [];
    const service = new AgentSessionSyncService({
      isAgentMonitorEnabled: () => true,
      isRelayReady: () => true,
      getSource: () => db.syncSource,
      getSyncComputeTargetId: () => COMPUTE_TARGET,
      sendBatch: async () => ({ accepted: true }),
      listComponentCursorRows: (since) =>
        Promise.resolve(db.syncSource.listComponentCursorRows?.(since) ?? []),
      loadComponentRows: (ids) =>
        Promise.resolve(db.syncSource.loadComponentRows?.(ids) ?? []),
      sendComponents: (payload) => {
        uploaded.push(payload);
        return Promise.resolve(true);
      },
    });

    service.start();
    // Let the shared 5s tick's async component lane run to completion.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    service.stop();

    assert.equal(
      uploaded.length,
      1,
      "syncComponentsOnce uploaded the inventory batch (lane is no longer a no-op)"
    );
    const batch = uploaded[0] as { componentCount: number };
    assert.equal(batch.componentCount, 1);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
