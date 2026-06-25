import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  AgentSessionState,
  type TurnItem,
} from "@repo/api/src/types/agent-session";
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
  getSharedAgentSessionUsage,
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
        cursor("old-match", "2026-06-17T00:00:00.000Z"),
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
    assert.deepEqual(source.calls[1]?.ids, ["recent-match"]);
    assert.equal(response.total, 1);
    assert.deepEqual(
      response.items.map((item) => item.id),
      ["recent-match"]
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
            issueId: "123",
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
      assert.equal(subagentTurn.tokens, "37");
      assert.equal(subagentTurn.cost, "$0.25");
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
          issueId: "1943",
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
      issues: ["FEA-1943"],
      prs: [
        { num: 42, status: "merged", title: "Complete local details" },
        { num: 43, status: "open", title: "Follow-up trace polish" },
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
    assert.deepEqual(detail?.issues, ["FEA-1943"]);
    assert.equal(detail?.issueId, "1943");
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
        }),
        "running-session": session({
          id: "running-session",
          status: "running",
          awaitingInputSince: null,
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
            issueId: null,
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
      userId: "cloud-user",
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
        })
      ).totalSessions,
      0
    );
    assert.deepEqual(
      await getSharedAgentSessionAnalytics(source, {
        projectId: "cloud-project",
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
    | "loadSyncedSessions";
  ids?: string[];
  cache?: SessionAttributionResolverCache;
  cursorPageRequest?: SessionListCursorPageRequest;
};

function createFakeSource(
  options: {
    cursorRows?: SessionCursorRow[];
    sessions?: Record<string, SyncedAgentSession>;
    loadOrder?: string[];
    rejectListAll?: Error;
    rejectLoad?: Error;
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
    const startedAt = sessionDateMs(loaded.startedAt);
    if (request.startDate && startedAt < request.startDate.getTime()) {
      return false;
    }
    if (request.endDate && startedAt > request.endDate.getTime()) {
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
    attribution: options.attribution ?? {
      repositoryFullName: options.repositoryFullName ?? null,
      worktreePath: options.worktreePath ?? null,
      sourceArtifactId: null,
      sourceLoopId: null,
      issueId: null,
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
