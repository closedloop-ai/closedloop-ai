import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SessionPrLifecycleStatus } from "@repo/api/src/session-trace/derivation";
import {
  AgentSessionState,
  type TurnItem,
} from "@repo/api/src/types/agent-session";
import { SessionPrRelationType } from "@repo/api/src/types/session-artifact-link";
import type { SyncedAgentSession } from "../src/main/agent-session-sync-contract.js";
import type {
  AgentSessionSyncSource,
  SessionAttributionResolverCache,
  SessionCursorRow,
  SessionListCursorPageRequest,
} from "../src/main/agent-session-sync-service.js";
import {
  getSharedAgentSessionAnalytics,
  getSharedAgentSessionDetail,
  getSharedAgentSessions,
  getSharedAgentSessionsByIds,
  getSharedAgentSessionUsage,
  MAX_WORKING_SET_SESSIONS,
} from "../src/main/shared-agent-sessions-api.js";
import type { BillingMode } from "../src/shared/billing-mode.js";
import { DESKTOP_LOCAL_SESSION_AUTHOR_LABEL } from "../src/shared/shared-agent-sessions-contract.js";

const CURSOR_FAILED_PATTERN = /cursor failed/;
const LOAD_FAILED_PATTERN = /load failed/;

describe("shared agent sessions API mapper", () => {
  test("no-ID list reads enumerate cursors, allocate a per-call cache, reassemble order, filter, and paginate", async () => {
    const source = createFakeSource({
      cursorRows: [
        cursor("stale"),
        cursor("session-b"),
        cursor("session-a"),
        cursor("session-c"),
      ],
      loadOrder: ["session-c", "session-a", "session-b"],
    });

    const response = await getSharedAgentSessions(source, {
      status: "completed",
      limit: 1,
      offset: 1,
    });

    assert.deepEqual(
      source.calls.map((call) => call.kind),
      ["listAllSessionCursorRows", "loadSyncedSessions"]
    );
    assert.deepEqual(source.calls[1]?.ids, [
      "stale",
      "session-b",
      "session-a",
      "session-c",
    ]);
    assert.ok(source.calls[1]?.cache?.attributionByCwd instanceof Map);
    assert.ok(source.calls[1]?.cache?.launchMetadataRootByCwd instanceof Map);
    assert.ok(source.calls[1]?.cache?.repoFullNameByPath instanceof Map);
    assert.equal(response.total, 2);
    assert.deepEqual(
      response.items.map((item) => item.id),
      ["session-c"]
    );
    assert.equal(response.viewerScope, "self");
  });

  test("unfiltered paginated list reads load only the requested page", async () => {
    const source = createFakeSource({
      cursorRows: [
        cursor("session-a"),
        cursor("session-b"),
        cursor("session-c"),
        cursor("session-d"),
      ],
      sessions: {
        ...defaultSessions(),
        "session-d": session({ id: "session-d" }),
      },
    });

    const response = await getSharedAgentSessions(source, {
      limit: 2,
      offset: 1,
    });

    assert.deepEqual(
      source.calls.map((call) => call.kind),
      ["listAllSessionCursorRows", "loadSyncedSessions"]
    );
    assert.deepEqual(source.calls[1]?.ids, ["session-b", "session-c"]);
    assert.equal(response.total, 4);
    assert.deepEqual(
      response.items.map((item) => item.id),
      ["session-b", "session-c"]
    );
  });

  test("default last-activity sorted list reads hydrate only the requested cursor page", async () => {
    const cursorRows = [
      cursor("session-a", "2026-01-03T00:00:00.000Z"),
      cursor("session-b", "2026-01-02T00:00:00.000Z"),
      cursor("session-c", "2026-01-01T00:00:00.000Z"),
      cursor("session-d", "2025-12-31T00:00:00.000Z"),
    ];
    const source = createFakeSource({
      cursorRows,
      sessions: {
        ...defaultSessions(),
        "session-d": session({ id: "session-d" }),
      },
    });

    const response = await getSharedAgentSessions(source, {
      limit: 2,
      offset: 1,
      sortBy: "lastActivity",
      sortDir: "desc",
    });

    assert.deepEqual(
      source.calls.map((call) => call.kind),
      ["listSessionCursorPage", "loadSyncedSessions"]
    );
    assert.deepEqual(source.calls[0]?.cursorPageRequest, {
      limit: 2,
      offset: 1,
      sortBy: "lastActivity",
      sortDir: "desc",
    });
    assert.deepEqual(source.calls[1]?.ids, ["session-b", "session-c"]);
    assert.equal(response.total, 4);
    assert.deepEqual(
      response.items.map((item) => item.id),
      ["session-b", "session-c"]
    );
  });

  test("date and search filtered sorted lists read a filtered cursor page", async () => {
    const source = createFakeSource({
      cursorRows: [
        cursor("old-match", "2026-06-23T00:00:00.000Z"),
        cursor("recent-mismatch", "2026-06-20T00:00:00.000Z"),
        cursor("recent-match", "2026-06-21T00:00:00.000Z"),
      ],
      sessions: {
        "old-match": session({
          id: "old-match",
          branch: "fea-2161",
          startedAt: "2026-06-17T00:00:00.000Z",
        }),
        "recent-mismatch": session({
          id: "recent-mismatch",
          branch: "fea-9999",
          startedAt: "2026-06-20T00:00:00.000Z",
        }),
        "recent-match": session({
          id: "recent-match",
          branch: "fea-2161",
          startedAt: "2026-06-21T00:00:00.000Z",
        }),
      },
    });

    const response = await getSharedAgentSessions(source, {
      limit: 25,
      offset: 0,
      search: "fea-2161",
      sortBy: "lastActivity",
      sortDir: "desc",
      startDate: "2026-06-18T00:00:00.000Z",
    });

    assert.deepEqual(
      source.calls.map((call) => call.kind),
      ["listSessionCursorPage", "loadSyncedSessions"]
    );
    assert.equal(
      source.calls[0]?.cursorPageRequest?.startDate?.toISOString(),
      "2026-06-18T00:00:00.000Z"
    );
    assert.equal(source.calls[0]?.cursorPageRequest?.search, "fea-2161");
    assert.deepEqual(source.calls[1]?.ids, ["old-match", "recent-match"]);
    assert.equal(response.total, 2);
    assert.deepEqual(
      response.items.map((item) => item.id),
      ["old-match", "recent-match"]
    );
  });

  test("explicit-ID reads de-duplicate caller order and skip cursor enumeration", async () => {
    const explicitIds = [
      "session-a",
      "session-c",
      "session-a",
      "",
      "session-b",
      ...Array.from({ length: 105 }, (_, index) => `extra-${index}`),
    ];
    const source = createFakeSource({
      loadOrder: ["session-c", "session-a"],
    });

    const response = await getSharedAgentSessions(source, {
      ids: explicitIds,
    });

    assert.deepEqual(
      source.calls.map((call) => call.kind),
      ["loadSyncedSessions"]
    );
    assert.equal(source.calls[0]?.ids?.length, 100);
    assert.deepEqual(source.calls[0]?.ids, [
      "session-a",
      "session-c",
      "session-b",
      ...Array.from({ length: 97 }, (_, index) => `extra-${index}`),
    ]);
    assert.deepEqual(
      response.items.map((item) => item.id),
      ["session-a", "session-c"]
    );
  });

  test("malformed explicit IDs fail closed before source reads", async () => {
    const stringIdsSource = createFakeSource();
    const stringIdsResponse = await getSharedAgentSessions(stringIdsSource, {
      ids: "abc",
    } as never);
    assert.deepEqual(stringIdsResponse, {
      items: [],
      total: 0,
      viewerScope: "self",
    });
    assert.deepEqual(stringIdsSource.calls, []);
  });

  test("detail reads preserve repeated exec_command payloads through local projection", async () => {
    const source = createFakeSource({
      sessions: {
        ...defaultSessions(),
        "session-commands": session({
          id: "session-commands",
          harness: "codex",
          events: [
            {
              externalEventId: "command-a",
              eventType: "PostToolUse",
              toolName: "exec_command",
              summary: null,
              data: { command: "pnpm -C apps/desktop test" },
              createdAt: "2026-01-01T00:05:00.000Z",
            },
            {
              externalEventId: "command-b",
              eventType: "PostToolUse",
              toolName: "exec_command",
              summary: null,
              data: {
                executable: "git",
                arguments: ["diff", "--stat"],
              },
              createdAt: "2026-01-01T00:06:00.000Z",
            },
          ],
        }),
      },
    });

    const detail = await getSharedAgentSessionDetail(
      source,
      "session-commands"
    );

    assert.deepEqual(
      detail?.timeline?.map((event) => [event.title, event.detail]),
      [
        ["exec_command", "pnpm -C apps/desktop test"],
        ["exec_command", "git diff --stat"],
      ]
    );
    assert.deepEqual(
      detail?.events?.map((event) => event.data),
      [
        { command: "pnpm -C apps/desktop test" },
        { executable: "git", arguments: ["diff", "--stat"] },
      ]
    );
  });

  test("projection uses loaded payload fields, pinned defaults, detail data, and derived totals", async () => {
    const source = createFakeSource({
      cursorRows: [cursor("session-a", "1999-01-01T00:00:00.000Z")],
      sessions: {
        "session-a": session({
          id: "session-a",
          status: "failed",
          updatedAt: "2026-01-02T00:00:00.000Z",
          attribution: {
            repositoryFullName: "closedloop-ai/symphony-alpha",
            worktreePath: "repo",
            sourceArtifactId: "FEA-1704",
            sourceLoopId: "loop-1",
            baseBranch: "main",
          },
        }),
      },
    });

    const list = await getSharedAgentSessions(source);
    const item = list.items[0];
    assert.equal(item?.id, "session-a");
    assert.equal(item?.slug, null);
    assert.equal(item?.sourceArtifact, null);
    assert.equal(item?.user, null);
    assert.equal(item?.project, null);
    assert.equal(item?.computeTarget.id, "local-desktop");
    assert.equal(item?.computeTarget.isOnline, true);
    assert.equal(item?.updatedAt.toISOString(), "2026-01-02T00:00:00.000Z");
    assert.equal(
      item?.computeTarget.lastSeenAt.toISOString(),
      "2026-01-02T00:00:00.000Z"
    );
    assert.equal(item?.repositoryFullName, "closedloop-ai/symphony-alpha");
    assert.equal(item?.inputTokens, 10);
    assert.equal(item?.outputTokens, 20);
    assert.equal(item?.cacheReadTokens, 3);
    assert.equal(item?.cacheWriteTokens, 4);
    assert.equal(item?.estimatedCost, 0.25);
    assert.equal(item?.agentCount, 2);
    assert.equal(item?.toolUseCount, 1);
    assert.equal(item?.errorCount, 1);

    const detail = await getSharedAgentSessionDetail(source, "session-a");
    assert.equal(detail?.metadata?.kind, "fixture");
    assert.equal(detail?.tokenUsageByModel.length, 1);
    assert.equal(detail?.attribution?.sourceArtifactId, "FEA-1704");
    assert.equal(detail?.agents[0]?.task, "private task");
    assert.equal(detail?.events[0]?.summary, null);
    assert.deepEqual(detail?.events[0]?.data, {
      filePath: "src/visible.ts",
      command: "cat secret.txt",
      stdout: "secret",
      stderr: "secret",
      nested: { visible: "yes", content: "secret" },
    });
    assert.equal(detail?.timeline?.[0]?.title, "Bash");
    assert.equal(
      detail?.timeline?.[0]?.detail,
      "src/visible.ts · cat secret.txt"
    );
    const subagentTurn = detail?.turnItems?.find(
      (item) => item.type === "subagent"
    );
    assert.equal(subagentTurn?.type, "subagent");
    if (subagentTurn?.type === "subagent") {
      assert.equal(subagentTurn.sub, "Reviewer");
      assert.equal(subagentTurn.subagentType, "reviewer");
      assert.equal(subagentTurn.status, "failed");
      assert.equal(subagentTurn.model, "gpt-test");
      assert.equal(subagentTurn.duration, "1h 30m");
      assert.equal(subagentTurn.tokens, null);
      assert.equal(subagentTurn.cost, null);
      assert.deepEqual(subagentTurn.body, [
        {
          kind: "event",
          text: "agent_error",
          t: "2026-01-01T00:06:00.000Z",
          err: true,
        },
        {
          kind: "status",
          text: "failed",
          t: "2026-01-01T01:30:00.000Z",
          err: true,
        },
      ]);
    }
  });

  test("detail preserves local field ownership and uses the desktop author fallback", async () => {
    const localSession = {
      ...session({
        id: "session-local-detail",
        status: "running",
        awaitingInputSince: "2026-01-01T01:30:00.000Z",
        endedAt: null,
        attribution: {
          repositoryFullName: "closedloop-ai/symphony-alpha",
          worktreePath: "/worktrees/fea-1943",
          sourceArtifactId: "FEA-1943",
          sourceLoopId: "loop-local",
          baseBranch: "main",
        },
        metadata: {
          kind: "fixture",
          messages: [
            {
              role: "human",
              timestamp: "2026-01-01T00:00:00.000Z",
              text: "Review local session details.",
            },
          ],
        },
      }),
      userId: "legacy-local-user",
      branch: "feat/fea-1943-session-details-local-data",
      prs: [
        {
          num: 42,
          status: SessionPrLifecycleStatus.Merged,
          title: "Complete local details",
        },
        {
          num: 43,
          status: SessionPrLifecycleStatus.Open,
          title: "Follow-up trace polish",
        },
      ],
      wallClock: "2h",
      activeAgent: "1h 40m",
      waitingUser: "20m",
      linesAdded: 120,
      linesRemoved: 12,
      filesChanged: 4,
      turns: 8,
      steeringEpisodes: 1,
      autonomy: 82,
    } satisfies SyncedAgentSession;
    const source = createFakeSource({
      cursorRows: [cursor("session-local-detail")],
      sessions: {
        "session-local-detail": localSession,
      },
    });

    const detail = await getSharedAgentSessionDetail(
      source,
      "session-local-detail"
    );

    assert.equal(detail?.id, "session-local-detail");
    assert.equal(detail?.name, "Session session-local-detail");
    assert.equal(detail?.status, "active");
    assert.equal(detail?.state, AgentSessionState.PendingApproval);
    assert.equal(detail?.user, null);
    assert.equal(detail?.project, null);
    assert.equal(detail?.sourceArtifact, null);
    assert.equal(detail?.userColor, null);
    assert.equal(detail?.harness, "claude");
    assert.equal(detail?.model, "gpt-test");
    assert.equal(detail?.primaryModel, "gpt-test");
    assert.equal(detail?.repositoryFullName, "closedloop-ai/symphony-alpha");
    assert.equal(detail?.repo, "closedloop-ai/symphony-alpha");
    assert.equal(detail?.worktreePath, "/worktrees/fea-1943");
    assert.equal(detail?.branch, "feat/fea-1943-session-details-local-data");
    assert.equal(detail?.sourceArtifactId, "FEA-1943");
    assert.equal(detail?.sourceLoopId, "loop-local");
    assert.equal(detail?.prs?.length, 2);
    assert.equal(detail?.prsMerged, 1);
    assert.equal(detail?.linesAdded, 120);
    assert.equal(detail?.linesRemoved, 12);
    assert.equal(detail?.filesChanged, 4);
    assert.equal(detail?.wallClock, "2h");
    assert.equal(detail?.activeAgent, "1h 40m");
    assert.equal(detail?.waitingUser, "20m");
    assert.equal(detail?.cost, "$0.25");
    assert.equal(detail?.tokensIn, 10);
    assert.equal(detail?.tokensOut, 20);
    assert.equal(detail?.cache, 3);
    assert.equal(detail?.cacheWrite, 4);
    assert.equal(detail?.turns, 8);
    assert.equal(detail?.toolCallsTotal, 1);
    assert.equal(detail?.steeringEpisodes, 1);
    assert.equal(detail?.autonomy, 82);

    const promptTurn = detail?.turnItems?.find(
      (item) => item.type === "prompt"
    );
    assert.equal(promptTurn?.type, "prompt");
    if (promptTurn?.type === "prompt") {
      assert.equal(promptTurn.actor.name, DESKTOP_LOCAL_SESSION_AUTHOR_LABEL);
    }
  });

  test("detail projects locally stored metadata messages into trace turns", async () => {
    const source = createFakeSource({
      cursorRows: [cursor("session-with-messages")],
      sessions: {
        "session-with-messages": session({
          id: "session-with-messages",
          metadata: {
            kind: "fixture",
            messages: [
              {
                role: "human",
                timestamp: "2026-01-01T00:00:00.000Z",
                text: "Please inspect the failing test.",
              },
              {
                role: "assistant",
                timestamp: "2026-01-01T00:01:00.000Z",
                text: "I found the failing assertion.",
                model: "gpt-test",
              },
              {
                role: "human",
                timestamp: "2026-01-01T00:02:00.000Z",
              },
            ],
          },
        }),
      },
    });

    const detail = await getSharedAgentSessionDetail(
      source,
      "session-with-messages"
    );

    assert.deepEqual(
      detail?.timeline
        ?.slice(0, 4)
        .map((event) => [event.kind, event.title, event.detail]),
      [
        ["human", "human", "Please inspect the failing test."],
        ["say", "gpt-test", "I found the failing assertion."],
        ["human", "human", undefined],
        ["tool", "Bash", "src/visible.ts · cat secret.txt"],
      ]
    );
    assert.deepEqual(
      detail?.turnItems
        ?.filter(
          (item) =>
            item.type === "prompt" ||
            item.type === "say" ||
            item.type === "tools"
        )
        .slice(0, 4)
        .map((item) => [item.type, turnItemPreviewText(item)]),
      [
        ["prompt", "Please inspect the failing test."],
        ["say", "I found the failing assertion."],
        ["prompt", ""],
        ["tools", "Ran 1 tool · 1 bash"],
      ]
    );
  });

  test("normalizes desktop-local status aliases for shared status filters", async () => {
    const source = createFakeSource({
      cursorRows: [
        cursor("error-session"),
        cursor("running-session"),
        cursor("awaiting-running-session"),
        cursor("awaiting-ended-session"),
        cursor("completed-session"),
      ],
      sessions: {
        "completed-session": session({
          id: "completed-session",
          status: "completed",
          awaitingInputSince: null,
        }),
        "error-session": session({
          id: "error-session",
          status: "error",
          awaitingInputSince: null,
        }),
        "awaiting-running-session": session({
          id: "awaiting-running-session",
          status: "running",
          awaitingInputSince: "2026-01-01T01:30:00.000Z",
          endedAt: null,
        }),
        // FEA-3149: a non-terminal, awaiting-input row whose `endedAt` is set
        // must NOT surface as Waiting (matches the cloud facet/projection).
        "awaiting-ended-session": session({
          id: "awaiting-ended-session",
          status: "running",
          awaitingInputSince: "2026-01-01T01:30:00.000Z",
          endedAt: "2026-01-01T02:00:00.000Z",
        }),
        "running-session": session({
          id: "running-session",
          status: "running",
          awaitingInputSince: null,
          endedAt: null,
        }),
      },
    });

    const failed = await getSharedAgentSessions(source, { status: "failed" });
    // The shared UI sends the canonical cloud value ("error"); the local
    // source must match it against canonical-shared "failed" rows.
    const error = await getSharedAgentSessions(source, { status: "error" });
    const active = await getSharedAgentSessions(source, { status: "active" });
    const waiting = await getSharedAgentSessions(source, { status: "waiting" });

    assert.deepEqual(
      failed.items.map((item) => [item.id, item.status]),
      [["error-session", "failed"]]
    );
    assert.deepEqual(
      error.items.map((item) => [item.id, item.status]),
      [["error-session", "failed"]]
    );
    assert.deepEqual(
      active.items.map((item) => [item.id, item.status]),
      [["running-session", "active"]]
    );
    assert.deepEqual(
      waiting.items.map((item) => [
        item.id,
        item.status,
        item.awaitingInputSince?.toISOString(),
      ]),
      [["awaiting-running-session", "active", "2026-01-01T01:30:00.000Z"]]
    );
  });

  test("free-text search filters by session name, repo, and branch", async () => {
    const source = createFakeSource({
      cursorRows: [
        cursor("payments-api"),
        cursor("billing-ui"),
        cursor("hotfix-session"),
      ],
      sessions: {
        "payments-api": session({
          id: "payments-api",
          repositoryFullName: "acme/payments",
        }),
        "billing-ui": session({
          id: "billing-ui",
          repositoryFullName: "acme/billing",
        }),
        "hotfix-session": session({
          id: "hotfix-session",
          repositoryFullName: "acme/web",
          attribution: {
            repositoryFullName: "acme/web",
            worktreePath: "repo",
            sourceArtifactId: null,
            sourceLoopId: null,
            baseBranch: "release/hotfix-2026",
          },
        }),
      },
    });

    const byRepo = await getSharedAgentSessions(source, { search: "payments" });
    assert.deepEqual(
      byRepo.items.map((item) => item.id),
      ["payments-api"]
    );

    const byBranch = await getSharedAgentSessions(source, {
      search: "hotfix-2026",
    });
    assert.deepEqual(
      byBranch.items.map((item) => item.id),
      ["hotfix-session"]
    );

    const byName = await getSharedAgentSessions(source, {
      search: "billing-ui",
    });
    assert.deepEqual(
      byName.items.map((item) => item.id),
      ["billing-ui"]
    );

    const noMatch = await getSharedAgentSessions(source, {
      search: "zzz-none",
    });
    assert.equal(noMatch.items.length, 0);
    assert.equal(noMatch.total, 0);
  });

  test("user filters apply to desktop list, usage, and analytics with null-owner rows excluded", async () => {
    const source = createFakeSource({
      cursorRows: [
        cursor("alex-1"),
        cursor("peter-1"),
        cursor("alex-2"),
        cursor("legacy-null-owner"),
      ],
      sessions: {
        "alex-1": session({ id: "alex-1", userId: "user-alex" }),
        "alex-2": session({
          id: "alex-2",
          userId: "user-alex",
          harness: "codex",
        }),
        "peter-1": session({ id: "peter-1", userId: "user-peter" }),
        "legacy-null-owner": session({ id: "legacy-null-owner" }),
      },
    });

    const list = await getSharedAgentSessions(source, {
      userId: "user-alex",
    });
    assert.equal(list.total, 2);
    assert.deepEqual(
      list.items.map((item) => item.id),
      ["alex-1", "alex-2"]
    );

    const usage = await getSharedAgentSessionUsage(source, {
      userId: "user-alex",
    });
    assert.equal(usage.totalSessions, 2);
    assert.deepEqual(
      usage.byHarness.map((row) => [row.harness, row.sessionCount]),
      [
        ["claude", 1],
        ["codex", 1],
      ]
    );

    const analytics = await getSharedAgentSessionAnalytics(source, {
      userId: "user-alex",
    });
    assert.deepEqual(
      analytics.byTool.map((row) => [row.toolName, row.sessionCount]),
      [["Bash", 2]]
    );

    const noOwnerMatch = await getSharedAgentSessions(source, {
      userId: "legacy-null-owner",
    });
    assert.equal(noOwnerMatch.total, 0);
  });

  test("userIds filters multiple desktop owners and take precedence over userId", async () => {
    const source = createFakeSource({
      cursorRows: [
        cursor("alex-1"),
        cursor("peter-1"),
        cursor("casey-1"),
        cursor("legacy-null-owner"),
      ],
      sessions: {
        "alex-1": session({ id: "alex-1", userId: "user-alex" }),
        "peter-1": session({ id: "peter-1", userId: "user-peter" }),
        "casey-1": session({ id: "casey-1", userId: "user-casey" }),
        "legacy-null-owner": session({ id: "legacy-null-owner" }),
      },
    });

    const list = await getSharedAgentSessions(source, {
      userId: "user-casey",
      userIds: ["user-alex", "user-peter"],
    });
    assert.equal(list.total, 2);
    assert.deepEqual(
      list.items.map((item) => item.id),
      ["alex-1", "peter-1"]
    );

    const usage = await getSharedAgentSessionUsage(source, {
      userId: "user-casey",
      userIds: ["user-alex", "user-peter"],
    });
    assert.equal(usage.totalSessions, 2);
  });

  test("user-filtered aggregate reads pass owner filters instead of returning unfiltered data", async () => {
    const source = createFakeSource({
      aggregateUsage: (filters) => ({
        totalSessions: filters.userIds?.length ?? (filters.userId ? 1 : 99),
        earliestSessionAt: null,
        latestSessionAt: null,
        tokenGroups: [],
        harnessSessionCounts: [
          {
            harness: "claude",
            sessionCount: filters.userIds?.length ?? (filters.userId ? 1 : 99),
          },
        ],
      }),
      aggregateAnalytics: (filters) => ({
        byTool: [
          {
            toolName: "Bash",
            invocationCount:
              filters.userIds?.length ?? (filters.userId ? 1 : 99),
            errorCount: 0,
            sessionCount: filters.userIds?.length ?? (filters.userId ? 1 : 99),
          },
        ],
        byAgentType: [],
        byRepository: [],
      }),
    });

    const usage = await getSharedAgentSessionUsage(source, {
      userId: "user-alex",
    });
    assert.equal(usage.totalSessions, 1);
    assert.deepEqual(source.calls[0]?.aggregateFilters, {
      userId: "user-alex",
    });

    const analytics = await getSharedAgentSessionAnalytics(source, {
      userIds: ["user-alex", "user-peter"],
    });
    assert.deepEqual(analytics.byTool, [
      {
        toolName: "Bash",
        invocationCount: 2,
        errorCount: 0,
        sessionCount: 2,
      },
    ]);
    assert.deepEqual(source.calls[1]?.aggregateFilters, {
      userIds: ["user-alex", "user-peter"],
    });
  });

  test("multi-status aggregate reads stay on SQL aggregate filters", async () => {
    const source = createFakeSource({
      aggregateUsage: (filters) => ({
        totalSessions: filters.statuses?.length ?? 99,
        earliestSessionAt: null,
        latestSessionAt: null,
        tokenGroups: [],
        harnessSessionCounts: [
          {
            harness: "claude",
            sessionCount: filters.statuses?.length ?? 99,
          },
        ],
      }),
      aggregateAnalytics: (filters) => ({
        byTool: [
          {
            toolName: "Bash",
            invocationCount: filters.statuses?.length ?? 99,
            errorCount: 0,
            sessionCount: filters.statuses?.length ?? 99,
          },
        ],
        byAgentType: [],
        byRepository: [],
      }),
    });

    const usage = await getSharedAgentSessionUsage(source, {
      statuses: ["completed", "failed"],
    });
    assert.equal(usage.totalSessions, 2);
    assert.deepEqual(source.calls[0]?.aggregateFilters, {
      statuses: ["completed", "failed"],
    });

    const analytics = await getSharedAgentSessionAnalytics(source, {
      statuses: ["completed", "failed"],
    });
    assert.deepEqual(analytics.byTool, [
      {
        toolName: "Bash",
        invocationCount: 2,
        errorCount: 0,
        sessionCount: 2,
      },
    ]);
    assert.deepEqual(source.calls[1]?.aggregateFilters, {
      statuses: ["completed", "failed"],
    });
  });

  test("repository-filtered list, usage, and analytics share the hydrated matcher", async () => {
    const source = createFakeSource({
      sessions: {
        "completed-a": session({
          id: "completed-a",
          status: "completed",
          repositoryFullName: "closedloop-ai/symphony-alpha",
        }),
        "running-b": session({
          id: "running-b",
          status: "running",
          repositoryFullName: "closedloop-ai/symphony-alpha",
        }),
        "other-repo": session({
          id: "other-repo",
          status: "completed",
          repositoryFullName: "closedloop-ai/other",
        }),
      },
      aggregateUsage: () => {
        throw new Error("aggregateUsage should be bypassed");
      },
      aggregateAnalytics: () => {
        throw new Error("aggregateAnalytics should not be called");
      },
    });

    const request = {
      repositories: ["closedloop-ai/symphony-alpha"],
    };
    const list = await getSharedAgentSessions(source, request);
    assert.equal(list.total, 2);
    assert.deepEqual(
      list.items.map((item) => item.id),
      ["completed-a", "running-b"]
    );

    const usage = await getSharedAgentSessionUsage(source, {
      repositories: ["closedloop-ai/symphony-alpha"],
    });
    assert.equal(usage.totalSessions, list.total);

    const analytics = await getSharedAgentSessionAnalytics(source, {
      repositories: ["closedloop-ai/symphony-alpha"],
    });
    assert.deepEqual(
      analytics.byRepository.map((entry) => [
        entry.repositoryFullName,
        entry.sessionCount,
      ]),
      [["closedloop-ai/symphony-alpha", 2]]
    );
    assert.deepEqual(
      source.calls.map((call) => call.kind),
      [
        "listAllSessionCursorRows",
        "loadSyncedSessions",
        "listAllSessionCursorRows",
        "loadSyncedSessions",
        "listAllSessionCursorRows",
        "loadSyncedSessions",
      ]
    );
  });

  test("filters the local list by harness, model, autonomy tier, and cost bucket", async () => {
    const withFacets = (
      base: SyncedAgentSession,
      overrides: {
        harness: string;
        model: string;
        autonomy: number | null;
        cost: number;
      }
    ): SyncedAgentSession => ({
      ...base,
      harness: overrides.harness,
      model: overrides.model,
      autonomy: overrides.autonomy,
      tokenUsageByModel: [
        {
          model: overrides.model,
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          estimatedCostUsd: overrides.cost,
        },
      ],
    });
    // `mid` also used a secondary model via a subagent: its primary column is
    // "model-b" but it has a token-usage row for "model-secondary". The Model
    // facet lists both, so filtering by the secondary model must still match it.
    const midWithSecondaryModel = withFacets(session({ id: "mid" }), {
      harness: "codex",
      model: "model-b",
      autonomy: 60,
      cost: 5,
    });
    midWithSecondaryModel.tokenUsageByModel = [
      ...midWithSecondaryModel.tokenUsageByModel,
      {
        model: "model-secondary",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0,
      },
    ];
    const source = createFakeSource({
      sessions: {
        cheap: withFacets(session({ id: "cheap" }), {
          harness: "claude",
          model: "model-a",
          autonomy: 90,
          cost: 0.25,
        }),
        mid: midWithSecondaryModel,
        expensive: withFacets(session({ id: "expensive" }), {
          harness: "claude",
          model: "model-a",
          autonomy: null,
          cost: 75,
        }),
      },
    });

    const ids = async (request: Record<string, unknown>): Promise<string[]> => {
      const list = await getSharedAgentSessions(source, request);
      return list.items.map((item) => item.id).sort();
    };

    assert.deepEqual(await ids({ harnesses: ["codex"] }), ["mid"]);
    assert.deepEqual(await ids({ models: ["model-a"] }), [
      "cheap",
      "expensive",
    ]);
    // Filtering by a model that only appears as a secondary token-usage model
    // still matches the session (mirrors the byModel facet option source).
    assert.deepEqual(await ids({ models: ["model-secondary"] }), ["mid"]);
    assert.deepEqual(await ids({ autonomyTiers: ["high"] }), ["cheap"]);
    assert.deepEqual(await ids({ autonomyTiers: ["unknown"] }), ["expensive"]);
    assert.deepEqual(await ids({ costBuckets: ["from_50"] }), ["expensive"]);
    assert.deepEqual(await ids({ costBuckets: ["under_1", "from_50"] }), [
      "cheap",
      "expensive",
    ]);
    // Multiple dimensions combine with AND semantics.
    assert.deepEqual(
      await ids({ harnesses: ["claude"], costBuckets: ["from_50"] }),
      ["expensive"]
    );
  });

  test("filters by change presence and pull-request association", async () => {
    const source = createFakeSource({
      sessions: {
        "changes-and-pr": {
          ...session({ id: "changes-and-pr" }),
          linesAdded: 12,
          filesChanged: 2,
          prs: [{ num: 1, title: "PR", status: "open" }],
        },
        "changes-no-pr": {
          ...session({ id: "changes-no-pr" }),
          linesAdded: 5,
          filesChanged: 1,
          prs: [],
        },
        "empty-session": {
          ...session({ id: "empty-session" }),
          linesAdded: 0,
          linesRemoved: 0,
          filesChanged: 0,
          prs: [],
        },
        // Changes recorded only via gitDiffStats (top-level LOC fields absent) —
        // the assembler populates this shape for local sessions.
        "gitstats-changes": {
          ...session({ id: "gitstats-changes" }),
          gitDiffStats: {
            linesAdded: 4,
            linesRemoved: 1,
            filesChanged: 1,
            source: "git",
          },
          prs: [],
        },
        // PR recorded only via prRefs (artifact-link) with no trace `prs`: the
        // row projection folds prRefs into the rendered PRs, so this classifies
        // as "Has PR" and the filter agrees with the rendered PR column.
        "prref-only": {
          ...session({ id: "prref-only" }),
          linesAdded: 0,
          filesChanged: 0,
          prRefs: [
            {
              repositoryFullName: "closedloop-ai/symphony-alpha",
              prNumber: 9,
              relationType: SessionPrRelationType.Referenced,
            },
          ],
        },
      },
    });

    const ids = async (request: Record<string, unknown>): Promise<string[]> => {
      const list = await getSharedAgentSessions(source, request);
      return list.items.map((item) => item.id).sort();
    };

    assert.deepEqual(await ids({ changePresence: ["has_changes"] }), [
      "changes-and-pr",
      "changes-no-pr",
      "gitstats-changes",
    ]);
    assert.deepEqual(await ids({ changePresence: ["no_changes"] }), [
      "empty-session",
      "prref-only",
    ]);
    // prref-only carries an artifact-link PR that is now folded into the row, so
    // it matches "Has PR" and is excluded from "No PR".
    assert.deepEqual(await ids({ prAssociation: ["has_pr"] }), [
      "changes-and-pr",
      "prref-only",
    ]);
    assert.deepEqual(await ids({ prAssociation: ["no_pr"] }), [
      "changes-no-pr",
      "empty-session",
      "gitstats-changes",
    ]);
    // Composes with AND semantics across dimensions.
    assert.deepEqual(
      await ids({ changePresence: ["has_changes"], prAssociation: ["no_pr"] }),
      ["changes-no-pr", "gitstats-changes"]
    );

    // The "Has PR" filter and the rendered PR column must agree: a session whose
    // only PR is an artifact-link `prRef` (no trace `prs`) still surfaces that PR
    // in its rendered `prs`, so the row isn't shown with an empty PR column.
    const withPrRef = await getSharedAgentSessions(source, {
      prAssociation: ["has_pr"],
    });
    const prRefOnly = withPrRef.items.find((item) => item.id === "prref-only");
    assert.equal(prRefOnly?.prs?.length, 1);
    assert.equal(prRefOnly?.prs?.[0]?.num, 9);
  });

  test("projects local active fallback state by terminal and awaiting precedence", async () => {
    const source = createFakeSource({
      cursorRows: [
        cursor("ended-running-session"),
        cursor("active-running-session"),
        cursor("awaiting-running-session"),
      ],
      sessions: {
        "ended-running-session": session({
          id: "ended-running-session",
          status: "running",
          awaitingInputSince: "2026-01-01T01:30:00.000Z",
          endedAt: "2026-01-01T02:00:00.000Z",
        }),
        "active-running-session": session({
          id: "active-running-session",
          status: "running",
          awaitingInputSince: null,
          endedAt: null,
        }),
        "awaiting-running-session": session({
          id: "awaiting-running-session",
          status: "running",
          awaitingInputSince: "2026-01-01T01:30:00.000Z",
          endedAt: null,
        }),
      },
    });

    const list = await getSharedAgentSessions(source);
    assert.deepEqual(
      list.items.map((item) => [item.id, item.state]),
      [
        ["ended-running-session", AgentSessionState.Completed],
        ["active-running-session", AgentSessionState.Running],
        ["awaiting-running-session", AgentSessionState.PendingApproval],
      ]
    );

    const detail = await getSharedAgentSessionDetail(
      source,
      "ended-running-session"
    );
    assert.equal(detail?.state, AgentSessionState.Completed);
  });

  test("unsupported cloud filters and disabled or stale states fail closed", async () => {
    const source = createFakeSource({
      cursorRows: [cursor("stale"), cursor("session-a")],
      loadOrder: ["session-a"],
    });

    const unsupported = await getSharedAgentSessions(source, {
      teamId: "cloud-team",
      userId: "user-alex",
    });
    assert.deepEqual(unsupported, {
      items: [],
      total: 0,
      viewerScope: "self",
    });
    assert.equal(source.calls.length, 0);

    assert.equal(
      (
        await getSharedAgentSessionUsage(source, {
          teamId: "cloud-team",
          userId: "user-alex",
        })
      ).totalSessions,
      0
    );
    assert.deepEqual(
      await getSharedAgentSessionAnalytics(source, {
        projectId: "cloud-project",
        userId: "user-alex",
      }),
      {
        viewerScope: "self",
        byTool: [],
        byAgentType: [],
        byRepository: [],
        byProject: [],
      }
    );
    assert.equal(source.calls.length, 0);

    const staleDetail = await getSharedAgentSessionDetail(source, "stale");
    assert.equal(staleDetail, null);
    assert.deepEqual(await getSharedAgentSessions(null), {
      items: [],
      total: 0,
      viewerScope: "self",
    });
    assert.equal((await getSharedAgentSessionUsage(null)).totalSessions, 0);
    assert.deepEqual(
      (await getSharedAgentSessionAnalytics(null)).byProject,
      []
    );
  });

  test("usage and analytics aggregate local cost ledgers and breakdowns", async () => {
    const source = createFakeSource({
      cursorRows: [
        cursor("session-a"),
        cursor("session-b"),
        cursor("session-c"),
      ],
    });

    const usage = await getSharedAgentSessionUsage(source);
    assert.equal(usage.viewerScope, "self");
    assert.equal(usage.totalSessions, 3);
    assert.equal(usage.totalInputTokens, 30);
    assert.equal(usage.totalOutputTokens, 60);
    assert.equal(usage.subscriptionEstimatedCost, 0.5);
    assert.equal(usage.apiEstimatedCost, 0.5);
    assert.equal(usage.totalEstimatedCost, 0.5);
    assert.deepEqual(usage.byUser, []);
    assert.deepEqual(usage.lastSyncTargets, []);
    assert.deepEqual(
      usage.byHarness.map((entry) => [entry.harness, entry.sessionCount]),
      [
        ["claude", 1],
        ["codex", 1],
        ["opencode", 1],
      ]
    );

    const analytics = await getSharedAgentSessionAnalytics(source);
    assert.equal(analytics.viewerScope, "self");
    assert.deepEqual(analytics.byProject, []);
    assert.deepEqual(
      analytics.byTool.map((entry) => [
        entry.toolName,
        entry.invocationCount,
        entry.errorCount,
        entry.sessionCount,
      ]),
      [["Bash", 3, 0, 3]]
    );
    assert.deepEqual(
      analytics.byAgentType.map((entry) => [
        entry.agentType,
        entry.count,
        entry.successCount,
        entry.failedCount,
      ]),
      [
        ["main", 3, 3, 0],
        ["reviewer", 3, 0, 3],
      ]
    );
    assert.deepEqual(
      analytics.byRepository.map((entry) => [
        entry.repositoryFullName,
        entry.sessionCount,
        entry.errorCount,
      ]),
      [
        ["closedloop-ai/symphony-alpha", 1, 1],
        ["worktree-b", 1, 1],
        ["/tmp/session-c", 1, 1],
      ]
    );
  });

  test("usage via loadUsageSessions matches the full-hydrate path across filters (FEA-1834)", async () => {
    const sessions = defaultSessions();
    // Simulate the sqlite `usageOnly` load: same sessions, but agents/events/
    // attribution stripped. If the summary still matches the full-hydrate path,
    // those fields provably do not affect the usage numbers.
    const makeUsageSource = () => ({
      ...createFakeSource({ sessions }),
      loadUsageSessions(ids: string[]): SyncedAgentSession[] {
        return ids.flatMap((id) => {
          const loaded = sessions[id];
          return loaded
            ? [{ ...loaded, agents: [], events: [], attribution: undefined }]
            : [];
        });
      },
    });

    const filters = [
      {},
      { harness: "claude" },
      { harness: "nonexistent" },
      { status: "completed" },
      { status: "active" },
      { startDate: "2026-01-01T00:00:00.000Z" },
      { endDate: "2025-12-31T00:00:00.000Z" },
    ];

    for (const filter of filters) {
      const full = await getSharedAgentSessionUsage(
        createFakeSource({ sessions }),
        filter
      );
      const lightweight = await getSharedAgentSessionUsage(
        makeUsageSource(),
        filter
      );
      assert.deepEqual(
        lightweight,
        full,
        `usage mismatch for filter ${JSON.stringify(filter)}`
      );
    }
  });

  test("autonomy-faceted usage falls back to full-hydrate; cost stays on the fast path (FEA-2504)", async () => {
    // The real lightweight `loadUsageSessions` load omits the events/analytics
    // that `session.autonomy` is derived from, so its rows carry a null autonomy.
    // Model this by stripping autonomy (but keeping tokenUsageByModel, which the
    // lightweight rows DO carry). With an autonomy facet active the summary must
    // fall back to the full-hydrate path so the metric cards filter like the list;
    // a cost facet, derived from the carried tokenUsageByModel, may stay fast.
    const sessions = {
      autonomous: {
        ...session({ id: "autonomous" }),
        autonomy: 90,
        tokenUsageByModel: [
          {
            model: "model-a",
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            estimatedCostUsd: 0.25,
          },
        ],
      },
      expensive: {
        ...session({ id: "expensive" }),
        autonomy: 10,
        tokenUsageByModel: [
          {
            model: "model-a",
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            estimatedCostUsd: 75,
          },
        ],
      },
    };
    const lightweightMisclassifiesAutonomy = () => ({
      ...createFakeSource({ sessions }),
      loadUsageSessions(ids: string[]): SyncedAgentSession[] {
        // autonomy stripped exactly as the sqlite usage-only load does.
        return ids.flatMap((id) => {
          const loaded = sessions[id as keyof typeof sessions];
          return loaded
            ? [{ ...loaded, autonomy: null, agents: [], events: [] }]
            : [];
        });
      },
    });

    // Autonomy facet: the fast path would classify both rows as "unknown" and
    // yield different totals, so the gate must route to the full-hydrate path.
    const fullAutonomy = await getSharedAgentSessionUsage(
      createFakeSource({ sessions }),
      { autonomyTiers: ["high"] }
    );
    const gatedAutonomy = await getSharedAgentSessionUsage(
      lightweightMisclassifiesAutonomy(),
      { autonomyTiers: ["high"] }
    );
    assert.deepEqual(gatedAutonomy, fullAutonomy);
    assert.equal(
      gatedAutonomy.totalSessions,
      1,
      "only the high-autonomy session"
    );

    // Cost facet: derived from the carried tokenUsageByModel, so the fast path is
    // correct and must still match the full-hydrate reference.
    const fullCost = await getSharedAgentSessionUsage(
      createFakeSource({ sessions }),
      { costBuckets: ["from_50"] }
    );
    const fastCost = await getSharedAgentSessionUsage(
      lightweightMisclassifiesAutonomy(),
      { costBuckets: ["from_50"] }
    );
    assert.deepEqual(fastCost, fullCost);
    assert.equal(fastCost.totalSessions, 1, "only the expensive session");
  });

  test("usage fast path rebuilds from ordered ids, dropping out-of-order and extra rows (FEA-1834)", async () => {
    const sessions = defaultSessions();
    // A row the cursor set never returned. Trusting `loadUsageSessions`' return
    // value directly would fold this into the totals; rebuilding from
    // `orderedIds` drops it. Reversing the in-set rows proves order
    // independence — both must match the full-hydrate reference exactly.
    const extra = session({
      id: "session-extra",
      harness: "claude",
      billingMode: "api",
      status: "completed",
    });
    const outOfOrderExtraSource = () => ({
      ...createFakeSource({ sessions }),
      loadUsageSessions(ids: string[]): SyncedAgentSession[] {
        const inSet = ids.flatMap((id) => {
          const loaded = sessions[id];
          return loaded
            ? [{ ...loaded, agents: [], events: [], attribution: undefined }]
            : [];
        });
        return [extra, ...inSet.reverse()];
      },
    });

    const full = await getSharedAgentSessionUsage(
      createFakeSource({ sessions }),
      {}
    );
    const lightweight = await getSharedAgentSessionUsage(
      outOfOrderExtraSource(),
      {}
    );
    assert.deepEqual(lightweight, full);
  });

  test("usage summary and list total aggregate over the SAME uncapped session set on a >5000 corpus (FEA-3207)", async () => {
    // Reproduce the no-filter divergence: a corpus strictly larger than the A5b
    // working-set ceiling. Before the fix the list total took the uncapped
    // cursor-paging branch (`resolveOrderedIds(..., { cap: false })`) and
    // reported the true corpus size, while the usage-summary fast path
    // (`loadUsageSessions`) resolved ids with the default `{ cap: true }` and
    // silently aggregated only the MOST-RECENT MAX_WORKING_SET_SESSIONS — so the
    // metric cards under-counted against the list header with NO filter to
    // explain it. Both paths must now aggregate over the identical uncapped set.
    const corpusSize = MAX_WORKING_SET_SESSIONS + 137;
    const cursorRows: SessionCursorRow[] = [];
    const sessions: Record<string, SyncedAgentSession> = {};
    for (let i = 0; i < corpusSize; i++) {
      const id = `bulk-${String(i).padStart(5, "0")}`;
      cursorRows.push(cursor(id));
      sessions[id] = session({ id });
    }

    // Capture exactly which ids the usage fast path hands to `loadUsageSessions`,
    // so we can assert its aggregation basis is the full corpus, not a 5000-cap.
    let usageLoadIds: string[] = [];
    const source: AgentSessionSyncSource & { calls: SourceCall[] } = {
      ...createFakeSource({ cursorRows, sessions }),
      loadUsageSessions(ids: string[]): SyncedAgentSession[] {
        usageLoadIds = [...ids];
        return ids.flatMap((id) => {
          const loaded = sessions[id];
          return loaded ? [loaded] : [];
        });
      },
    };

    // No filters: the list takes the uncapped cursor-paging branch and reports
    // the true total; the usage summary takes the pushable `loadUsageSessions`
    // fast path.
    const list = await getSharedAgentSessions(source, {});
    const usage = await getSharedAgentSessionUsage(source, {});

    // Sanity: the corpus genuinely exceeds the cap, so a capped usage path would
    // visibly diverge from the list total.
    assert.ok(
      corpusSize > MAX_WORKING_SET_SESSIONS,
      "corpus must exceed the working-set ceiling to exercise the divergence"
    );
    assert.equal(list.total, corpusSize, "list total reports the full corpus");
    assert.equal(
      usage.totalSessions,
      corpusSize,
      "usage summary aggregates over the full corpus, not the 5000 cap"
    );
    assert.equal(
      usage.totalSessions,
      list.total,
      "usage-summary basis and list total cover the SAME session set"
    );
    // The fast path resolved ids uncapped: it received every session, not the
    // MAX_WORKING_SET_SESSIONS most-recent slice.
    assert.equal(
      usageLoadIds.length,
      corpusSize,
      "loadUsageSessions received the uncapped id set"
    );
    assert.ok(
      usageLoadIds.length > MAX_WORKING_SET_SESSIONS,
      "the usage fast path is no longer capped at MAX_WORKING_SET_SESSIONS"
    );
  });

  test("source failures reject instead of returning empty success", async () => {
    await assert.rejects(
      getSharedAgentSessions(
        createFakeSource({ rejectListAll: new Error("cursor failed") })
      ),
      CURSOR_FAILED_PATTERN
    );

    await assert.rejects(
      getSharedAgentSessions(
        createFakeSource({ rejectLoad: new Error("load failed") })
      ),
      LOAD_FAILED_PATTERN
    );
  });

  test("loadSessionTokenEvents result is threaded into turnItems costDelta", async () => {
    const tokenEventTs = new Date("2026-01-01T00:10:00.000Z").getTime();

    const source: AgentSessionSyncSource = {
      ...createFakeSource({
        sessions: { "session-a": session({ id: "session-a" }) },
      }),
      loadSessionTokenEvents(
        _sessionId: string
      ): { tMs: number; costUsd: number }[] {
        return [{ tMs: tokenEventTs, costUsd: 0.05 }];
      },
    };

    const detail = await getSharedAgentSessionDetail(source, "session-a");

    assert.ok(detail !== null, "expected detail to be non-null");
    assert.ok(
      detail.turnItems && detail.turnItems.length > 0,
      "expected at least one turn item"
    );

    // The Bash tools turn at toolEventTs is the last cost-bearing item before tokenEventTs,
    // so attributeTokenEventCosts assigns the full costUsd to it.
    const toolsTurn = detail.turnItems.find((item) => item.type === "tools");
    assert.ok(toolsTurn, "expected a tools turn item");
    assert.equal(
      (toolsTurn as { costDelta?: number }).costDelta,
      0.05,
      "tools turn should carry the token event cost"
    );
    assert.equal(
      (toolsTurn as { cum?: number }).cum,
      0.05,
      "tools turn cumulative should equal the attributed cost"
    );
    // Subagent is cost-bearing and precedes the token event, but attributeTokenEventCosts
    // assigns to the *last* eligible item — so the subagent gets delta 0.
    const subagentTurn = detail.turnItems.find(
      (item) => item.type === "subagent"
    );
    assert.ok(subagentTurn, "expected a subagent turn item");
    assert.equal(
      (subagentTurn as { costDelta?: number }).costDelta,
      0,
      "preceding subagent turn should have costDelta 0"
    );
  });

  test("getSharedAgentSessionDetail works normally when loadSessionTokenEvents is absent", async () => {
    const source = createFakeSource({
      sessions: { "session-a": session({ id: "session-a" }) },
    });
    // Confirm the method is absent so the test stays honest about what it covers.
    assert.equal(
      "loadSessionTokenEvents" in source,
      false,
      "createFakeSource should not provide loadSessionTokenEvents"
    );

    const detail = await getSharedAgentSessionDetail(source, "session-a");

    assert.ok(detail !== null, "expected detail to be non-null");
    assert.ok(
      detail.turnItems && detail.turnItems.length > 0,
      "expected at least one turn item"
    );
    // attributeTokenEventCosts returns early when tokenEvents is undefined, so
    // costDelta is never written — it remains absent on every item.
    for (const item of detail.turnItems) {
      assert.equal(
        (item as { costDelta?: number }).costDelta,
        undefined,
        `turn item type=${item.type} should have no costDelta without token events`
      );
    }
  });

  test("getSharedAgentSessionsByIds projects specific ids into list items, preserving order and dropping unknown ids", async () => {
    const source = createFakeSource();

    // Request in a deliberately different order than defaultSessions() insertion,
    // plus one id that resolves to no local session.
    const items = await getSharedAgentSessionsByIds(source, [
      "session-b",
      "does-not-exist",
      "session-a",
    ]);

    // Unknown id dropped; order follows the caller's id order.
    assert.deepEqual(
      items.map((i) => i.id),
      ["session-b", "session-a"]
    );
    // loadSyncedSessions was called with exactly the requested ids (the reader
    // fans the component's usage session ids straight through).
    const loadCall = source.calls.find((c) => c.kind === "loadSyncedSessions");
    assert.ok(loadCall, "expected a loadSyncedSessions call");
    assert.deepEqual(loadCall.ids, [
      "session-b",
      "does-not-exist",
      "session-a",
    ]);
  });

  test("getSharedAgentSessionsByIds returns [] for a null source or empty ids", async () => {
    assert.deepEqual(
      await getSharedAgentSessionsByIds(null, ["session-a"]),
      []
    );
    assert.deepEqual(
      await getSharedAgentSessionsByIds(createFakeSource(), []),
      []
    );
  });

  // FEA-3142 (FEA-3132 P0 / A5b): a search or facet filter that can't be pushed
  // into SQL drops onto the non-paginated full-corpus fallback
  // (loadWorkingSessions(applyPagination:false) → loadSyncedSessions over
  // resolveOrderedIds). That path must hydrate at MOST MAX_WORKING_SET_SESSIONS
  // ids, not the whole corpus — otherwise a searched read over a huge corpus is
  // the read-side allocator that co-peaks with backfill. A free-text search
  // forces this fallback (it skips the aggregate + lightweight usage paths), so
  // a corpus larger than the ceiling must still hydrate no more than the ceiling.
  test("search/facet fallback hydrates at most MAX_WORKING_SET_SESSIONS ids over a larger corpus", async () => {
    const overCap = MAX_WORKING_SET_SESSIONS + 25;
    const sessions: Record<string, SyncedAgentSession> = {};
    const cursorRows: SessionCursorRow[] = [];
    for (let index = 0; index < overCap; index++) {
      // Zero-pad so the id substring "match" needle hits every session and the
      // fallback's matchesQuery keeps them all (worst case for hydration).
      const id = `match-${String(index).padStart(6, "0")}`;
      sessions[id] = session({ id, cwd: `/tmp/match/${id}` });
      cursorRows.push(cursor(id));
    }
    const source = createFakeSource({ cursorRows, sessions });

    // Free-text search flips canUseAggregateSessionFilters false and, absent a
    // cursor-page-eligible sort, lands on the full-corpus hydration fallback.
    const summary = await getSharedAgentSessionUsage(source, {
      search: "match",
    });

    const loadCalls = source.calls.filter(
      (call) => call.kind === "loadSyncedSessions"
    );
    assert.equal(loadCalls.length, 1, "expected a single hydration call");
    const hydratedIds = loadCalls[0]?.ids ?? [];
    assert.ok(
      hydratedIds.length <= MAX_WORKING_SET_SESSIONS,
      `fallback hydrated ${hydratedIds.length} ids, expected <= ${MAX_WORKING_SET_SESSIONS}`
    );
    assert.equal(
      hydratedIds.length,
      MAX_WORKING_SET_SESSIONS,
      "the ceiling should be filled exactly when the corpus exceeds it"
    );
    // The bounded read still produces a real summary (it is not empty), proving
    // the cap trims the tail rather than dropping the whole working set.
    assert.equal(summary.totalSessions, MAX_WORKING_SET_SESSIONS);
    assert.equal(summary.viewerScope, "self");
  });
});

