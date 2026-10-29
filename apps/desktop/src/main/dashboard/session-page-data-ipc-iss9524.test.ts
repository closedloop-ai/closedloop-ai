import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSessionListCapability } from "@repo/api/src/types/agent-session-list-contract";
import { ARTIFACT_STATUS_ROOT_ORDER_FLAG_KEY } from "@repo/api/src/types/artifact-status-root-order-flag";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { SessionStatusOrderingName } from "@repo/api/src/types/session-status-root-order";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SHARED_AGENT_SESSIONS_IPC_CHANNELS } from "../../shared/shared-agent-sessions-contract.js";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import type { AgentSessionSyncSource } from "../agent-sync/agent-session-sync-source.js";
import type { DbHostAgentDatabase } from "../database/sqlite.js";
import { openSqliteAgentDatabase } from "../database/sqlite.js";
import type { WithDb } from "./agent-dashboard-ipc-handler-wrappers.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "./agent-dashboard-runtime-options.js";
import { registerSharedSessionAndBranchIpcHandlers } from "./agent-dashboard-shared-read-ipc.js";

const handlers = vi.hoisted(
  () => new Map<string, (...args: unknown[]) => unknown>()
);
const rootFlag = vi.hoisted(() => ({ enabled: false, read: vi.fn() }));
vi.mock("../auth/desktop-feature-flag-assignment.js", () => ({
  isDesktopMainFeatureFlagEnabled: rootFlag.read,
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  },
}));

const row: SyncedAgentSession = {
  externalSessionId: "first",
  name: "First",
  status: "inactive",
  harness: "claude",
  billingMode: "api",
  cwd: "/work/first",
  model: null,
  startedAt: "2026-06-12T02:00:00.000Z",
  updatedAt: "2026-06-12T03:00:00.000Z",
  endedAt: "2026-06-12T03:00:00.000Z",
  awaitingInputSince: null,
  metadata: null,
  attribution: {
    repositoryFullName: "org/repo",
    worktreePath: null,
    sourceArtifactId: null,
    sourceLoopId: null,
    baseBranch: null,
  },
  agents: [],
  events: [],
  tokenUsageByModel: [],
};
const rows: SyncedAgentSession[] = [
  row,
  { ...row, externalSessionId: "second", name: "Second" },
];
const source: AgentSessionSyncSource = {
  listAllSessionCursorRows: () =>
    rows.map((item) => ({
      id: item.externalSessionId,
      updated_at: item.updatedAt,
    })),
  listUpdatedSessionCursorRows: () => [],
  loadSyncedSessions: async (ids) =>
    rows.filter((item) => ids.includes(item.externalSessionId)),
};
const database = { syncSource: source } as unknown as DbHostAgentDatabase;
const withDb: WithDb =
  (handler) =>
  (_event, ...args) =>
    Promise.resolve(handler(database, ...args));
const options: AgentDashboardDesignSystemRuntimeOptions = {
  getWindow: () => null,
  isTrustedSender: () => true,
  onTerminalFailure: () => undefined,
  setAgentMonitorRuntimeStatus: () => undefined,
};

