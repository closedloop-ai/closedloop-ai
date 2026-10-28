import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSessionListCapability } from "@repo/api/src/types/agent-session-list-contract";
import { ListQueryExecution } from "@repo/api/src/types/list-query-observability";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, expect, it, vi } from "vitest";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import type { AgentSessionSyncSource } from "../agent-sync/agent-session-sync-source.js";
import { SESSION_COMPACT_FILTER_VERSION } from "../agent-sync/session-compact-filter-capabilities.js";
import { openSqliteAgentDatabase } from "../database/sqlite.js";
import { getSharedAgentSessions } from "./shared-agent-sessions-api.js";
import { sessionListPageEcho } from "./shared-agent-sessions-page-echo.js";

const storedRow: SyncedAgentSession = {
  externalSessionId: "local-one",
  name: "Local one",
  status: "waiting",
  harness: "claude",
  billingMode: "api",
  cwd: "/work/local-one",
  model: null,
  userId: null,
  startedAt: "2026-06-12T02:00:00.000Z",
  updatedAt: "2026-06-12T03:00:00.000Z",
  lastActivityAt: "2026-06-12T03:00:00.000Z",
  endedAt: null,
  awaitingInputSince: null,
  metadata: null,
  attribution: null,
  turns: 1,
  agents: [],
  events: [],
  tokenUsageByModel: [],
};

const source = {
  listAllSessionCursorRows: () => [
    { id: storedRow.externalSessionId, updated_at: storedRow.updatedAt },
  ],
  listUpdatedSessionCursorRows: () => [],
  loadSyncedSessions: async (ids: string[]) =>
    ids.includes(storedRow.externalSessionId) ? [storedRow] : [],
} as AgentSessionSyncSource;

describe("ISS-9524 Desktop main Sessions list contract", () => {
  it("serves canonical display status while retaining legacy raw evidence and omitted capabilities", async () => {
    const result = await getSharedAgentSessions(source, {
      limit: 2,
      offset: 0,
    });

    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual(
      expect.objectContaining({
        id: "local-one",
        rawStatus: "waiting",
        status: SESSION_STATUS.ACTIVE,
      })
    );
    expect(result.items[0]).not.toHaveProperty("project");
    expect(result.items[0]).not.toHaveProperty("tagPermissions");
    expect(result.viewerScope).toBe("self");
  });

  it("echoes the honored local page and omits the capability on an older or unavailable read", async () => {
    expect(sessionListPageEcho({ limit: 25, offset: 7 })).toEqual({
      capability: AgentSessionListCapability.ServerPaginationV1,
      limit: 25,
      offset: 7,
    });
    expect((await getSharedAgentSessions(null)).pageInfo).toBeUndefined();
  });

  it("DT-18: successful and count-only production reads echo the canonical served page", async () => {
    const regular = await getSharedAgentSessions(source, {
      limit: 2,
      offset: 1,
    });
    expect(regular.pageInfo).toEqual({
      capability: AgentSessionListCapability.ServerPaginationV1,
      limit: 2,
      offset: 1,
    });
    const countSessions = vi.fn().mockResolvedValue(7);
    const countSource: AgentSessionSyncSource = { ...source, countSessions };
    const countOnly = await getSharedAgentSessions(countSource, {
      countOnly: true,
      limit: 25,
      offset: 4,
    });
    expect(countOnly.items).toEqual([]);
    expect(countOnly.total).toBe(7);
    expect(countOnly.pageInfo).toEqual({
      capability: AgentSessionListCapability.ServerPaginationV1,
      limit: 25,
      offset: 4,
    });
    expect(countSessions).toHaveBeenCalledTimes(1);
  });

  it("DT-22: unsupported narrowed count-only hydrates without calling count SQL and reports its actual execution", async () => {
    const countSessions = vi.fn().mockResolvedValue(99);
    const onQueryExecution = vi.fn();
    const oldSource: AgentSessionSyncSource = {
      ...source,
      countSessions,
      readSessionCompactFilterCapabilities: () => ({
        cursor: SESSION_COMPACT_FILTER_VERSION,
        count: SESSION_COMPACT_FILTER_VERSION + 1,
        usage: SESSION_COMPACT_FILTER_VERSION,
        analytics: SESSION_COMPACT_FILTER_VERSION,
      }),
    };
    const result = await getSharedAgentSessions(
      oldSource,
      { countOnly: true, quality: "substantive", limit: 25 },
      { onQueryExecution }
    );
    expect(countSessions).not.toHaveBeenCalled();
    expect(onQueryExecution).toHaveBeenCalledWith(
      ListQueryExecution.HydratedFallback
    );
    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
  });

  it("DT-18: persisted legacy status projects canonical status with raw evidence and DB-host capability", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss9524-session-"));
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "unknown",
      now: () => "2026-06-12T03:00:00.000Z",
    });
    try {
      await db.whenBootMaintenanceSettled();
      await db.run(
        `INSERT INTO sessions (id, name, status, harness, billing_mode, metadata, started_at, updated_at)
         VALUES ('legacy-local', 'Legacy local', 'waiting', 'claude', 'api', '{}',
           '2026-06-12T02:00:00.000Z', '2026-06-12T03:00:00.000Z')`
      );
      const capability =
        await db.syncSource.readSessionCompactFilterCapabilities?.();
      expect(capability?.cursor).toBe(SESSION_COMPACT_FILTER_VERSION);
      expect(capability?.usage).toBe(SESSION_COMPACT_FILTER_VERSION);
      const result = await getSharedAgentSessions(db.syncSource, { limit: 25 });
      expect(result.items).toEqual([
        expect.objectContaining({
          externalSessionId: "legacy-local",
          rawStatus: "waiting",
          status: SESSION_STATUS.ACTIVE,
        }),
      ]);
      expect(result.pageInfo?.capability).toBe(
        AgentSessionListCapability.ServerPaginationV1
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
