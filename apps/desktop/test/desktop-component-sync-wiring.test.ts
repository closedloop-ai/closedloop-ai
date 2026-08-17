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
 *      resolves a classified `ComponentSyncSendResult` (ISS-4542): `Accepted`
 *      only on 2xx, `LaneFailure` for auth/target/transport/5xx, `BatchRejected`
 *      for a permanent per-batch 4xx (matching the `sendComponents` contract).
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
import { ComponentSyncSendOutcome } from "../src/main/agent-sync/agent-component-sync-dead-letter.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import { createDesktopComponentsClient } from "../src/main/dashboard/desktop-components-client.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { acceptedResult } from "./agent-session-sync-component-test-utils.js";

const CLIENT_TAG = "components-sync-client";

function clientLogMessages(): string[] {
  return gatewayLog
    .getEntries()
    .filter((e) => e.tag === CLIENT_TAG)
    .map((e) => e.message);
}

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
  const result = await client.sync(PAYLOAD);

  assert.equal(
    result.outcome,
    ComponentSyncSendOutcome.Accepted,
    "2xx → Accepted"
  );
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

test("createDesktopComponentsClient reports LaneFailure (no upload) without a compute target", async () => {
  const { fetchImpl, calls } = fetchStub(new Response("{}", { status: 200 }));
  const client = createDesktopComponentsClient(
    componentsClientOptions({ fetch: fetchImpl, computeTargetId: null })
  );

  const result = await client.sync(PAYLOAD);

  assert.equal(
    result.outcome,
    ComponentSyncSendOutcome.LaneFailure,
    "no compute target is lane-wide, not a per-batch rejection"
  );
  assert.equal(calls.length, 0, "offline/no-target → no POST");
});

test("createDesktopComponentsClient reports LaneFailure (no upload) without an access token", async () => {
  const { fetchImpl, calls } = fetchStub(new Response("{}", { status: 200 }));
  const client = createDesktopComponentsClient(
    componentsClientOptions({ fetch: fetchImpl, token: null })
  );

  const result = await client.sync(PAYLOAD);

  assert.equal(
    result.outcome,
    ComponentSyncSendOutcome.LaneFailure,
    "unauthenticated is lane-wide, not a per-batch rejection"
  );
  assert.equal(calls.length, 0, "unauthenticated → no POST");
});

test("createDesktopComponentsClient reports LaneFailure on a 403 (auth/policy → cursor not advanced, budget not charged)", async () => {
  const { fetchImpl } = fetchStub(new Response("forbidden", { status: 403 }));
  const client = createDesktopComponentsClient(
    componentsClientOptions({ fetch: fetchImpl })
  );

  const result = await client.sync(PAYLOAD);

  // ISS-4542 (shafty023): a 403 is a lane-wide denial — it must NOT walk the
  // inventory forward by charging the poison budget.
  assert.equal(result.outcome, ComponentSyncSendOutcome.LaneFailure);
});

test("createDesktopComponentsClient reports BatchRejected on a permanent per-batch 4xx (422)", async () => {
  const { fetchImpl } = fetchStub(
    new Response("unprocessable", { status: 422 })
  );
  const client = createDesktopComponentsClient(
    componentsClientOptions({ fetch: fetchImpl })
  );

  const result = await client.sync(PAYLOAD);

  // A permanent per-batch rejection is the ONLY class that charges the
  // dead-letter budget so a genuine poison batch eventually moves to the back.
  assert.equal(result.outcome, ComponentSyncSendOutcome.BatchRejected);
});

test("instrumentation: missing compute target logs a named skip reason (no longer silent)", async () => {
  gatewayLog.clear();
  const { fetchImpl } = fetchStub(new Response("{}", { status: 200 }));
  const client = createDesktopComponentsClient(
    componentsClientOptions({ fetch: fetchImpl, computeTargetId: null })
  );

  await client.sync(PAYLOAD);

  const messages = clientLogMessages();
  assert.ok(
    messages.some((m) => m.includes("no compute target")),
    `expected a 'no compute target' skip log, got: ${JSON.stringify(messages)}`
  );
});