describe("ISS-9524 production Desktop page-data IPC", () => {
  beforeEach(() => {
    rootFlag.enabled = false;
    rootFlag.read.mockReset();
    rootFlag.read.mockImplementation(
      (key: string) =>
        key === ARTIFACT_STATUS_ROOT_ORDER_FLAG_KEY && rootFlag.enabled
    );
  });
  it("DT-18: handler returns the served list page capability and offset", async () => {
    registerSharedSessionAndBranchIpcHandlers({
      withDb,
      options,
      invokeStoreOp: async () => null,
      cancelDbHostRead: () => undefined,
    });
    const handler = handlers.get(SHARED_AGENT_SESSIONS_IPC_CHANNELS.pageData);
    expect(handler).toBeDefined();
    const result = await handler?.({ sender: {} }, { limit: 1, offset: 1 });
    expect(result).toMatchObject({
      list: {
        pageInfo: {
          capability: AgentSessionListCapability.ServerPaginationV1,
          limit: 1,
          offset: 1,
        },
        total: 2,
        items: [{ externalSessionId: "second" }],
      },
    });
  });

  it("DT-22: page-data IPC traverses the DB-host list projection and preserves status, raw evidence and page echo", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "prd728-ipc-projection-"));
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "unknown",
      now: () => "2026-06-12T03:00:00.000Z",
    });
    try {
      await db.whenBootMaintenanceSettled();
      await db.run(
        `INSERT INTO sessions (id, name, status, harness, billing_mode, metadata, started_at, updated_at)
         VALUES ('legacy-ipc', 'Legacy IPC', 'waiting', 'claude', 'api', '{}',
           '2026-06-12T02:00:00.000Z', '2026-06-12T03:00:00.000Z')`
      );
      await db.run(
        `INSERT INTO sessions (id, name, status, harness, billing_mode, metadata, started_at, updated_at)
         VALUES ('excluded-ipc', 'Excluded IPC', 'inactive', 'claude', 'api', '{}',
           '2026-06-12T02:00:00.000Z', '2026-06-12T03:00:00.000Z')`
      );
      await db.run(
        `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_estimated)
         VALUES ('legacy-ipc', 'small', 3, 0, 0, 0, 1), ('excluded-ipc', 'large', 11, 0, 0, 0, 7)`
      );
      const projectSessionList = vi.spyOn(db.syncSource, "projectSessionList");
      registerSharedSessionAndBranchIpcHandlers({
        withDb:
          (handler) =>
          (_event, ...args) =>
            Promise.resolve(handler(db, ...args)),
        options,
        invokeStoreOp: async () => null,
        cancelDbHostRead: () => undefined,
      });
      const handler = handlers.get(SHARED_AGENT_SESSIONS_IPC_CHANNELS.pageData);
      expect(handler).toBeDefined();
      const result = await handler?.(
        { sender: {} },
        { limit: 1, offset: 0, quality: "all" }
      );
      expect(projectSessionList).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({ limit: 1, offset: 0 }),
        })
      );
      expect(result).toMatchObject({
        list: {
          pageInfo: {
            capability: AgentSessionListCapability.ServerPaginationV1,
            limit: 1,
            offset: 0,
          },
          items: [
            {
              externalSessionId: "legacy-ipc",
              status: SESSION_STATUS.ACTIVE,
              rawStatus: "waiting",
            },
          ],
          total: 2,
        },
        usage: {
          totalSessions: 2,
          totalEstimatedCost: 8,
          totalInputTokens: 14,
        },
      });
      const filtered = await handler?.(
        { sender: {} },
        {
          limit: 1,
          offset: 0,
          statuses: [SESSION_STATUS.INACTIVE],
          quality: "all",
        }
      );
      expect(filtered).toMatchObject({
        list: { total: 1, items: [{ externalSessionId: "excluded-ipc" }] },
        usage: {
          totalSessions: 1,
          totalEstimatedCost: 7,
          totalInputTokens: 11,
        },
      });
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("DT-20: main assignment orders the real DB-host projection by roots only while enabled", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "prd728-status-ipc-"));
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "unknown",
      now: () => "2026-06-12T03:00:00.000Z",
    });
    try {
      await db.whenBootMaintenanceSettled();
      for (const [id, status] of [
        ["a-active", "active"],
        ["q-unknown", "waiting"],
        ["x-error", "error"],
        ["m-inactive", "inactive"],
        ["z-active", "active"],
      ]) {
        await db.run(
          `INSERT INTO sessions (id, name, status, harness, billing_mode, metadata, started_at, updated_at)
           VALUES ($1, $1, $2, 'claude', 'api', '{}', '2026-06-12T02:00:00.000Z', $3)`,
          id,
          status,
          id === "a-active"
            ? "2026-06-12T03:01:00.000Z"
            : "2026-06-12T03:00:00.000Z"
        );
      }
      registerSharedSessionAndBranchIpcHandlers({
        withDb:
          (handler) =>
          (_event, ...args) =>
            Promise.resolve(handler(db, ...args)),
        options,
        invokeStoreOp: async () => null,
        cancelDbHostRead: () => undefined,
      });
      const handler = handlers.get(SHARED_AGENT_SESSIONS_IPC_CHANNELS.list);
      expect(handler).toBeDefined();
      const readIds = async (sortDir: "asc" | "desc") => {
        rootFlag.read.mockClear();
        const result = await handler?.(
          { sender: {} },
          { sortBy: "status", sortDir, limit: 10 }
        );
        expect(rootFlag.read).toHaveBeenCalledExactlyOnceWith(
          ARTIFACT_STATUS_ROOT_ORDER_FLAG_KEY
        );
        return (result as { items: { externalSessionId: string }[] }).items.map(
          (item) => item.externalSessionId
        );
      };
      rootFlag.enabled = true;
      expect(await readIds("asc")).toEqual([
        "z-active",
        "a-active",
        "m-inactive",
        "x-error",
        "q-unknown",
      ]);
      expect(await readIds("desc")).toEqual([
        "x-error",
        "m-inactive",
        "z-active",
        "a-active",
        "q-unknown",
      ]);
      rootFlag.enabled = false;
      expect(await readIds("asc")).toEqual([
        "a-active",
        "z-active",
        "x-error",
        "m-inactive",
        "q-unknown",
      ]);
      expect(await readIds("desc")).toEqual([
        "q-unknown",
        "m-inactive",
        "x-error",
        "a-active",
        "z-active",
      ]);
      const project = db.syncSource.projectSessionList;
      expect(project).toBeDefined();
      for (const statusOrdering of [
        undefined,
        "future_status_order" as SessionStatusOrderingName,
      ]) {
        const projected = await project?.({
          request: { sortBy: "status", sortDir: "asc", limit: 10 },
          computeTargetId: null,
          users: [],
          ...(statusOrdering === undefined ? {} : { statusOrdering }),
        });
        expect(projected?.items.map((item) => item.externalSessionId)).toEqual([
          "a-active",
          "z-active",
          "x-error",
          "m-inactive",
          "q-unknown",
        ]);
      }
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