function turnItemPreviewText(item: TurnItem): string | null | undefined {
  if ("text" in item) {
    return item.text;
  }
  if ("summary" in item) {
    return item.summary;
  }
  return null;
}

type SourceCall = {
  kind:
    | "listAllSessionCursorRows"
    | "listSessionCursorPage"
    | "loadSyncedSessions"
    | "aggregateUsage"
    | "aggregateAnalytics";
  ids?: string[];
  cache?: SessionAttributionResolverCache;
  cursorPageRequest?: SessionListCursorPageRequest;
  aggregateFilters?: unknown;
};

function createFakeSource(
  options: {
    cursorRows?: SessionCursorRow[];
    sessions?: Record<string, SyncedAgentSession>;
    loadOrder?: string[];
    rejectListAll?: Error;
    rejectLoad?: Error;
    aggregateUsage?: AgentSessionSyncSource["aggregateUsage"];
    aggregateAnalytics?: AgentSessionSyncSource["aggregateAnalytics"];
  } = {}
): AgentSessionSyncSource & { calls: SourceCall[] } {
  const sessions = options.sessions ?? defaultSessions();
  const calls: SourceCall[] = [];

  return {
    calls,
    listAllSessionCursorRows() {
      if (options.rejectListAll) {
        throw options.rejectListAll;
      }
      calls.push({ kind: "listAllSessionCursorRows" });
      return (
        options.cursorRows ?? Object.keys(sessions).map((id) => cursor(id))
      );
    },
    listSessionCursorPage(request) {
      calls.push({
        kind: "listSessionCursorPage",
        cursorPageRequest: { ...request },
      });
      const rows =
        options.cursorRows ?? Object.keys(sessions).map((id) => cursor(id));
      const filteredRows = filterCursorRowsForPageRequest(
        rows,
        sessions,
        request
      );
      return {
        rows: filteredRows.slice(
          request.offset,
          request.offset + request.limit
        ),
        total: filteredRows.length,
      };
    },
    listUpdatedSessionCursorRows() {
      return [];
    },
    loadSyncedSessions(ids, cache) {
      if (options.rejectLoad) {
        throw options.rejectLoad;
      }
      calls.push({ kind: "loadSyncedSessions", ids: [...ids], cache });
      const loadIds = options.loadOrder ?? ids;
      return loadIds.flatMap((id) => {
        const loaded = sessions[id];
        return loaded ? [loaded] : [];
      });
    },
    aggregateUsage: options.aggregateUsage
      ? (filters) => {
          calls.push({ kind: "aggregateUsage", aggregateFilters: filters });
          return (
            options.aggregateUsage?.(filters) ?? {
              totalSessions: 0,
              earliestSessionAt: null,
              latestSessionAt: null,
              tokenGroups: [],
              harnessSessionCounts: [],
            }
          );
        }
      : undefined,
    aggregateAnalytics: options.aggregateAnalytics
      ? (filters, cache) => {
          calls.push({ kind: "aggregateAnalytics", aggregateFilters: filters });
          return (
            options.aggregateAnalytics?.(filters, cache) ?? {
              byTool: [],
              byAgentType: [],
              byRepository: [],
            }
          );
        }
      : undefined,
  };
}

