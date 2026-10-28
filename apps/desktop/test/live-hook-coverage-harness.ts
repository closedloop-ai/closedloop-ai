/**
 * @file live-hook-coverage-harness.ts
 * @description Shared setup for the live-hook-coverage suites: a migrated test
 * database, a lifecycle with a movable clock and a recorded log, and small
 * row readers for the sessions/agents/events columns those suites assert.
 */
import type { HookData } from "../src/main/dashboard/agent-dashboard-db-types.js";
import { createSqliteLifecycle } from "../src/main/database/live-hook.js";
import { createSqliteTokenUsageStore } from "../src/main/database/read-stores.js";
import type { TranscriptExtract } from "../src/main/database/transcript.js";
import { type OpenTestPrisma, openTestPrisma } from "./prisma-test-utils.js";

export const HARNESS_NOW = "2026-09-01T12:00:00.000Z";

export type Lifecycle = ReturnType<typeof createSqliteLifecycle>;
export type LifecycleDeps = Parameters<typeof createSqliteLifecycle>[2];
export type TokenUsageStore = ReturnType<typeof createSqliteTokenUsageStore>;

export type LiveHookHarness = {
  store: OpenTestPrisma["db"];
  prisma: OpenTestPrisma["prisma"];
  lifecycle: Lifecycle;
  logs: string[];
  setNow: (value: string) => void;
  send: (hookType: string, data: HookData) => Promise<boolean>;
  close: () => Promise<void>;
};

export type SessionRow = {
  status: string;
  billing_mode: string | null;
  awaiting_input_since: string | null;
  ends_with_error: number | null;
};

export type AgentRow = {
  id: string;
  name: string;
  status: string;
  subagent_type: string | null;
  task: string | null;
  current_tool: string | null;
  parent_agent_id: string | null;
  metadata: string | null;
};

export type EventRow = {
  agent_id: string | null;
  event_type: string;
  tool_name: string | null;
  summary: string | null;
};

export async function openLiveHookHarness(
  overrides: {
    deps?: Partial<LifecycleDeps>;
    tokenUsage?: (base: TokenUsageStore) => TokenUsageStore;
  } = {}
): Promise<LiveHookHarness> {
  const opened = await openTestPrisma();
  let clock = HARNESS_NOW;
  const logs: string[] = [];
  const baseTokenUsage = createSqliteTokenUsageStore(opened.prisma);
  const lifecycle = createSqliteLifecycle(
    opened.prisma,
    overrides.tokenUsage
      ? overrides.tokenUsage(baseTokenUsage)
      : baseTokenUsage,
    {
      detectBillingMode: () => "unknown",
      extractTranscript: () => null,
      log: (message) => {
        logs.push(message);
      },
      now: () => clock,
      ...overrides.deps,
    }
  );
  return {
    store: opened.db,
    prisma: opened.prisma,
    lifecycle,
    logs,
    setNow: (value) => {
      clock = value;
    },
    send: (hookType, data) => lifecycle.processEvent(hookType, data, "claude"),
    close: opened.close,
  };
}

export function emptyTranscript(
  overrides: Partial<TranscriptExtract> = {}
): TranscriptExtract {
  return {
    tokensByModel: new Map(),
    latestModel: null,
    compactionCount: 0,
    records: [],
    hasTrailingApiError: false,
    ...overrides,
  };
}

export async function readSession(
  harness: LiveHookHarness,
  sessionId: string
): Promise<SessionRow | undefined> {
  const result = await harness.store.query<SessionRow>(
    "SELECT status, billing_mode, awaiting_input_since, ends_with_error FROM sessions WHERE id = $1",
    [sessionId]
  );
  return result.rows[0];
}

export async function readAgents(
  harness: LiveHookHarness,
  sessionId: string
): Promise<AgentRow[]> {
  const result = await harness.store.query<AgentRow>(
    "SELECT id, name, status, subagent_type, task, current_tool, parent_agent_id, metadata FROM agents WHERE session_id = $1 ORDER BY started_at, id",
    [sessionId]
  );
  return result.rows;
}

export async function readEvents(
  harness: LiveHookHarness,
  sessionId: string
): Promise<EventRow[]> {
  const result = await harness.store.query<EventRow>(
    "SELECT agent_id, event_type, tool_name, summary FROM events WHERE session_id = $1 ORDER BY created_at, event_type",
    [sessionId]
  );
  return result.rows;
}
