import assert from "node:assert/strict";
import { test } from "node:test";
import type { SyncedAgentSession } from "../src/main/agent-session-sync-contract.js";
import type { AgentSessionSyncSource } from "../src/main/agent-session-sync-service.js";
import { getSharedAgentSessions } from "../src/main/shared-agent-sessions-api.js";

// FEA-2531: the Sessions list shows the write-derived branch only. The dropped
// attribution.baseBranch fallback means a read-only session (branch = null)
// renders no branch even when attribution carries a base/start branch.

function syncedSession(
  overrides: Partial<SyncedAgentSession> & { externalSessionId: string }
): SyncedAgentSession {
  return {
    name: `Session ${overrides.externalSessionId}`,
    status: "completed",
    harness: "claude",
    cwd: `/tmp/${overrides.externalSessionId}`,
    model: "gpt-test",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T01:00:00.000Z",
    endedAt: "2026-01-01T02:00:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...overrides,
  };
}

function fakeSource(session: SyncedAgentSession): AgentSessionSyncSource {
  return {
    listAllSessionCursorRows: () => [
      { id: session.externalSessionId, updated_at: session.updatedAt },
    ],
    listUpdatedSessionCursorRows: () => [],
    loadSyncedSessions: () => [session],
  };
}

test("list item branch is null for a read-only session even when attribution.baseBranch exists", async () => {
  const source = fakeSource(
    syncedSession({
      externalSessionId: "read-only",
      branch: null,
      attribution: {
        repositoryFullName: "closedloop-ai/symphony-alpha",
        baseBranch: "main",
      },
    })
  );

  const list = await getSharedAgentSessions(source);
  assert.equal(list.items[0]?.id, "read-only");
  assert.equal(list.items[0]?.branch, null);
});

test("list item branch reflects the write-derived branch when present", async () => {
  const source = fakeSource(
    syncedSession({
      externalSessionId: "wrote-branch",
      branch: "feat/x",
      attribution: {
        repositoryFullName: "closedloop-ai/symphony-alpha",
        baseBranch: "main",
      },
    })
  );

  const list = await getSharedAgentSessions(source);
  assert.equal(list.items[0]?.branch, "feat/x");
});
