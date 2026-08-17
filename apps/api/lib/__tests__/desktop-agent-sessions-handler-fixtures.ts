import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import { type Mock, vi } from "vitest";

export const desktopAgentSessionsHandlerContext = {
  organizationId: "org-1",
  userId: "user-1",
  clerkUserId: "clerk-user-1",
  targetId: "target-1",
  gatewaySessionId: "session-1",
};

export const validDesktopAgentSessionsPayload = {
  schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
  batchId: "7bf9fe88-9a77-471d-a0ce-2b14a7fd5f4a",
  syncMode: AgentSessionSyncMode.Incremental,
  sessionCount: 1,
  sessions: [
    {
      externalSessionId: "sess-1",
      name: "Session One",
      status: "active",
      harness: "claude",
      cwd: "/tmp/worktree",
      model: "claude-sonnet-4",
      startedAt: "2026-05-20T17:00:00.000Z",
      updatedAt: "2026-05-20T17:05:00.000Z",
      metadata: { source: "desktop" },
      attribution: {
        repositoryFullName: "closedloop-ai/symphony-alpha",
        worktreePath: null,
        sourceArtifactId: "artifact-1",
        sourceLoopId: null,
        baseBranch: null,
      },
      agents: [],
      events: [],
      tokenUsageByModel: [
        {
          model: "claude-sonnet-4",
          inputTokens: 100,
          outputTokens: 25,
          cacheReadTokens: 10,
          cacheWriteTokens: 5,
          estimatedCostUsd: 0.01,
        },
      ],
    },
  ],
};

/**
 * Goal stage 2: an `upsertBatch` double that honours the real service contract
 * — it reports which `externalSessionId`s it PERSISTED, which is what the ack
 * echo is derived from. Defaults to persisting nothing, so a test that cares
 * about the echo must say so explicitly (`persisting([...])`) and cannot pass
 * by accident on a mock that mirrors its input back.
 */
export function upsertBatchMock(persistedSessionIds: string[] = []): Mock {
  return vi.fn().mockResolvedValue({ persistedSessionIds });
}
