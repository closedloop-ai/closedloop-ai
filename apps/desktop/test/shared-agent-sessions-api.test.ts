import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildUserColor } from "@repo/api/src/agent-session-user-color";
import {
  AgentSessionState,
  type TurnItem,
} from "@repo/api/src/types/agent-session";
import { TranscriptAvailability } from "@repo/api/src/types/desktop-transcripts";
import { SessionPrRelationType } from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SessionPrLifecycleStatus } from "@repo/lib/session-trace/derivation";
import type { SessionCursorRow } from "../src/main/agent-sync/agent-session-read-model.js";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  SESSIONS_ANALYTICS_DATE_WINDOW_FIELD,
  SESSIONS_SURFACE_DATE_WINDOW_FIELD,
} from "../src/main/agent-sync/session-date-window.js";
import {
  ensureOrgDirectory,
  resetOrgDirectoryCacheForTest,
} from "../src/main/session/org-directory-cache.js";
import { getSharedAgentSessionDetail } from "../src/main/session/shared-agent-session-detail-read.js";
import {
  getSharedAgentSessionAnalytics,
  getSharedAgentSessions,
  getSharedAgentSessionsByIds,
  getSharedAgentSessionUsage,
  MAX_WORKING_SET_SESSIONS,
} from "../src/main/session/shared-agent-sessions-api.js";
import { getSharedAgentSessionsPageData } from "../src/main/session/shared-agent-sessions-page-data.js";
import { DESKTOP_LOCAL_SESSION_AUTHOR_LABEL } from "../src/shared/shared-agent-sessions-contract.js";
import {
  createFakeSource,
  cursor,
  defaultSessions,
  type SourceCall,
  session,
  usageAggregate,
} from "./shared-agent-sessions-test-helpers.js";

