/**
 * ISS-11283 lane-local harness for `AgentComponentSyncLane` coverage suites.
 *
 * The lane reads a REAL migrated store: the keyset cursor is the production
 * `listAgentComponentCursorRows`, rows load through `loadSyncedComponentRows`,
 * and the durable cursor is the production `createSyncCursorStateDelegates`
 * layered over `FakeSyncSource` (which only fills the unrelated session-lane
 * members of `AgentSessionSyncSource`). Only the transport (`sendComponents`) is
 * faked, and every hook a case needs to model a concurrent write or an account
 * switch is an explicit, per-call callback.
 */
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import type { SyncedComponent } from "@repo/api/src/types/agent-session";
import type { ComponentSyncSendResult } from "../src/main/agent-sync/agent-component-sync-dead-letter.js";
import type { AgentComponentSyncLaneOptions } from "../src/main/agent-sync/agent-component-sync-lane-contract.js";
import { AgentComponentSyncLane } from "../src/main/agent-sync/agent-session-sync-component-lane.js";
import type {
  AgentComponentCursorRow,
  AgentSessionSyncSource,
  DesktopAgentComponentsPayload,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  listAgentComponentCursorRows,
  loadSyncedComponentRows,
} from "../src/main/database/component-sync-source.js";
import { createSyncCursorStateDelegates } from "../src/main/database/sync-cursor-state-delegates.js";
import { FakeSyncSource } from "./fake-sync-source.js";
import type { OpenTestPrisma } from "./prisma-test-utils.js";

export const LANE_TARGET = "target-iss11283";

export type LaneHarnessHooks = {
  /** Runs after the real cursor query returned, before the lane sees rows. */
  afterCursorRead?: (rows: AgentComponentCursorRow[]) => Promise<void>;
  /** Runs before the real row load. */
  beforeLoad?: (ids: string[]) => Promise<void>;
  /** The transport. Required so every case states what the cloud answered. */
  send: (
    payload: DesktopAgentComponentsPayload
  ) => Promise<ComponentSyncSendResult>;
  /** Source availability per `getSource()` call (0-based across the lane's life). */
  sourceAvailable?: (call: number) => boolean;
  /** The host's source-state generation. Defaults to a constant 1. */
  generation?: () => number;
  /** Replaces the lane's `getSyncComputeTargetId`. Defaults to {@link LANE_TARGET}. */
  target?: () => string | null;
};

export type LaneHarness = {
  lane: AgentComponentSyncLane;
  source: AgentSessionSyncSource;
  sentPayloads: DesktopAgentComponentsPayload[];
  cursorReads: Array<{ sinceTs: string; sinceId: string }>;
};

export async function seedInventoryRow(
  opened: OpenTestPrisma,
  id: string,
  lastSeenAt: string | null
): Promise<void> {
  await opened.db.query(
    `INSERT INTO agent_components (id, component_kind, external_id, component_key, last_seen_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, AgentComponentKind.Mcp, id, id, lastSeenAt]
  );
}

export async function deleteInventoryRow(
  opened: OpenTestPrisma,
  id: string
): Promise<void> {
  await opened.db.query("DELETE FROM agent_components WHERE id = ?", [id]);
}

export function createLaneHarness(
  opened: OpenTestPrisma,
  hooks: LaneHarnessHooks
): LaneHarness {
  const source: AgentSessionSyncSource = Object.assign(
    new FakeSyncSource([]),
    createSyncCursorStateDelegates(opened.prisma)
  );
  const sentPayloads: DesktopAgentComponentsPayload[] = [];
  const cursorReads: Array<{ sinceTs: string; sinceId: string }> = [];
  let getSourceCalls = 0;
  const options: AgentComponentSyncLaneOptions = {
    getSource: () => {
      const call = getSourceCalls;
      getSourceCalls += 1;
      return (hooks.sourceAvailable?.(call) ?? true) ? source : null;
    },
    getSyncComputeTargetId: hooks.target ?? (() => LANE_TARGET),
    listComponentCursorRows: async (sinceTs, sinceId, limit) => {
      cursorReads.push({ sinceTs, sinceId });
      const rows = await listAgentComponentCursorRows(
        opened.prisma,
        sinceTs,
        sinceId,
        limit
      );
      await hooks.afterCursorRead?.(rows);
      return rows;
    },
    loadComponentRows: async (ids): Promise<SyncedComponent[]> => {
      await hooks.beforeLoad?.(ids);
      return await loadSyncedComponentRows(opened.prisma, ids);
    },
    sendComponents: (payload) => {
      sentPayloads.push(payload);
      return hooks.send(payload);
    },
  };
  const lane = new AgentComponentSyncLane(options, {
    getSourceStateGeneration: hooks.generation ?? (() => 1),
    isStarted: () => true,
  });
  return { lane, source, sentPayloads, cursorReads };
}