function filterCursorRowsForPageRequest(
  rows: SessionCursorRow[],
  sessions: Record<string, SyncedAgentSession>,
  request: SessionListCursorPageRequest
): SessionCursorRow[] {
  return rows.filter((row) => {
    const loaded = sessions[row.id];
    if (!loaded) {
      return !(request.startDate || request.endDate || request.search);
    }
    const activityAt = sessionDateMs(row.updated_at);
    if (request.startDate && activityAt < request.startDate.getTime()) {
      return false;
    }
    if (request.endDate && activityAt > request.endDate.getTime()) {
      return false;
    }
    if (request.search && !fakeMatchesCursorSearch(loaded, request.search)) {
      return false;
    }
    return true;
  });
}

function fakeMatchesCursorSearch(
  session: SyncedAgentSession,
  search: string
): boolean {
  const needle = search.toLowerCase();
  return [
    session.name,
    session.externalSessionId,
    session.harness,
    session.cwd,
    session.branch,
    session.attribution?.repositoryFullName,
    session.attribution?.baseBranch,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

function sessionDateMs(value: string): number {
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function defaultSessions(): Record<string, SyncedAgentSession> {
  return {
    "session-a": session({
      id: "session-a",
      harness: "claude",
      billingMode: "api",
      repositoryFullName: "closedloop-ai/symphony-alpha",
      status: "completed",
    }),
    "session-b": session({
      id: "session-b",
      harness: "codex",
      billingMode: "subscription_unknown",
      worktreePath: "worktree-b",
      status: "running",
    }),
    "session-c": session({
      id: "session-c",
      harness: "opencode",
      billingMode: "unknown",
      cwd: "/tmp/session-c",
      status: "completed",
    }),
  };
}

function session(options: {
  id: string;
  status?: string;
  harness?: string;
  billingMode?: BillingMode;
  repositoryFullName?: string | null;
  worktreePath?: string | null;
  cwd?: string | null;
  startedAt?: string;
  updatedAt?: string;
  awaitingInputSince?: string | null;
  endedAt?: string | null;
  branch?: string | null;
  attribution?: SyncedAgentSession["attribution"];
  metadata?: SyncedAgentSession["metadata"];
  events?: SyncedAgentSession["events"];
  userId?: string | null;
}): SyncedAgentSession {
  const inputTokens = options.id === "session-a" ? 10 : 10;
  const outputTokens = options.id === "session-a" ? 20 : 20;
  const estimatedCostUsd =
    options.billingMode === "subscription_unknown" ? 0.5 : 0.25;

  return {
    externalSessionId: options.id,
    name: `Session ${options.id}`,
    status: options.status ?? "completed",
    harness: options.harness ?? "claude",
    billingMode: options.billingMode ?? "api",
    cwd: options.cwd ?? `/tmp/${options.id}`,
    ...(options.branch ? { branch: options.branch } : {}),
    model: "gpt-test",
    startedAt: options.startedAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: options.updatedAt ?? "2026-01-01T01:00:00.000Z",
    endedAt:
      "endedAt" in options ? options.endedAt : "2026-01-01T02:00:00.000Z",
    awaitingInputSince:
      "awaitingInputSince" in options
        ? options.awaitingInputSince
        : "2026-01-01T01:30:00.000Z",
    metadata: options.metadata ?? { kind: "fixture" },
    ...(options.userId ? { userId: options.userId } : {}),
    attribution: options.attribution ?? {
      repositoryFullName: options.repositoryFullName ?? null,
      worktreePath: options.worktreePath ?? null,
      sourceArtifactId: null,
      sourceLoopId: null,
      baseBranch: null,
    },
    agents: [
      {
        externalAgentId: `${options.id}-main`,
        name: "Main",
        type: "main",
        status: "completed",
        task: "private task",
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T01:00:00.000Z",
        endedAt: "2026-01-01T02:00:00.000Z",
      },
      {
        externalAgentId: `${options.id}-reviewer`,
        name: "Reviewer",
        type: "subagent",
        subagentType: "reviewer",
        status: "failed",
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T01:00:00.000Z",
        endedAt: "2026-01-01T01:30:00.000Z",
      },
    ],
    events: options.events ?? [
      {
        externalEventId: `${options.id}-tool`,
        eventType: "tool_use",
        toolName: "Bash",
        summary: null,
        data: {
          filePath: "src/visible.ts",
          command: "cat secret.txt",
          stdout: "secret",
          stderr: "secret",
          nested: { visible: "yes", content: "secret" },
        },
        createdAt: "2026-01-01T00:05:00.000Z",
      },
      {
        externalEventId: `${options.id}-error`,
        agentExternalId: `${options.id}-reviewer`,
        eventType: "agent_error",
        createdAt: "2026-01-01T00:06:00.000Z",
      },
    ],
    tokenUsageByModel: [
      {
        model: "gpt-test",
        inputTokens,
        outputTokens,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        estimatedCostUsd,
      },
    ],
  };
}

function cursor(id: string, updatedAt = "2026-01-01T00:00:00.000Z") {
  return { id, updated_at: updatedAt };
}