const CURSOR_FAILED_PATTERN = /cursor failed/;
const LOAD_FAILED_PATTERN = /load failed/;
const HSL_COLOR_PATTERN = /^hsl\(\d{1,3} 65% 45%\)$/;

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
      // Stage 1b (see shared-agent-sessions-unsorted-cursor-page.test.ts): a
      // sortless read pages in SQL now; this sort keeps it on the fallback.
      sortBy: "cost",
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
      // quality:"all" keeps the SQL cursor-page path under test; the FEA-3284
      // substantive default is not SQL-expressible and would take the
      // full-hydration path instead.
      quality: "all",
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
      // quality:"all" keeps the SQL cursor-page path under test (see above).
      quality: "all",
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

  // FEA-3009 completion-time boundary: the Agents nav badge counts sessions
  // COMPLETED since the user last opened Agents. The count must filter on the
  // terminal `endedAt` timestamp, NOT `startedAt` — so a long-running session
  // that started before the boundary but completed after it IS counted, and one
  // that completed before the boundary is NOT. This is the desktop half of the
  // cross-surface parity contract (the cloud half asserts `sessionEndedAt >= gte`
  // in query-builder.test.ts).
  test("completedAfter counts a session started-before-but-completed-after; excludes completed-before and still-running", async () => {
    const boundary = "2026-06-15T00:00:00.000Z";
    const sessions: Record<string, SyncedAgentSession> = {
      // Started well before the boundary, completed AFTER it → counted. A
      // `startedAt`-based filter would have dropped this (the bug Kris flagged).
      "long-running-completed-after": session({
        id: "long-running-completed-after",
        status: "completed",
        awaitingInputSince: null,
        startedAt: "2026-06-01T00:00:00.000Z",
        endedAt: "2026-06-20T00:00:00.000Z",
      }),
      // Completed BEFORE the boundary → not counted (already caught up).
      "completed-before": session({
        id: "completed-before",
        status: "completed",
        awaitingInputSince: null,
        startedAt: "2026-06-02T00:00:00.000Z",
        endedAt: "2026-06-10T00:00:00.000Z",
      }),
      // Still running (no endedAt) → excluded, mirroring the cloud `gte` on the
      // nullable sessionEndedAt column (which never matches NULL).
      "still-running": session({
        id: "still-running",
        status: SESSION_STATUS.ACTIVE,
        awaitingInputSince: null,
        startedAt: "2026-06-18T00:00:00.000Z",
        endedAt: null,
      }),
    };
    const source = createFakeSource({
      cursorRows: [
        cursor("long-running-completed-after"),
        cursor("completed-before"),
        cursor("still-running"),
      ],
      sessions,
    });

    const response = await getSharedAgentSessions(source, {
      statuses: ["completed"],
      completedAfter: boundary,
      quality: "all",
    });

    // completedAfter is not SQL-expressible on the cursor page, so the read
    // falls through to the full-hydration path where `matchesQuery` applies the
    // endedAt bound in memory (same fold the cloud pushes into SQL).
    assert.deepEqual(
      source.calls.map((call) => call.kind),
      ["listAllSessionCursorRows", "loadSyncedSessions"]
    );
    assert.equal(response.total, 1);
    assert.deepEqual(
      response.items.map((item) => item.id),
      ["long-running-completed-after"]
    );
  });

  /* ISS-4586 gave the Inactive Status filter a fold so it also reached rows a
   * pre-migration store persisted as `completed`/`abandoned`. ISS-4654 removes
   * that fold on DESKTOP, and this test is what pins the removal: local
   * migration `0042_iss4586_session_status_ends_with_error` runs at boot, so
   * every store this code executes against has already collapsed those rows and
   * there is nothing left for the fold to reach. The retired spellings are
   * asserted EXCLUDED rather than simply dropped from the fixture, so silently
   * restoring the fold — or widening `canonicalSharedStatus` to fold them — goes
   * red instead of passing unnoticed.
   *
   * The two surfaces used to differ here on purpose — the cloud facet kept an
   * expansion this one did not, because a straggler row was reachable there and
   * not locally. ISS-5592 closed that: the cloud expansion is gone (a production
   * count found no row carrying a retired spelling) and so is the alias map both
   * halves consulted. Neither surface folds now, so this asserts the shared
   * behaviour rather than a desktop-only narrowing. */
  test("inactive status filter matches inactive rows only — not active, error, or the retired spellings", async () => {
    const sessions = {
      "legacy-completed": session({
        id: "legacy-completed",
        status: "completed",
        awaitingInputSince: null,
        endedAt: "2026-06-20T00:00:00.000Z",
      }),
      "legacy-abandoned": session({
        id: "legacy-abandoned",
        status: "abandoned",
        awaitingInputSince: null,
        endedAt: "2026-06-20T00:00:00.000Z",
      }),
      "migrated-inactive": session({
        id: "migrated-inactive",
        status: SESSION_STATUS.INACTIVE,
        awaitingInputSince: null,
        endedAt: "2026-06-20T00:00:00.000Z",
      }),
      "live-active": session({
        id: "live-active",
        status: SESSION_STATUS.ACTIVE,
        awaitingInputSince: null,
        endedAt: null,
      }),
      "ended-error": session({
        id: "ended-error",
        status: SESSION_STATUS.ERROR,
        awaitingInputSince: null,
        endedAt: "2026-06-20T00:00:00.000Z",
      }),
    };
    const source = createFakeSource({
      cursorRows: [
        cursor("legacy-completed"),
        cursor("legacy-abandoned"),
        cursor("migrated-inactive"),
        cursor("live-active"),
        cursor("ended-error"),
      ],
      sessions,
    });

    const response = await getSharedAgentSessions(source, {
      statuses: [SESSION_STATUS.INACTIVE],
    });

    assert.deepEqual(response.items.map((item) => item.id).sort(), [
      "migrated-inactive",
    ]);
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
      idleCount: 0,
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

  test("PRD-536 E6: cloudSyncState is `pending` for ids in the outbox set, `synced` otherwise", async () => {
    const source = createFakeSource({
      cursorRows: [
        cursor("session-a"),
        cursor("session-b"),
        cursor("session-c"),
      ],
      // Only session-b is still enqueued (un-acked) in the sync outbox.
      pendingOutboxIds: ["session-b"],
    });

    const response = await getSharedAgentSessions(
      source,
      { quality: "all" },
      { computeTargetId: "target-123" }
    );

    // The outbox was consulted under the SAME source key the write side keys on.
    const outboxCall = source.calls.find(
      (call) => call.kind === "loadPendingOutboxIds"
    );
    assert.equal(outboxCall?.sourceKey, "agent_sessions:target-123");

    const byId = new Map(response.items.map((item) => [item.id, item]));
    assert.equal(byId.get("session-b")?.cloudSyncState, "pending");
    assert.equal(byId.get("session-a")?.cloudSyncState, "synced");
    assert.equal(byId.get("session-c")?.cloudSyncState, "synced");
  });

  test("PRD-536 E6: no compute target → outbox is never read → every row is `synced`", async () => {
    const source = createFakeSource({
      cursorRows: [cursor("session-a"), cursor("session-b")],
      pendingOutboxIds: ["session-b"],
    });

    // Offline/unauthenticated: computeTargetId omitted (defaults to null).
    const response = await getSharedAgentSessions(source, { quality: "all" });

    assert.equal(
      source.calls.some((call) => call.kind === "loadPendingOutboxIds"),
      false
    );
    for (const item of response.items) {
      assert.equal(item.cloudSyncState, "synced");
    }
  });

  // #4150: the failing-outbox-read case (a lookup that THREW is preserved as
  // unknown, so the row publishes NO verdict) lives with the rest of the
  // cloudSyncState disclosure contract in
  // `shared-agent-sessions-transcript-parity.test.ts` — this suite is a
  // grandfathered over-ceiling file that must not grow.

  test("detail omits transcripts when no local resolver is supplied (default)", async () => {
    const source = createFakeSource({
      cursorRows: [cursor("session-a", "1999-01-01T00:00:00.000Z")],
      sessions: { "session-a": session({ id: "session-a" }) },
    });
    const detail = await getSharedAgentSessionDetail(source, "session-a");
    assert.equal(detail?.transcripts, undefined);
  });

  test("detail surfaces the local transcript summary when the resolver finds an on-disk copy (#2977 gating fix)", async () => {
    const source = createFakeSource({
      cursorRows: [cursor("session-a", "1999-01-01T00:00:00.000Z")],
      sessions: { "session-a": session({ id: "session-a" }) },
    });
    const seen: string[] = [];
    const detail = await getSharedAgentSessionDetail(source, "session-a", {
      resolveLocalTranscripts: (externalSessionId) => {
        seen.push(externalSessionId);
        return Promise.resolve([
          {
            fileKey: "main",
            availability: TranscriptAvailability.Available,
            uploadedAt: null,
            // Required on `TranscriptAvailabilitySummary`, and null for every
            // availability state other than `permanentlyUnavailable`.
            permanentFailureReason: null,
          },
        ]);
      },
    });
    // Keyed by the harness externalSessionId (== id in the fixture).
    assert.deepEqual(seen, ["session-a"]);
    assert.deepEqual(detail?.transcripts, [
      {
        fileKey: "main",
        availability: TranscriptAvailability.Available,
        uploadedAt: null,
        // The detail read passes the resolver's summary through verbatim, so
        // every member the resolver must supply lands here too.
        permanentFailureReason: null,
      },
    ]);
  });

  test("detail omits transcripts when the local resolver finds nothing or throws", async () => {
    const source = createFakeSource({
      cursorRows: [cursor("session-a", "1999-01-01T00:00:00.000Z")],
      sessions: { "session-a": session({ id: "session-a" }) },
    });
    const emptyDetail = await getSharedAgentSessionDetail(source, "session-a", {
      resolveLocalTranscripts: () => Promise.resolve(null),
    });
    assert.equal(emptyDetail?.transcripts, undefined);

    const throwingDetail = await getSharedAgentSessionDetail(
      source,
      "session-a",
      {
        resolveLocalTranscripts: () =>
          Promise.reject(new Error("discovery failed")),
      }
    );
    // A failed lookup must never blank the detail — it just omits transcripts.
    assert.equal(throwingDetail?.transcripts, undefined);
    assert.equal(throwingDetail?.id, "session-a");
  });

  test("detail preserves local field ownership and uses the desktop author fallback", async () => {
    const localSession = {
      ...session({
        id: "session-local-detail",
        status: SESSION_STATUS.ACTIVE,
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
    // The LOC/$ / KLOC projection this same detail read produces is covered in
    // `shared-agent-sessions-loc-per-dollar.test.ts` (ISS-4667).

    const promptTurn = detail?.turnItems?.find(
      (item) => item.type === "prompt"
    );
    assert.equal(promptTurn?.type, "prompt");
    if (promptTurn?.type === "prompt") {
      assert.equal(promptTurn.actor.name, DESKTOP_LOCAL_SESSION_AUTHOR_LABEL);
    }
  });

  // FEA-3551 / FEA-4287 cross-surface parity: an abandoned (orphan-swept) desktop
  // session that shipped a PR must read as Completed — matching the cloud
  // projection — and an abandoned session WITHOUT a PR preserves the Abandoned
  // terminal outcome (previously collapsed to Blocked).
  test("abandoned session with a merged PR is Completed; without a PR is Abandoned", async () => {
    const withPr = {
      ...session({
        id: "session-abandoned-pr",
        status: "abandoned",
        awaitingInputSince: null,
        endedAt: "2026-07-20T02:10:11.000Z",
      }),
      prs: [
        {
          num: 3105,
          status: SessionPrLifecycleStatus.Merged,
          title: "Shipped before going idle",
        },
      ],
    } satisfies SyncedAgentSession;
    const withoutPr = {
      ...session({
        id: "session-abandoned-no-pr",
        status: "abandoned",
        awaitingInputSince: null,
        endedAt: "2026-07-20T02:10:11.000Z",
      }),
      prs: [],
    } satisfies SyncedAgentSession;

    const source = createFakeSource({
      cursorRows: [
        cursor("session-abandoned-pr"),
        cursor("session-abandoned-no-pr"),
      ],
      sessions: {
        "session-abandoned-pr": withPr,
        "session-abandoned-no-pr": withoutPr,
      },
    });

    const shippedDetail = await getSharedAgentSessionDetail(
      source,
      "session-abandoned-pr"
    );
    assert.equal(shippedDetail?.status, "abandoned");
    assert.equal(shippedDetail?.prsMerged, 1);
    assert.equal(shippedDetail?.state, AgentSessionState.Completed);

    const blockedDetail = await getSharedAgentSessionDetail(
      source,
      "session-abandoned-no-pr"
    );
    assert.equal(blockedDetail?.status, "abandoned");
    assert.equal(blockedDetail?.prsMerged, 0);
    // ISS-4654: `abandoned` is retired, so a straggler row falls through the
    // terminal gate to the ended-run fallback and reads Completed on BOTH
    // surfaces — the cross-surface parity this assertion exists for is
    // preserved, at the new value.
    assert.equal(blockedDetail?.state, AgentSessionState.Completed);
  });

  // FEA-4287 cross-surface parity: a terminal ERROR desktop session preserves the
  // Error outcome instead of collapsing to Blocked, matching the cloud projection
  // and the Sessions LIST (which renders the raw `error` status as "Failed").
  test("errored session reads as Error, not Blocked", async () => {
    const errored = {
      ...session({
        id: "session-errored",
        status: "error",
        awaitingInputSince: null,
        endedAt: "2026-07-20T02:10:11.000Z",
      }),
      prs: [],
    } satisfies SyncedAgentSession;

    const source = createFakeSource({
      cursorRows: [cursor("session-errored")],
      sessions: {
        "session-errored": errored,
      },
    });

    const erroredDetail = await getSharedAgentSessionDetail(
      source,
      "session-errored"
    );
    // Desktop persists the local `failed` alias for the raw status; the shared
    // classifier normalizes error/failed and maps both to the Error terminal
    // state (FEA-4287), so `state` — the field the detail page renders — must be
    // Error, not Blocked, regardless of the local status spelling.
    assert.equal(erroredDetail?.state, AgentSessionState.Error);
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

  test("user-column sort orders by resolved owner email, matching the cloud (unattributed rows cluster)", async () => {
    resetOrgDirectoryCacheForTest();
    const okUsers = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            data: [
              {
                id: "user-alex",
                email: "alex@example.com",
                firstName: "Alex",
                lastName: "A",
                avatarUrl: null,
              },
              {
                id: "user-peter",
                email: "peter@example.com",
                firstName: "Peter",
                lastName: "P",
                avatarUrl: null,
              },
              {
                id: "user-zara",
                email: "zara@example.com",
                firstName: "Zara",
                lastName: "Z",
                avatarUrl: null,
              },
            ],
          }),
          { status: 200 }
        )
      )) as unknown as typeof fetch;
    await ensureOrgDirectory(
      {
        getApiOrigin: () => "https://api.test",
        getApiKey: () => "sk_live_test",
        fetchImpl: okUsers,
      },
      1000
    );

    const source = createFakeSource({
      cursorRows: [
        cursor("s-peter"),
        cursor("s-null"),
        cursor("s-zara"),
        cursor("s-alex"),
      ],
      sessions: {
        "s-alex": session({ id: "s-alex", userId: "user-alex" }),
        "s-peter": session({ id: "s-peter", userId: "user-peter" }),
        "s-zara": session({ id: "s-zara", userId: "user-zara" }),
        // No `userId` → owner unresolved (NULL). FEA-4330: owner-less rows sort
        // LAST in BOTH directions (matching the cloud `compareByOwnerDisplayName`
        // nulls-last), NOT the old Postgres-default nulls-first-on-desc.
        "s-null": session({ id: "s-null" }),
      },
    });

    const asc = await getSharedAgentSessions(source, {
      sortBy: "user",
      sortDir: "asc",
    });
    assert.deepEqual(
      asc.items.map((item) => item.id),
      ["s-alex", "s-peter", "s-zara", "s-null"]
    );

    const desc = await getSharedAgentSessions(source, {
      sortBy: "user",
      sortDir: "desc",
    });
    assert.deepEqual(
      desc.items.map((item) => item.id),
      ["s-zara", "s-peter", "s-alex", "s-null"]
    );

    resetOrgDirectoryCacheForTest();
  });

  test("user-column sort degrades to a stable no-op when the org directory is cold", async () => {
    // With no directory loaded every owner resolves to null → every pair
    // compares equal, so the rows keep their incoming (cursor) order instead of
    // throwing or reordering by the opaque user_id.
    resetOrgDirectoryCacheForTest();
    const source = createFakeSource({
      cursorRows: [cursor("s-peter"), cursor("s-alex"), cursor("s-zara")],
      sessions: {
        "s-alex": session({ id: "s-alex", userId: "user-alex" }),
        "s-peter": session({ id: "s-peter", userId: "user-peter" }),
        "s-zara": session({ id: "s-zara", userId: "user-zara" }),
      },
    });

    const asc = await getSharedAgentSessions(source, {
      sortBy: "user",
      sortDir: "asc",
    });
    assert.deepEqual(
      asc.items.map((item) => item.id),
      ["s-peter", "s-alex", "s-zara"]
    );
  });

  test("userIds filters multiple desktop owners when no scoped userId narrows it", async () => {
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
      userIds: ["user-alex", "user-peter"],
    });
    assert.equal(list.total, 2);
    assert.deepEqual(
      list.items.map((item) => item.id),
      ["alex-1", "peter-1"]
    );

    const usage = await getSharedAgentSessionUsage(source, {
      userIds: ["user-alex", "user-peter"],
    });
    assert.equal(usage.totalSessions, 2);
  });

  // FEA-4304: the scoped `userId` (the fixed cross-surface scope) is AND-ed with
  // the Owner facet — the facet may only narrow within the scoped user, never
  // widen past it. Parity with the cloud `applyUserScope`.
  test("scoped userId AND-constrains the Owner facet: facet keeping the scoped user pins to it", async () => {
    const source = createFakeSource({
      cursorRows: [cursor("alex-1"), cursor("peter-1"), cursor("casey-1")],
      sessions: {
        "alex-1": session({ id: "alex-1", userId: "user-alex" }),
        "peter-1": session({ id: "peter-1", userId: "user-peter" }),
        "casey-1": session({ id: "casey-1", userId: "user-casey" }),
      },
    });

    // Facet includes the scoped user → intersection collapses to that one user;
    // the wider facet member (peter) is NOT surfaced under the alex scope.
    const list = await getSharedAgentSessions(source, {
      userId: "user-alex",
      userIds: ["user-alex", "user-peter"],
    });
    assert.equal(list.total, 1);
    assert.deepEqual(
      list.items.map((item) => item.id),
      ["alex-1"]
    );

    const usage = await getSharedAgentSessionUsage(source, {
      userId: "user-alex",
      userIds: ["user-alex", "user-peter"],
    });
    assert.equal(usage.totalSessions, 1);
  });

  test("scoped userId AND-constrains the Owner facet: facet excluding the scoped user returns no rows, not the facet's owners", async () => {
    const aggregateCalls: unknown[] = [];
    const source = createFakeSource({
      cursorRows: [cursor("alex-1"), cursor("peter-1"), cursor("casey-1")],
      sessions: {
        "alex-1": session({ id: "alex-1", userId: "user-alex" }),
        "peter-1": session({ id: "peter-1", userId: "user-peter" }),
        "casey-1": session({ id: "casey-1", userId: "user-casey" }),
      },
      aggregateUsage: (filters) => {
        aggregateCalls.push(filters);
        return usageAggregate({ totalSessions: 99 });
      },
    });

    // scoped user (casey) is NOT in the Owner facet → empty AND-intersection.
    // The facet's owners (alex, peter) must NOT leak under the casey scope, and
    // the SQL aggregate must never be consulted with the emptied filter set.
    const list = await getSharedAgentSessions(source, {
      userId: "user-casey",
      userIds: ["user-alex", "user-peter"],
    });
    assert.equal(list.total, 0);
    assert.deepEqual(list.items, []);

    const usage = await getSharedAgentSessionUsage(source, {
      userId: "user-casey",
      userIds: ["user-alex", "user-peter"],
    });
    assert.equal(usage.totalSessions, 0);
    assert.deepEqual(aggregateCalls, []);
  });

  test("user-filtered aggregate reads pass owner filters instead of returning unfiltered data", async () => {
    const source = createFakeSource({
      aggregateUsage: (filters) =>
        usageAggregate({
          totalSessions: filters.userIds?.length ?? (filters.userId ? 1 : 99),
          harnessSessionCounts: [
            {
              harness: "claude",
              sessionCount:
                filters.userIds?.length ?? (filters.userId ? 1 : 99),
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
      dateWindowField: SESSIONS_SURFACE_DATE_WINDOW_FIELD,
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
    // ISS-5443: analytics is a deliberately DIFFERENT cohort from the usage read
    // above — "started in the period" — so it must not inherit the surface basis.
    assert.deepEqual(source.calls[1]?.aggregateFilters, {
      dateWindowField: SESSIONS_ANALYTICS_DATE_WINDOW_FIELD,
      userIds: ["user-alex", "user-peter"],
    });
  });

  test("multi-status aggregate reads stay on SQL aggregate filters", async () => {
    const source = createFakeSource({
      aggregateUsage: (filters) =>
        usageAggregate({
          totalSessions: filters.statuses?.length ?? 99,
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
      dateWindowField: SESSIONS_SURFACE_DATE_WINDOW_FIELD,
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
      dateWindowField: SESSIONS_ANALYTICS_DATE_WINDOW_FIELD,
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
          status: SESSION_STATUS.ACTIVE,
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
    // ISS-4535: a repo-filtered read resolves its match set pre-hydration via
    // `listRepositoryScopedSessionIds` (not the full `listAllSessionCursorRows`),
    // then hydrates only the matches.
    assert.deepEqual(
      source.calls.map((call) => call.kind),
      [
        "listRepositoryScopedSessionIds",
        "loadSyncedSessions",
        "listRepositoryScopedSessionIds",
        "loadSyncedSessions",
        "listRepositoryScopedSessionIds",
        "loadSyncedSessions",
      ]
    );
  });

  // ISS-4535 (PR #3996, @wongk): the Repository facet OPTION list comes from the
  // ALL-TIME SQL aggregate, but the repo predicate used to run on the hydrated
  // corpus — which `resolveOrderedIds` caps to the MAX_WORKING_SET_SESSIONS
  // NEWEST sessions on the full-hydration fallback. A repo represented ONLY by
  // sessions older than that window was therefore offered as a filter option and
  // then returned NO rows. The fix pushes the predicate INTO the pre-hydration id
  // resolution (`listRepositoryScopedSessionIds`), so it runs against every
  // session's metadata and every offered repo resolves to its real rows — while
  // the MATCHED id set is still capped, keeping the hydration bound intact.
  //
  // The repo-scoped source returns matches newest-first (updated_at DESC), so
  // seeding the target repo ONLY in the OLDER tail (beyond index
  // MAX_WORKING_SET_SESSIONS) proves the older-than-window repo still resolves.
  test("repository filter selects rows older than the MAX_WORKING_SET_SESSIONS window (ISS-4535)", async () => {
    const targetRepo = "closedloop-ai/older-only";
    const otherRepo = "closedloop-ai/newest";
    const overCap = MAX_WORKING_SET_SESSIONS + 40;
    const sessions: Record<string, SyncedAgentSession> = {};
    const cursorRows: SessionCursorRow[] = [];
    const olderRepoIds: string[] = [];
    for (let index = 0; index < overCap; index++) {
      const id = `sess-${String(index).padStart(6, "0")}`;
      // Only the OLDEST 30 sessions (the tail the cap would drop) belong to the
      // target repo; every session inside the newest window is another repo.
      const inOlderTail = index >= overCap - 30;
      const repositoryFullName = inOlderTail ? targetRepo : otherRepo;
      if (inOlderTail) {
        olderRepoIds.push(id);
      }
      sessions[id] = session({ id, repositoryFullName });
      cursorRows.push(cursor(id));
    }
    const source = createFakeSource({ cursorRows, sessions });

    const list = await getSharedAgentSessions(source, {
      repositories: [targetRepo],
      // Ask for more than the 30 matches so the page is not itself the limiter.
      limit: 100,
    });

    // The offered option resolves to its real rows, not an empty set.
    assert.equal(list.total, olderRepoIds.length);
    assert.deepEqual(
      list.items.map((item) => item.id).sort(),
      [...olderRepoIds].sort()
    );

    // Usage + analytics take the same hydrated matcher and must agree with the
    // list total (offered options ↔ resolvable rows stay consistent).
    const usage = await getSharedAgentSessionUsage(source, {
      repositories: [targetRepo],
    });
    assert.equal(usage.totalSessions, list.total);

    const analytics = await getSharedAgentSessionAnalytics(source, {
      repositories: [targetRepo],
    });
    assert.deepEqual(
      analytics.byRepository.map((entry) => [
        entry.repositoryFullName,
        entry.sessionCount,
      ]),
      [[targetRepo, olderRepoIds.length]]
    );

    // Sanity: the full corpus really did exceed the cap, so the older-only repo
    // was outside the MAX_WORKING_SET_SESSIONS newest window.
    assert.ok(
      overCap > MAX_WORKING_SET_SESSIONS,
      "corpus must exceed the cap for this regression to bite"
    );
  });

  // ISS-4535 (@wongk): a repo whose worktree was DELETED renders from the durable
  // stored `repo_full_name` (live cwd remote resolution returns null). The facet
  // offers it (its aggregate resolves live-first, stored-fallback), so selecting
  // it MUST return the row. Both sides use the SAME persisted-aware identity: the
  // pre-hydration `listRepositoryScopedSessionIds` resolves it, and the hydrated
  // `attribution.repositoryFullName` (which `resolveSyncAttributions` fills from
  // the stored name) matches the predicate — so the offered option resolves.
  test("repository filter resolves a deleted-worktree repo from its stored name (ISS-4535)", async () => {
    const deletedRepo = "closedloop-ai/deleted-worktree";
    // The live worktree is gone, so the session renders from its stored repo
    // name only — modeled here as the resolved `attribution.repositoryFullName`
    // with no live `worktreePath`, exactly what `applyStoredRepoFullName` yields.
    const deleted = session({
      id: "deleted-a",
      cwd: "/deleted/worktree/1",
      attribution: {
        repositoryFullName: deletedRepo,
        worktreePath: null,
        sourceArtifactId: null,
        sourceLoopId: null,
        baseBranch: null,
      },
    });
    const other = session({
      id: "live-b",
      repositoryFullName: "closedloop-ai/live",
    });
    const source = createFakeSource({
      cursorRows: [cursor("deleted-a"), cursor("live-b")],
      sessions: { "deleted-a": deleted, "live-b": other },
    });

    const list = await getSharedAgentSessions(source, {
      repositories: [deletedRepo],
    });

    assert.deepEqual(
      list.items.map((item) => item.id),
      ["deleted-a"],
      "the deleted-worktree repo option must resolve to its stored-name row"
    );
    assert.equal(list.total, 1);
  });

  // ISS-4535 (@wongk, cid 3680603493/3680603497): the repo-filter read must NOT
  // reopen the uncapped full-corpus hydration FEA-4286 bounded. ISS-4558: it now
  // PAGES the pre-hydration id set, so this pins the EXACT page — a `<= cap`
  // bound would pass for anything this branch returns (thadeusb, cid
  // 3754019307). The fallback's own cap, and the honest `total`, are pinned in
  // shared-agent-sessions-repository-population.test.ts.
  test("repository filter hydrates exactly one page, not the capped working set (ISS-4535)", async () => {
    const targetRepo = "closedloop-ai/over-cap";
    const overCap = MAX_WORKING_SET_SESSIONS + 50;
    const sessions: Record<string, SyncedAgentSession> = {};
    const cursorRows: SessionCursorRow[] = [];
    for (let index = 0; index < overCap; index++) {
      const id = `match-${String(index).padStart(6, "0")}`;
      // EVERY session matches the selected repo, so the matched set exceeds the
      // ceiling and the cap — not the predicate — must bound the hydration.
      sessions[id] = session({ id, repositoryFullName: targetRepo });
      cursorRows.push(cursor(id));
    }
    const source = createFakeSource({ cursorRows, sessions });

    await getSharedAgentSessions(source, {
      repositories: [targetRepo],
      limit: 50,
    });

    const loadCalls = source.calls.filter(
      (call) => call.kind === "loadSyncedSessions"
    );
    assert.equal(loadCalls.length, 1, "expected a single hydration call");
    assert.equal(
      loadCalls[0]?.ids?.length,
      50,
      "the repo-filtered read pages, so it hydrates exactly the requested page"
    );
  });

  // The unfiltered-fallback cap over an over-cap corpus is already covered by
  // `search/facet fallback hydrates at most MAX_WORKING_SET_SESSIONS ids over a
  // larger corpus` later in this file (same +25 seed, same free-text usage
  // fallback, same single-hydration-at-cap assertion, plus a summary check), so
  // no duplicate is kept here (shafty023, cid 3683127332).

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
    // "model-b" but it has a token-usage row for "model-secondary". FEA-4303 keys
    // the Model facet to the PRIMARY model only (options are sourced from
    // `modelFilterOptions`, not the secondary-spanning `byModel`), so filtering by
    // a model that appears only as a secondary token-usage row must NOT match it.
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
    // FEA-4303: a model that appears ONLY as a secondary token-usage row is not a
    // facet option and does not match — the predicate keys on the primary model,
    // so `mid` (primary "model-b") is not returned when filtering by its secondary.
    assert.deepEqual(await ids({ models: ["model-secondary"] }), []);
    // Filtering by `mid`'s PRIMARY model matches it.
    assert.deepEqual(await ids({ models: ["model-b"] }), ["mid"]);
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
          status: SESSION_STATUS.ACTIVE,
          awaitingInputSince: "2026-01-01T01:30:00.000Z",
          endedAt: "2026-01-01T02:00:00.000Z",
        }),
        "active-running-session": session({
          id: "active-running-session",
          status: SESSION_STATUS.ACTIVE,
          awaitingInputSince: null,
          endedAt: null,
        }),
        "awaiting-running-session": session({
          id: "awaiting-running-session",
          status: SESSION_STATUS.ACTIVE,
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
    // FEA-3986: totalEstimatedCost is the subscription-INCLUSIVE grand total,
    // matching the cloud contract — subscription (0.5) + api (0.5) = 1.0, NOT
    // the metered-only 0.5 the desktop producer used to emit.
    assert.equal(usage.totalEstimatedCost, 1);
    assert.equal(
      usage.totalEstimatedCost,
      usage.subscriptionEstimatedCost + usage.apiEstimatedCost
    );
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
    // FEA-4299: the repository breakdown keys on the resolved `repositoryFullName`
    // (the value the row renders), never a `worktreePath`/`cwd` folder. session-b
    // (worktree-only) and session-c (cwd-only) have no resolved remote, so they
    // render "Unknown" and are dropped from the breakdown — matching the facet
    // options, so a value can't appear here yet be un-filterable.
    assert.deepEqual(
      analytics.byRepository.map((entry) => [
        entry.repositoryFullName,
        entry.sessionCount,
        entry.errorCount,
      ]),
      [["closedloop-ai/symphony-alpha", 1, 1]]
    );
  });

  test("usage via loadUsageSessions matches the full-hydrate path across filters (FEA-1834)", async () => {
    const sessions = defaultSessions();
    // Simulate the sqlite `usageOnly` load: same sessions, but agents/events
    // stripped. FEA-4299: the real lightweight load still projects the durable
    // per-session `repo_full_name` onto a repo-only attribution (no live git
    // worktree/launch-metadata fields) so the Repository facet options match the
    // full-hydrate path; mirror that here by keeping only `repositoryFullName`.
    // If the summary still matches the full-hydrate path, agents/events and the
    // worktree/launch fields provably do not affect the usage numbers.
    const makeUsageSource = () => ({
      ...createFakeSource({ sessions }),
      loadUsageSessions(ids: string[]): SyncedAgentSession[] {
        return ids.flatMap((id) => {
          const loaded = sessions[id];
          if (!loaded) {
            return [];
          }
          const repositoryFullName =
            loaded.attribution?.repositoryFullName ?? null;
          return [
            {
              ...loaded,
              agents: [],
              events: [],
              attribution: repositoryFullName
                ? {
                    repositoryFullName,
                    worktreePath: null,
                    sourceArtifactId: null,
                    sourceLoopId: null,
                    baseBranch: null,
                  }
                : undefined,
            },
          ];
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
          if (!loaded) {
            return [];
          }
          // FEA-4299: the lightweight load keeps the repo-only attribution.
          const repositoryFullName =
            loaded.attribution?.repositoryFullName ?? null;
          return [
            {
              ...loaded,
              agents: [],
              events: [],
              attribution: repositoryFullName
                ? {
                    repositoryFullName,
                    worktreePath: null,
                    sourceArtifactId: null,
                    sourceLoopId: null,
                    baseBranch: null,
                  }
                : undefined,
            },
          ];
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

  test("usage `loadUsageSessions` fast path hydrates at most MAX_WORKING_SET_SESSIONS ids on a >5000 corpus (FEA-4286)", async () => {
    // FEA-4286 reverses the earlier FEA-3207 uncapped-parity decision for this
    // path. `loadUsageSessions` materializes EVERY resolved session into JS and
    // folds it (`buildUsageSummary`); "lightweight per row" (metadata +
    // tokenUsageByModel, no agents/events) is not "bounded in total". Uncapped it
    // is O(corpus), and it runs on the Sessions page's 2 s background page-data
    // poll — on a large local corpus that steady-cadence full-corpus hydrate
    // starved the desktop main process and wedged the renderer (the Vite HMR
    // "server connection lost" hang). The fast path must now bound its hydration
    // at the FEA-3132 A5b ceiling, exactly like every other hydration path.
    const corpusSize = MAX_WORKING_SET_SESSIONS + 137;
    const cursorRows: SessionCursorRow[] = [];
    const sessions: Record<string, SyncedAgentSession> = {};
    for (let i = 0; i < corpusSize; i++) {
      const id = `bulk-${String(i).padStart(5, "0")}`;
      cursorRows.push(cursor(id));
      sessions[id] = session({ id });
    }

    // Capture exactly which ids the usage fast path hands to `loadUsageSessions`,
    // so we can assert its aggregation basis is bounded, not the full corpus.
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

    // No facet filters + no `aggregateUsage`: the usage summary takes the
    // pushable `loadUsageSessions` fast path (the SQL aggregate is tried first,
    // but `createFakeSource` omits it here).
    const usage = await getSharedAgentSessionUsage(source, {});

    // Sanity: the corpus genuinely exceeds the cap, so an uncapped path would
    // have hydrated every one of `corpusSize` sessions.
    assert.ok(
      corpusSize > MAX_WORKING_SET_SESSIONS,
      "corpus must exceed the working-set ceiling to exercise the bound"
    );
    assert.equal(
      usageLoadIds.length,
      MAX_WORKING_SET_SESSIONS,
      "loadUsageSessions must receive at most the MAX_WORKING_SET_SESSIONS most-recent ids"
    );
    assert.ok(
      usageLoadIds.length < corpusSize,
      "the usage fast path is bounded — it no longer hydrates the full corpus"
    );
    // The bounded aggregate covers the capped set (documented FEA-4286 trade-off:
    // past the ceiling the usage total trails the true corpus size; exact parity
    // belongs on the never-hydrating SQL `aggregateUsage` aggregate).
    assert.equal(
      usage.totalSessions,
      MAX_WORKING_SET_SESSIONS,
      "usage summary aggregates over the bounded most-recent working set"
    );
  });

  test("source failures reject instead of returning empty success", async () => {
    await assert.rejects(
      // Stage 1b: this sort keeps the read on `listAllSessionCursorRows`.
      getSharedAgentSessions(
        createFakeSource({ rejectListAll: new Error("cursor failed") }),
        { sortBy: "cost" }
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

  test("mapDetail forwards throttleSources onto the detail DTO (FEA-3461)", async () => {
    const throttleSources: NonNullable<SyncedAgentSession["throttleSources"]> =
      [
        {
          sourceType: "provider_rate_limit",
          provider: "anthropic",
          observedAt: "2026-01-01T00:07:00.000Z",
          statusCode: 429,
        },
      ];
    const source = createFakeSource({
      sessions: {
        "session-a": session({ id: "session-a", throttleSources }),
      },
    });

    const detail = await getSharedAgentSessionDetail(source, "session-a");

    assert.ok(detail !== null, "expected detail to be non-null");
    // Before the fix mapDetail dropped throttleSources, so the renderer's
    // throttle/limit dots were blank in Local mode only. It must now carry the
    // synced source arrays through to the DTO at parity with the cloud detail.
    assert.deepEqual(detail.throttleSources, throttleSources);
  });

  test("mapDetail derives the per-phase activitySegments from the local tiling + token events (FEA-2275)", async () => {
    const planStart = new Date("2026-01-01T00:00:00.000Z").getTime();
    const implementStart = new Date("2026-01-01T01:00:00.000Z").getTime();
    const sessionEnd = new Date("2026-01-01T02:00:00.000Z").getTime();
    const activitySegmentRows: NonNullable<
      SyncedAgentSession["activitySegmentRows"]
    > = [
      {
        phase: "plan",
        startMs: planStart,
        endMs: implementStart,
        confidence: 0.9,
        evidenceLayers: ["declared"],
        version: 1,
      },
      {
        phase: "implement",
        startMs: implementStart,
        endMs: sessionEnd,
        confidence: 0.6,
        evidenceLayers: ["structural"],
        version: 1,
      },
    ];
    const tokenEvents: NonNullable<SyncedAgentSession["tokenEvents"]> = [
      {
        externalEventId: "e1",
        model: "gpt-test",
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 5,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0.1,
        createdAt: "2026-01-01T00:30:00.000Z", // inside plan
      },
      {
        externalEventId: "e2",
        model: "gpt-test",
        inputTokens: 400,
        outputTokens: 40,
        cacheReadTokens: 0,
        cacheWriteTokens: 20,
        estimatedCostUsd: 0.2,
        createdAt: "2026-01-01T01:30:00.000Z", // inside implement
      },
    ];
    const source = createFakeSource({
      sessions: {
        "session-a": session({
          id: "session-a",
          activitySegmentRows,
          tokenEvents,
        }),
      },
    });

    const detail = await getSharedAgentSessionDetail(source, "session-a");

    assert.ok(detail !== null, "expected detail to be non-null");
    // The raw tiling is forwarded onto the DTO (rendered by FEA-3705's Activity
    // Segments strip) and the derived per-phase cost breakdown is added on top.
    assert.deepEqual(detail.activitySegmentRows, activitySegmentRows);
    assert.ok(detail.activitySegments, "expected activitySegments on the DTO");
    const segments = detail.activitySegments;
    assert.deepEqual(
      segments.map((s) => s.key),
      ["plan", "implement"]
    );
    const plan = segments.find((s) => s.key === "plan");
    const implement = segments.find((s) => s.key === "implement");
    assert.ok(plan && implement, "expected both phase segments");
    // Per-phase cost/tokens come from binning the token events into the spans.
    assert.equal(plan.costUsd, 0.1);
    assert.equal(plan.inputTokens, 100);
    assert.equal(implement.costUsd, 0.2);
    assert.equal(implement.inputTokens, 400);
    // Declared evidence -> explicit; structural-only -> inferred.
    assert.equal(plan.source, "explicit");
    assert.equal(implement.source, "loop_perf");
    // Reconciliation: per-phase cost sums to the event total.
    const totalCost = segments.reduce((sum, s) => sum + s.costUsd, 0);
    assert.ok(
      Math.abs(totalCost - 0.3) < 1e-9,
      "per-phase cost must reconcile to the event total"
    );
  });

  test("mapDetail omits activitySegments when the local session has no tiling (FEA-2275 fallback)", async () => {
    const source = createFakeSource({
      sessions: { "session-a": session({ id: "session-a" }) },
    });

    const detail = await getSharedAgentSessionDetail(source, "session-a");

    assert.ok(detail !== null, "expected detail to be non-null");
    // No raw rows -> aggregator returns []; the additive field is omitted (not
    // emitted as []) and the renderer applies the honest catch-all fallback
    // rather than fabricating attribution.
    assert.equal(detail.activitySegments, undefined);
    assert.equal(detail.activitySegmentRows, undefined);
  });

  test("mapDetail forwards activitySegmentRows onto the detail DTO (FEA-3705)", async () => {
    const activitySegmentRows: NonNullable<
      SyncedAgentSession["activitySegmentRows"]
    > = [
      {
        phase: "implement",
        startMs: 1000,
        endMs: 2000,
        confidence: 0.92,
        evidenceLayers: ["declared"],
        version: 1,
      },
      {
        phase: "idle",
        startMs: 2000,
        endMs: 2500,
        confidence: 0,
        evidenceLayers: [],
        version: 1,
      },
    ];
    const source = createFakeSource({
      sessions: {
        "session-a": session({ id: "session-a", activitySegmentRows }),
      },
    });

    const detail = await getSharedAgentSessionDetail(source, "session-a");

    assert.ok(detail !== null, "expected detail to be non-null");
    // Before the fix mapDetail dropped activitySegmentRows, so the shared
    // Activity Segments strip fell back to its "unavailable" state in Local mode
    // only. It must now carry the synced tiling through to the DTO at parity
    // with the cloud detail so both surfaces render the segments.
    assert.deepEqual(detail.activitySegmentRows, activitySegmentRows);
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

  // FEA-3284/FEA-3345: hide idle sessions on the desktop read, mirroring the
  // cloud `quality` param + idleCount. An idle row carries no turns, no tokens,
  // and no tool-use events; a substantive row has at least one signal. Hiding is
  // opt-in via an EXPLICIT `quality:"substantive"` (FEA-3345 fail-open default is
  // `all`); a `substantive` request is not SQL-expressible on desktop, so it
  // forces the full-hydration path (listAllSessionCursorRows + loadSyncedSessions)
  // where the shared `isSubstantiveSession` SSOT is applied by `matchesQuery`.
  const idleSession = (id: string): SyncedAgentSession => ({
    ...session({ id }),
    turns: null,
    events: [],
    tokenUsageByModel: [],
  });

  test("hides idle sessions on an explicit quality=substantive and reports the idle count within scope", async () => {
    const source = createFakeSource({
      cursorRows: [
        cursor("live-a"),
        cursor("idle-a"),
        cursor("idle-b"),
        cursor("live-b"),
      ],
      sessions: {
        "live-a": session({ id: "live-a" }),
        "idle-a": idleSession("idle-a"),
        "idle-b": idleSession("idle-b"),
        "live-b": session({ id: "live-b" }),
      },
    });

    const response = await getSharedAgentSessions(source, {
      quality: "substantive",
      limit: 25,
    });

    // Forces the full-hydration path — not the SQL cursor page.
    assert.deepEqual(
      source.calls.map((call) => call.kind),
      ["listAllSessionCursorRows", "loadSyncedSessions"]
    );
    assert.deepEqual(response.items.map((item) => item.id).sort(), [
      "live-a",
      "live-b",
    ]);
    assert.equal(response.total, 2);
    assert.equal(response.idleCount, 2);
  });

  // FEA-3345 AC-1: the desktop read is fail-open by default. With no `quality`
  // param (every ungated desktop surface — Dashboard, Insights bounded view) the
  // sanitizer resolves to `all`, so a corpus of only-idle rows is returned in
  // full and nothing is reported as hidden. This is the desktop-seam
  // anti-regression pin: a future ungated surface cannot silently hide idle rows.
  test("shows all sessions by default when no quality param is sent (FEA-3345 fail-open)", async () => {
    const source = createFakeSource({
      cursorRows: [cursor("idle-a"), cursor("idle-b"), cursor("live-a")],
      sessions: {
        "idle-a": idleSession("idle-a"),
        "idle-b": idleSession("idle-b"),
        "live-a": session({ id: "live-a" }),
      },
    });

    const response = await getSharedAgentSessions(source, { limit: 25 });

    assert.deepEqual(response.items.map((item) => item.id).sort(), [
      "idle-a",
      "idle-b",
      "live-a",
    ]);
    assert.equal(response.total, 3);
    // Fail-open default is already showing idle rows → nothing hidden.
    assert.equal(response.idleCount, 0);
  });

  test("quality=all reveals idle rows and reports idleCount 0", async () => {
    const source = createFakeSource({
      cursorRows: [cursor("live-a"), cursor("idle-a"), cursor("idle-b")],
      sessions: {
        "live-a": session({ id: "live-a" }),
        "idle-a": idleSession("idle-a"),
        "idle-b": idleSession("idle-b"),
      },
    });

    const response = await getSharedAgentSessions(source, {
      quality: "all",
      limit: 25,
    });

    assert.equal(response.total, 3);
    assert.deepEqual(response.items.map((item) => item.id).sort(), [
      "idle-a",
      "idle-b",
      "live-a",
    ]);
    // Already revealing idle rows → nothing is hidden.
    assert.equal(response.idleCount, 0);
  });

  // FEA-4145: the `idle` segment isolates ONLY the idle (phantom) rows — the
  // complement of `substantive`. Like `substantive` it is not SQL-expressible on
  // desktop, so it forces the full-hydration path where the shared
  // `isSessionVisibleForQuality` SSOT is applied. Idle rows are the RESULT here
  // (not hidden), so nothing is bucketed into idleCount — that reveal is scoped
  // to the `substantive` segment.
  test("quality=idle returns only idle rows and reports idleCount 0", async () => {
    const source = createFakeSource({
      cursorRows: [
        cursor("live-a"),
        cursor("idle-a"),
        cursor("idle-b"),
        cursor("live-b"),
      ],
      sessions: {
        "live-a": session({ id: "live-a" }),
        "idle-a": idleSession("idle-a"),
        "idle-b": idleSession("idle-b"),
        "live-b": session({ id: "live-b" }),
      },
    });

    const response = await getSharedAgentSessions(source, {
      quality: "idle",
      limit: 25,
    });

    // Forces the full-hydration path — not the SQL cursor page.
    assert.deepEqual(
      source.calls.map((call) => call.kind),
      ["listAllSessionCursorRows", "loadSyncedSessions"]
    );
    assert.deepEqual(response.items.map((item) => item.id).sort(), [
      "idle-a",
      "idle-b",
    ]);
    assert.equal(response.total, 2);
    // Idle rows are the visible result, not a hidden set → idleCount 0.
    assert.equal(response.idleCount, 0);
  });

  test("a tool-use-only session (no turns / no tokens) is substantive", async () => {
    const toolOnly: SyncedAgentSession = {
      ...session({ id: "tool-only" }),
      turns: null,
      tokenUsageByModel: [],
      events: [
        {
          externalEventId: "tool-only-tool",
          eventType: "tool_use",
          toolName: "Bash",
          createdAt: "2026-01-01T00:05:00.000Z",
        },
      ],
    };
    const source = createFakeSource({
      cursorRows: [cursor("tool-only"), cursor("idle-a")],
      sessions: {
        "tool-only": toolOnly,
        "idle-a": idleSession("idle-a"),
      },
    });

    const response = await getSharedAgentSessions(source, {
      quality: "substantive",
      limit: 25,
    });

    assert.deepEqual(
      response.items.map((item) => item.id),
      ["tool-only"]
    );
    assert.equal(response.idleCount, 1);
  });

  test("owner dot color resolves from the org directory (FEA-3456) and is null when unresolved", async () => {
    resetOrgDirectoryCacheForTest();
    const alex = {
      id: "user-alex",
      email: "alex@example.com",
      firstName: "Alex",
      lastName: "Doe",
      avatarUrl: null,
    };
    const usersFetch = (async () =>
      new Response(JSON.stringify({ success: true, data: [alex] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    try {
      await ensureOrgDirectory({
        getApiOrigin: () => "https://api.test",
        getApiKey: () => "sk_live_test",
        fetchImpl: usersFetch,
      });

      const source = createFakeSource({
        cursorRows: [cursor("owned"), cursor("ghost")],
        sessions: {
          owned: session({ id: "owned", userId: "user-alex" }),
          // A userId with no directory entry stays unattributed on both fields.
          ghost: session({ id: "ghost", userId: "user-missing" }),
        },
      });

      const response = await getSharedAgentSessions(source, { limit: 25 });
      const owned = response.items.find((item) => item.id === "owned");
      const ghost = response.items.find((item) => item.id === "ghost");

      assert.equal(owned?.user?.id, "user-alex");
      // Owner color derives from the shared buildUserColor SSOT, not hardcoded null.
      assert.equal(owned?.userColor, buildUserColor(alex));
      assert.match(owned?.userColor ?? "", HSL_COLOR_PATTERN);

      assert.equal(ghost?.user, null);
      assert.equal(ghost?.userColor, null);
    } finally {
      resetOrgDirectoryCacheForTest();
    }
  });
});

// FEA-4157: the Sessions table + summary cards share ONE combined list + usage
// read (the desktop counterpart of the Branches `pageData` handler) so both come
// from one raw scan. The usage half must stay the cheap metadata-only SQL
// aggregate (COUNT/SUM/GROUP BY via `aggregateUsage`), never a full-corpus
// hydrate for the cards.
describe("getSharedAgentSessionsPageData (FEA-4157 combined read)", () => {
  test("returns the paginated list plus the usage summary from one call", async () => {
    const source = createFakeSource({
      cursorRows: [cursor("session-a"), cursor("session-b")],
      aggregateUsage: () =>
        usageAggregate({
          totalSessions: 2,
          harnessSessionCounts: [{ harness: "claude", sessionCount: 2 }],
        }),
    });

    const pageData = await getSharedAgentSessionsPageData(source, { limit: 1 });

    // The list half is the same paginated read `getSharedAgentSessions` performs.
    assert.equal(pageData.list.total, 2);
    assert.equal(pageData.list.items.length, 1);
    // The usage half is folded from the SQL aggregate.
    assert.equal(pageData.usage?.totalSessions, 2);
    assert.equal(pageData.usageError, undefined);
  });

  // FEA-4192: the summary session COUNT must mirror the quality-gated LIST total,
  // not the all-quality corpus. The list half applies the Substantive|Idle|All
  // segment (`matchesListQuery`); the usage half stays all-quality so its
  // token/cost totals match the SQL `aggregateUsage` (which cannot express the
  // substantive predicate on the column-less desktop `sessions` table). Left
  // unreconciled, the "Sessions" card counted the all-quality set while the list
  // showed the gated subset — a visible contradiction under any non-`all` segment.
  test("mirrors the quality-gated list total into the summary session count under a substantive segment", async () => {
    const idle = (id: string): SyncedAgentSession => ({
      ...session({ id }),
      turns: null,
      events: [],
      tokenUsageByModel: [],
    });
    const source = createFakeSource({
      cursorRows: [
        cursor("live-a"),
        cursor("idle-a"),
        cursor("idle-b"),
        cursor("live-b"),
      ],
      sessions: {
        "live-a": session({ id: "live-a" }),
        "idle-a": idle("idle-a"),
        "idle-b": idle("idle-b"),
        "live-b": session({ id: "live-b" }),
      },
      // The usage aggregate is all-quality: it counts every row (idle included),
      // so its raw totalSessions (4) DIFFERS from the substantive list total (2).
      // Token totals stay sourced from the all-quality aggregate by design.
      aggregateUsage: () =>
        usageAggregate({
          totalSessions: 4,
          tokenGroups: [
            {
              billingMode: null,
              harness: "claude",
              model: "claude",
              inputTokens: 1000,
              outputTokens: 500,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              sessionCount: 4,
              estimatedCostUsd: 2,
            },
          ],
          harnessSessionCounts: [{ harness: "claude", sessionCount: 4 }],
        }),
    });

    const pageData = await getSharedAgentSessionsPageData(source, {
      quality: "substantive",
      limit: 25,
    });

    // The list half hid the two idle rows.
    assert.equal(pageData.list.total, 2);
    // The "Sessions" card count now mirrors the list total, not the all-quality
    // aggregate's 4.
    assert.equal(pageData.usage?.totalSessions, 2);
    // Token/cost cards keep their all-quality basis — only the COUNT is reconciled.
    assert.equal(pageData.usage?.totalInputTokens, 1000);
    assert.equal(pageData.usage?.totalOutputTokens, 500);
  });

  // FEA-4177 — independent failure domains. A usage-aggregate failure must NOT
  // discard the list rows and error the whole table: the list is the required
  // half (returned), while the usage half degrades to `usageError: true`.
  test("resolves the list with usageError when only the usage aggregate fails", async () => {
    const source = createFakeSource({
      cursorRows: [cursor("session-a"), cursor("session-b")],
      aggregateUsage: () => {
        throw new Error("usage aggregate failed");
      },
    });

    const pageData = await getSharedAgentSessionsPageData(source, {
      limit: 25,
    });

    assert.equal(pageData.list.total, 2);
    assert.equal(pageData.usage, undefined);
    assert.equal(pageData.usageError, true);
    // A generic (non-lifecycle) usage failure is NOT transient: no marker, so the
    // renderer's cards stay in their honest error state.
    assert.equal(pageData.usageErrorTransient, undefined);
  });

  // ISS-4483 (review cid 3679616168, wongk): when the list wins the race and the
  // usage aggregate rejects with a TRANSIENT db-host lifecycle error (the child
  // restarting mid-backfill), the combined read still resolves (list rendered) but
  // additionally stamps `usageErrorTransient: true` so the renderer routes the
  // summary cards to the quiet reconnecting surface + bounded refetch instead of
  // the fatal dash. The list half is unaffected.
  test("marks a TRANSIENT usage-half failure with usageErrorTransient while the list renders", async () => {
    const source = createFakeSource({
      cursorRows: [cursor("session-a"), cursor("session-b")],
      aggregateUsage: () => {
        throw new Error("db-host exited (code: 1)");
      },
    });

    const pageData = await getSharedAgentSessionsPageData(source, {
      limit: 25,
    });

    assert.equal(pageData.list.total, 2);
    assert.equal(pageData.usage, undefined);
    assert.equal(pageData.usageError, true);
    assert.equal(pageData.usageErrorTransient, true);
  });

  test("serves the usage half from the metadata-only SQL aggregate, not a full-row hydrate", async () => {
    const source = createFakeSource({
      cursorRows: [cursor("session-a"), cursor("session-b")],
      aggregateUsage: (filters) =>
        usageAggregate({
          totalSessions: filters.statuses?.length ?? 2,
          harnessSessionCounts: [
            { harness: "claude", sessionCount: filters.statuses?.length ?? 2 },
          ],
        }),
    });

    const pageData = await getSharedAgentSessionsPageData(source, {
      statuses: ["completed", "failed"],
      limit: 25,
      offset: 0,
    });

    // FEA-4192: the summary session COUNT now mirrors the quality-gated list
    // total rather than the raw aggregate count. Every OTHER usage field still
    // flows straight from the aggregate untouched — the harness breakdown carries
    // the aggregate's own `filters.statuses.length` (2), proving the facet filters
    // were threaded into the aggregate SQL and its value reached the summary.
    assert.equal(pageData.usage?.totalSessions, pageData.list.total);
    assert.equal(pageData.usage?.byHarness[0]?.sessionCount, 2);
    // The usage half took the aggregate SQL path (COUNT/SUM/GROUP BY) with the
    // active facet filters — no pagination leaked into the aggregate, and no
    // second `loadSyncedSessions` hydrate ran to compute the summary.
    const aggregateCalls = source.calls.filter(
      (call) => call.kind === "aggregateUsage"
    );
    assert.equal(aggregateCalls.length, 1);
    assert.deepEqual(aggregateCalls[0]?.aggregateFilters, {
      dateWindowField: SESSIONS_SURFACE_DATE_WINDOW_FIELD,
      statuses: ["completed", "failed"],
    });
    // Exactly one hydrate — the list page — never a second one for the cards.
    const hydrateCalls = source.calls.filter(
      (call) => call.kind === "loadSyncedSessions"
    );
    assert.equal(hydrateCalls.length, 1);
  });

  test("degrades to the empty combined shape when the source is absent", async () => {
    const pageData = await getSharedAgentSessionsPageData(null);

    assert.equal(pageData.list.total, 0);
    assert.deepEqual(pageData.list.items, []);
    assert.equal(pageData.usage?.totalSessions, 0);
  });

  // PRD-536 E6 regression (FEA-4157): the combined read must thread the online-
  // aware compute target into the list half's pending-outbox lookup, exactly as
  // the standalone list handler does. Omitting it loads an empty pending set and
  // mislabels every pending-upload row as `synced`, hiding the badge once the
  // Sessions view reads through `pageData`.
  test("threads the compute target into the list half so pending-upload rows keep their badge", async () => {
    const source = createFakeSource({
      cursorRows: [cursor("session-a"), cursor("session-b")],
      // session-b is still enqueued (un-acked) in the sync outbox.
      pendingOutboxIds: ["session-b"],
    });

    const pageData = await getSharedAgentSessionsPageData(
      source,
      { quality: "all" },
      { computeTargetId: "target-123" }
    );

    // The outbox was consulted under the SAME source key the write side keys on.
    const outboxCall = source.calls.find(
      (call) => call.kind === "loadPendingOutboxIds"
    );
    assert.equal(outboxCall?.sourceKey, "agent_sessions:target-123");

    const byId = new Map(pageData.list.items.map((item) => [item.id, item]));
    assert.equal(byId.get("session-b")?.cloudSyncState, "pending");
    assert.equal(byId.get("session-a")?.cloudSyncState, "synced");
  });
});

// FEA-4299: the Repository filter's selectable options (usage `byRepository`)
// must include every repository value a row can render (its `repositoryFullName`,
// the same value the column shows), and filtering by that value must return the
// rows — so a visible repository is always filterable, and the filter never
// offers a value no row shows. The row display and the facet options derive from
// ONE source (`repositoryFullName`); a session with no resolved remote renders
// "Unknown" and is intentionally NOT a facet option.
describe("Repository filter options match the rendered repository (FEA-4299)", () => {
  const repoAlpha = "closedloop-ai/symphony-alpha";
  const repoBeta = "closedloop-ai/cl-tofu-aws-live";

  function repoSource() {
    return createFakeSource({
      cursorRows: [
        cursor("s-alpha-1"),
        cursor("s-alpha-2"),
        cursor("s-beta"),
        cursor("s-unknown"),
      ],
      sessions: {
        "s-alpha-1": session({
          id: "s-alpha-1",
          repositoryFullName: repoAlpha,
        }),
        "s-alpha-2": session({
          id: "s-alpha-2",
          repositoryFullName: repoAlpha,
        }),
        "s-beta": session({ id: "s-beta", repositoryFullName: repoBeta }),
        // No resolved remote: worktree/cwd is a synthetic machine folder (the
        // shape that produced the un-filterable folder-name rows). It renders
        // "Unknown" and must NOT become a facet option keyed to a folder name.
        "s-unknown": session({
          id: "s-unknown",
          repositoryFullName: null,
          worktreePath: "workspace/local-checkout/2",
          cwd: "workspace/local-checkout/2",
        }),
      },
    });
  }

  test("every rendered repository is offered as a filter option; folder-only rows are not", async () => {
    const source = repoSource();

    const usage = await getSharedAgentSessionUsage(source, {});
    const optionIds = usage.byRepository
      .map((entry) => entry.repositoryFullName)
      .sort();

    // Both rendered repositories are selectable options...
    assert.deepEqual(optionIds, [repoBeta, repoAlpha].sort());
    // ...keyed by the exact value the row renders (with the right count)...
    const alphaOption = usage.byRepository.find(
      (entry) => entry.repositoryFullName === repoAlpha
    );
    assert.equal(alphaOption?.sessionCount, 2);
    // ...and the folder-only "Unknown" row never leaks a folder-name option.
    assert.ok(
      !usage.byRepository.some((entry) =>
        entry.repositoryFullName.includes("local-checkout")
      )
    );

    // The rendered value the filter must agree with: the Repository column reads
    // `repositoryFullName`, which is present for the real repos and null (→
    // "Unknown") for the folder-only row.
    const list = await getSharedAgentSessions(source, {});
    const renderedRepos = new Set(
      list.items
        .map((item) => item.repositoryFullName)
        .filter((value): value is string => value !== null)
    );
    for (const rendered of renderedRepos) {
      assert.ok(
        optionIds.includes(rendered),
        `rendered repository ${rendered} must be a filter option`
      );
    }
  });

  test("filtering by an offered repository returns exactly the rows that render it", async () => {
    const source = repoSource();

    const filtered = await getSharedAgentSessions(source, {
      repositories: [repoAlpha],
    });

    assert.deepEqual(filtered.items.map((item) => item.id).sort(), [
      "s-alpha-1",
      "s-alpha-2",
    ]);
    for (const item of filtered.items) {
      assert.equal(item.repositoryFullName, repoAlpha);
    }
  });

  test("a folder-only value the filter never offers cannot select the Unknown row", async () => {
    const source = repoSource();

    // Simulate a client attempting to filter by the pre-fix folder-name value
    // the row used to display: it is not an option, and it must match no rows
    // (the Unknown row is unreachable by an explicit repository filter, mirroring
    // the cloud `where.repositoryFullName = { in: [...] }` which excludes nulls).
    const filtered = await getSharedAgentSessions(source, {
      repositories: ["workspace/local-checkout/2"],
    });

    assert.deepEqual(filtered.items, []);
  });

  // FEA-4299/FEA-4330: the repository sort keeps the "Unknown" (null
  // repositoryFullName) row LAST in BOTH directions, matching the cloud's
  // `nulls: "last"` ORDER BY. Coercing null to "" sorted it FIRST ascending —
  // the shafty023 regression this covers.
  test("repository sort keeps the Unknown row last in both directions", async () => {
    // repoBeta ("closedloop-ai/cl-tofu-aws-live") sorts before repoAlpha
    // ("closedloop-ai/symphony-alpha") by name; the null-repo row is Unknown.
    const ascending = await getSharedAgentSessions(repoSource(), {
      sortBy: "repo",
      sortDir: "asc",
    });
    assert.deepEqual(
      ascending.items.map((item) => item.repositoryFullName),
      [repoBeta, repoAlpha, repoAlpha, null]
    );

    const descending = await getSharedAgentSessions(repoSource(), {
      sortBy: "repo",
      sortDir: "desc",
    });
    assert.deepEqual(
      descending.items.map((item) => item.repositoryFullName),
      [repoAlpha, repoAlpha, repoBeta, null]
    );
    // The Unknown row is LAST in both directions (not floated to the top on asc).
    assert.equal(ascending.items.at(-1)?.id, "s-unknown");
    assert.equal(descending.items.at(-1)?.id, "s-unknown");
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
