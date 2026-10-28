import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SESSION_COST_BUCKETS,
  SessionChangePresenceId,
  SessionPrAssociationId,
} from "@repo/api/src/agent-session-filters";
import { SessionListField } from "@repo/api/src/types/list-query-fields";
import { ArtifactRefMethod } from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { test } from "vitest";
import { SessionListCursorSortKey } from "../src/main/agent-sync/agent-session-read-model.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { getSharedAgentSessions } from "../src/main/session/shared-agent-sessions-api.js";
import {
  insertSqliteAgent,
  insertSqliteEvent,
  insertSqlitePrArtifact,
  insertSqliteSession,
} from "./sqlite-session-fixtures.js";

const MISSING_LINK_EVIDENCE_COLUMN = /no such column: sal\.evidence/;

test("production list projection never enters sync-session hydration", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss-10574-projection-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "store"),
    detectBillingMode: () => "api",
    now: () => "2026-09-21T12:00:00.000Z",
  });
  try {
    await insertSqliteSession(db, "iss-10574-active", {
      name: "ISS-10574 projected active",
      status: "active",
      startedAt: "2026-09-21T11:00:00.000Z",
      updatedAt: "2026-09-21T11:30:00.000Z",
      metadata: JSON.stringify({
        diffStats: { linesAdded: 10, linesRemoved: 2, filesChanged: 1 },
        userMessages: 1,
        assistantMessages: 2,
        messages: [
          { role: "human", timestamp: "2026-09-21T11:00:00.000Z" },
          { role: "assistant", timestamp: "2026-09-21T11:05:00.000Z" },
          { role: "human", timestamp: "2026-09-21T11:25:00.000Z" },
        ],
      }),
    });
    await db.run(
      "UPDATE sessions SET repo_full_name = $1, user_id = $2 WHERE id = $3",
      "closedloop-ai/closedloop-ai",
      "owner-a",
      "iss-10574-active"
    );
    await insertSqliteEvent(db, "iss-10574-active", "2026-09-21T11:15:00.000Z");
    await insertSqliteAgent(db, "iss-10574-active", "iss-10574-agent");
    await insertSqliteAgent(db, "iss-10574-active", "iss-10574-agent-2");
    await db.run(
      `UPDATE events SET event_type = 'tool_error', tool_name = 'Bash'
       WHERE session_id = $1`,
      "iss-10574-active"
    );
    await insertSqliteEvent(db, "iss-10574-active", "2026-09-21T11:18:00.000Z");
    await db.run(
      `UPDATE events
          SET event_type = 'provider_rate_limit', summary = 'rate limited'
        WHERE session_id = $1 AND created_at = $2`,
      "iss-10574-active",
      "2026-09-21T11:18:00.000Z"
    );
    await insertSqliteEvent(db, "iss-10574-active", "2026-09-21T11:24:00.000Z");
    await db.run(
      `UPDATE events
          SET event_type = 'change_request', summary = 'please revise'
        WHERE session_id = $1 AND created_at = $2`,
      "iss-10574-active",
      "2026-09-21T11:24:00.000Z"
    );
    await db.run(
      `INSERT INTO token_usage
         (session_id, model, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, baseline_input, cost_usd_estimated)
       VALUES ($1, 'gpt-5', 100, 50, 25, 10, 5, 0.42)`,
      "iss-10574-active"
    );
    await db.run(
      `INSERT INTO token_events
         (session_id, transport_id, model, created_at, input_tokens,
          output_tokens, cache_read_tokens, cache_write_tokens,
          cost_usd_estimated)
       VALUES ($1, 'list-trace', 'gpt-5', $2, 100, 50, 25, 10, 0.42)`,
      "iss-10574-active",
      "2026-09-21T11:20:00.000Z"
    );
    await db.run(
      `INSERT INTO token_events
         (session_id, transport_id, model, created_at, input_tokens,
          output_tokens, cache_read_tokens, cache_write_tokens,
          input_cost_usd_estimated, output_cost_usd_estimated)
       VALUES ($1, 'list-trace-2', 'gpt-5-mini', $2, 25, 10, 5, 2, 0.1, 0.2)`,
      "iss-10574-active",
      "2026-09-21T11:22:00.000Z"
    );
    await db.run(
      `WITH RECURSIVE seq(n) AS (
         SELECT 1
         UNION ALL
         SELECT n + 1 FROM seq WHERE n < 513
       )
       INSERT INTO token_events
         (session_id, transport_id, model, created_at, input_tokens,
          input_cost_usd_estimated)
       SELECT $1, NULL, 'gpt-boundary', $2, n, n / 1000000.0 FROM seq`,
      "iss-10574-active",
      "2026-09-21T11:23:00.000Z"
    );
    await db.run(
      `INSERT INTO session_viewership (session_id, first_viewed_at)
       VALUES ($1, $2)`,
      "iss-10574-active",
      "2026-09-21T11:28:00.000Z"
    );
    await db.run(
      "UPDATE sessions SET last_activity_at = 'not-a-date' WHERE id = $1",
      "iss-10574-active"
    );
    await insertSqlitePrArtifact(db, "iss-10574-active", {
      repoFullName: "closedloop-ai/closedloop-ai",
      prNumber: 8074,
      relation: "workspace",
    });
    await db.run(
      "UPDATE session_artifact_links SET method = $1 WHERE session_id = $2",
      ArtifactRefMethod.HarnessPrLink,
      "iss-10574-active"
    );
    await insertSqliteSession(db, "iss-10574-inactive", {
      name: "ISS-10574 projected inactive",
      status: "inactive",
      startedAt: "2026-09-21T10:00:00.000Z",
      updatedAt: "2026-09-21T10:30:00.000Z",
      endedAt: "2026-09-21T10:20:00.000Z",
    });
    await insertSqliteEvent(
      db,
      "iss-10574-inactive",
      "2026-09-21T10:15:00.000Z"
    );
    const cases: Array<{
      request: NonNullable<Parameters<typeof getSharedAgentSessions>[1]>;
      ids: string[];
      total: number;
    }> = [
      {
        request: {
          statuses: [SESSION_STATUS.ACTIVE],
          search: "projected active",
          quality: "all",
          limit: 25,
          offset: 0,
        },
        ids: ["iss-10574-active"],
        total: 1,
      },
      {
        request: {
          quality: "all",
          sortBy: SessionListCursorSortKey.LastActivity,
          sortDir: "desc",
          limit: 1,
          offset: 0,
        },
        ids: ["iss-10574-active"],
        total: 2,
      },
      {
        request: {
          quality: "all",
          sortBy: SessionListCursorSortKey.LastActivity,
          sortDir: "desc",
          limit: 1,
          offset: 1,
        },
        ids: ["iss-10574-inactive"],
        total: 2,
      },
      {
        request: {
          statuses: [SESSION_STATUS.INACTIVE],
          quality: "all",
          limit: 25,
          offset: 0,
        },
        ids: ["iss-10574-inactive"],
        total: 1,
      },
      {
        request: {
          quality: "substantive",
          sortBy: SessionListField.Cost,
          sortDir: "desc",
          limit: 25,
          offset: 0,
        },
        ids: ["iss-10574-active"],
        total: 1,
      },
      {
        request: {
          quality: "all",
          prAssociation: [SessionPrAssociationId.HasPr],
          limit: 25,
          offset: 0,
        },
        ids: ["iss-10574-active"],
        total: 1,
      },
      {
        request: {
          ids: ["iss-10574-inactive", "iss-10574-active"],
          quality: "all",
          limit: 25,
          offset: 0,
        },
        ids: ["iss-10574-inactive", "iss-10574-active"],
        total: 2,
      },
      {
        request: {
          ids: ["iss-10574-inactive", "iss-10574-active"],
          startDate: "2026-09-21T11:20:00.000Z",
          quality: "all",
          sortBy: SessionListCursorSortKey.LastActivity,
          sortDir: "desc",
          limit: 1,
          offset: 0,
        },
        ids: ["iss-10574-active"],
        total: 1,
      },
      {
        request: {
          ids: ["iss-10574-inactive", "iss-10574-active"],
          quality: "all",
          sortBy: SessionListCursorSortKey.LastActivity,
          sortDir: "desc",
          limit: 1,
          offset: 1,
        },
        ids: ["iss-10574-inactive"],
        total: 2,
      },
      {
        request: {
          quality: "idle",
          limit: 25,
          offset: 0,
        },
        ids: ["iss-10574-inactive"],
        total: 1,
      },
      {
        request: {
          repositories: ["closedloop-ai/closedloop-ai"],
          userIds: ["owner-a"],
          harnesses: ["codex"],
          models: ["gpt-5"],
          quality: "all",
          limit: 25,
          offset: 0,
        },
        ids: ["iss-10574-active"],
        total: 1,
      },
      {
        request: {
          changePresence: [SessionChangePresenceId.HasChanges],
          costBuckets: [SESSION_COST_BUCKETS[0].id],
          quality: "all",
          limit: 25,
          offset: 0,
        },
        ids: ["iss-10574-active"],
        total: 1,
      },
      {
        request: {
          completedAfter: "2026-09-21T10:00:00.000Z",
          quality: "all",
          limit: 25,
          offset: 0,
        },
        ids: ["iss-10574-inactive"],
        total: 1,
      },
      {
        request: {
          statuses: [SESSION_STATUS.ACTIVE],
          quality: "all",
          countOnly: true,
          limit: 0,
          offset: 0,
        },
        ids: [],
        total: 1,
      },
    ];
    const canonical = await Promise.all(
      cases.map(({ request }) => getSharedAgentSessions(db.syncSource, request))
    );
    // Remove inputs the list is forbidden to hydrate after capturing the
    // canonical response. The private sync loader still reads these relations.
    await db.prisma.write(async (writer) => {
      await writer.$executeRawUnsafe("DROP TABLE session_activity_segments");
      await writer.$executeRawUnsafe("DROP TABLE session_analytics");
      await writer.$executeRawUnsafe("DROP TABLE session_activity_metrics");
      await writer.$executeRawUnsafe("ALTER TABLE agents DROP COLUMN metadata");
      await writer.$executeRawUnsafe("ALTER TABLE events DROP COLUMN data");
      await writer.$executeRawUnsafe(
        "ALTER TABLE token_events DROP COLUMN cost_summary"
      );
      await writer.$executeRawUnsafe(
        "ALTER TABLE token_events DROP COLUMN source_identity"
      );
    });
    db.syncSource.loadSyncedSessions = () => {
      throw new Error("heavy sync hydration must not serve list projection");
    };
    for (const [index, { request, ids, total }] of cases.entries()) {
      const response = await db.syncSource.projectSessionList?.({
        request,
        computeTargetId: null,
        users: [],
      });
      assert.ok(response);
      const {
        pendingOutboxAvailable,
        queryExecution,
        queryMatchedCount,
        queryScannedCount,
        ...projected
      } = response;
      assert.notEqual(queryExecution, undefined);
      assert.equal(queryMatchedCount, total);
      if (queryExecution === "hydrated_fallback") {
        assert.ok(queryScannedCount !== undefined);
        assert.ok(queryScannedCount >= queryMatchedCount);
      } else {
        assert.equal(queryScannedCount, undefined);
      }
      assert.deepEqual(projected, canonical[index]);
      assert.equal(pendingOutboxAvailable, false);
      assert.equal(response.total, total);
      assert.deepEqual(
        response.items.map((item) => item.externalSessionId),
        ids
      );
      assert.equal(response.viewerScope, "self");
      if (index === 0) {
        assert.equal(response.items[0]?.agentCount, 2);
        assert.equal(response.items[0]?.toolUseCount, 1);
        assert.equal(response.items[0]?.errorCount, 1);
        assert.equal(response.items[0]?.inputTokens, 105);
        assert.equal(response.items[0]?.prs?.length, 1);
        assert.equal(
          response.items[0]?.lastActivityAt.toISOString(),
          "2026-09-21T11:24:00.000Z"
        );
      }
    }
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("list omits link evidence while sync hydration still reads it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss-10574-link-evidence-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "store"),
    detectBillingMode: () => "api",
  });
  try {
    await insertSqliteSession(db, "iss-10574-link-evidence", {
      name: "Link evidence projection",
      status: "active",
      startedAt: "2026-09-21T11:00:00.000Z",
      updatedAt: "2026-09-21T11:30:00.000Z",
    });
    await db.prisma.write((writer) =>
      writer.$executeRawUnsafe(
        "ALTER TABLE session_artifact_links DROP COLUMN evidence"
      )
    );
    const response = await db.syncSource.projectSessionList?.({
      request: { quality: "all", limit: 10, offset: 0 },
      computeTargetId: null,
      users: [],
    });
    assert.equal(
      response?.items[0]?.externalSessionId,
      "iss-10574-link-evidence"
    );
    await assert.rejects(async () => {
      await db.syncSource.loadSyncedSessions(["iss-10574-link-evidence"], {
        attributionByCwd: new Map(),
        launchMetadataRootByCwd: new Map(),
        repoFullNameByPath: new Map(),
      });
    }, MISSING_LINK_EVIDENCE_COLUMN);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
