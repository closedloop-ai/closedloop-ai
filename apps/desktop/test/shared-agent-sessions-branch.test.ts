import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionPrRelationType } from "@repo/api/src/types/session-artifact-link";
import { SessionPrLifecycleStatus } from "@repo/lib/session-trace/derivation";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import { getSharedAgentSessions } from "../src/main/session/shared-agent-sessions-api.js";

// FEA-2531: the Sessions list shows the write-derived branch only. The dropped
// attribution.baseBranch fallback means a read-only session (branch = null)
// renders no branch even when attribution carries a base/start branch.
//
// FEA-3284: the list now default-hides idle sessions (0 turns / 0 tokens / 0
// tool uses), and these fixtures are intentionally minimal (no activity signal),
// so they read as idle. This test is about branch attribution, not the idle
// gate, so every read passes `quality: "all"` to reveal the fixtures regardless
// of substantiveness.

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

  const list = await getSharedAgentSessions(source, { quality: "all" });
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

  const list = await getSharedAgentSessions(source, { quality: "all" });
  assert.equal(list.items[0]?.branch, "feat/x");
});

// FEA-4188: a session/branch surface must never show a PR *write* (a CREATED /
// authored PR ref) without the branch it belongs to. When the created-PR ref
// resolved but no branch write link did, the session's branch is null, so the
// orphaned authored write is suppressed from the rendered PR column.
//
// The SQLite-hydrated production shape emits the SAME created PR in BOTH `prs`
// (repo-stripped) and `prRefs`, so this fixture populates both — suppression has
// to drop the legacy `prs` twin too, not just its `prRefs` half.
test("CREATED PR write is suppressed when the session has no resolved branch", async () => {
  const source = fakeSource(
    syncedSession({
      externalSessionId: "orphan-pr-write",
      // No write-derived branch resolved for this session.
      branch: null,
      attribution: {
        repositoryFullName: "closedloop-ai/symphony-alpha",
        baseBranch: "main",
      },
      prs: [
        {
          num: 4188,
          title: "orphan",
          status: SessionPrLifecycleStatus.Unknown,
        },
      ],
      prRefs: [
        {
          repositoryFullName: "closedloop-ai/symphony-alpha",
          prNumber: 4188,
          relationType: SessionPrRelationType.Created,
        },
      ],
    })
  );

  const list = await getSharedAgentSessions(source, { quality: "all" });
  assert.equal(list.items[0]?.id, "orphan-pr-write");
  assert.equal(list.items[0]?.branch, null);
  // The authored PR write is not shown without its required branch — the legacy
  // `prs` twin is dropped too, so the rendered PR column is empty.
  assert.deepEqual(list.items[0]?.prs, []);
});

test("CREATED PR write renders when the session's branch is present", async () => {
  const source = fakeSource(
    syncedSession({
      externalSessionId: "pr-write-with-branch",
      branch: "feat/fea-4188",
      attribution: {
        repositoryFullName: "closedloop-ai/symphony-alpha",
        baseBranch: "main",
      },
      prRefs: [
        {
          repositoryFullName: "closedloop-ai/symphony-alpha",
          prNumber: 4188,
          relationType: SessionPrRelationType.Created,
        },
      ],
    })
  );

  const list = await getSharedAgentSessions(source, { quality: "all" });
  assert.equal(list.items[0]?.branch, "feat/fea-4188");
  assert.equal(list.items[0]?.prs?.length, 1);
  assert.equal(list.items[0]?.prs?.[0]?.num, 4188);
});

// A REFERENCED PR ref is a mention, not an authored write, so it is NOT gated on
// a resolved branch — it must still render even when the session has no branch.
test("REFERENCED PR ref still renders without a resolved branch (not a write)", async () => {
  const source = fakeSource(
    syncedSession({
      externalSessionId: "referenced-pr",
      branch: null,
      attribution: {
        repositoryFullName: "closedloop-ai/symphony-alpha",
        baseBranch: "main",
      },
      prRefs: [
        {
          repositoryFullName: "closedloop-ai/symphony-alpha",
          prNumber: 999,
          relationType: SessionPrRelationType.Referenced,
        },
      ],
    })
  );

  const list = await getSharedAgentSessions(source, { quality: "all" });
  assert.equal(list.items[0]?.branch, null);
  assert.equal(list.items[0]?.prs?.length, 1);
  assert.equal(list.items[0]?.prs?.[0]?.num, 999);
});