test("no session token logs a named 'no-credential' skip and never POSTs", async () => {
  gatewayLog.clear();
  const { fetchImpl, calls } = fetchStub(new Response("{}", { status: 200 }));
  const client = createDesktopComponentsClient(
    componentsClientOptions({ fetch: fetchImpl, token: null })
  );

  const result = await client.sync(PAYLOAD);

  assert.equal(result.outcome, ComponentSyncSendOutcome.LaneFailure);
  assert.equal(calls.length, 0, "no session token → no POST");
  const messages = clientLogMessages();
  assert.ok(
    messages.some((m) => m.includes("no first-party session token available")),
    `expected a 'no-credential' skip log, got: ${JSON.stringify(messages)}`
  );
});

test("instrumentation: non-2xx logs the status and response body snippet", async () => {
  gatewayLog.clear();
  const { fetchImpl } = fetchStub(new Response("forbidden", { status: 403 }));
  const client = createDesktopComponentsClient(
    componentsClientOptions({ fetch: fetchImpl })
  );

  await client.sync(PAYLOAD);

  const messages = clientLogMessages();
  assert.ok(
    messages.some((m) => m.includes("HTTP 403") && m.includes("forbidden")),
    `expected an 'HTTP 403 … forbidden' log, got: ${JSON.stringify(messages)}`
  );
});

test("instrumentation: transition-based logging does not repeat the same skip every call", async () => {
  gatewayLog.clear();
  const { fetchImpl } = fetchStub(new Response("{}", { status: 200 }));
  const client = createDesktopComponentsClient(
    componentsClientOptions({ fetch: fetchImpl, computeTargetId: null })
  );

  await client.sync(PAYLOAD);
  await client.sync(PAYLOAD);
  await client.sync(PAYLOAD);

  const skips = clientLogMessages().filter((m) =>
    m.includes("no compute target")
  );
  assert.equal(skips.length, 1, "same stuck reason logs once, not per-tick");
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
    // `('', '')` is the initial keyset position (full backfill).
    const cursorRows = await db.syncSource.listComponentCursorRows?.(
      "",
      "",
      200
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
      isHttpReady: () => true,
      getSource: () => db.syncSource,
      getSyncComputeTargetId: () => COMPUTE_TARGET,
      sendBatch: async () => ({ accepted: true }),
      listComponentCursorRows: (sinceTs, sinceId, limit) =>
        Promise.resolve(
          db.syncSource.listComponentCursorRows?.(sinceTs, sinceId, limit) ?? []
        ),
      loadComponentRows: (ids) =>
        Promise.resolve(db.syncSource.loadComponentRows?.(ids) ?? []),
      sendComponents: (payload) => {
        uploaded.push(payload);
        return Promise.resolve(acceptedResult());
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

test("FEA-3438: listComponentCursorRows bounds the read by LIMIT in keyset order", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea-3438-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  try {
    // Seed 5 rows sharing one last_seen_at so paging is driven by the id tie-break.
    for (let i = 0; i < 5; i++) {
      const id = `comp-${String(i).padStart(2, "0")}`;
      await db.run(
        `INSERT OR IGNORE INTO agent_components
           (id, component_kind, external_id, component_key, first_seen_at, last_seen_at)
         VALUES ($1, 'mcp', $1, $1, $2, $2)`,
        id,
        NOW
      );
    }

    // A LIMIT below the row count returns exactly one page, oldest-keyset first...
    const firstPage = await db.syncSource.listComponentCursorRows?.("", "", 2);
    assert.ok(
      firstPage && firstPage.length === 2,
      "LIMIT caps the read to 2 rows"
    );
    assert.deepEqual(
      firstPage.map((r) => r.id),
      ["comp-00", "comp-01"],
      "first page is the keyset-ordered prefix"
    );

    // ...and the keyset cursor advances past the page's last row to the next page.
    const last = firstPage.at(-1);
    assert.ok(last);
    const secondPage = await db.syncSource.listComponentCursorRows?.(
      last.last_seen_at ?? "",
      last.id,
      2
    );
    assert.deepEqual(
      secondPage?.map((r) => r.id),
      ["comp-02", "comp-03"],
      "next keyset page continues strictly after the first page's last row"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
