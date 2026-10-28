/**
 * ISS-12251 (PLN-2176 T-6.5): Desktop's local list and detail reads serve
 * `createdAt` from `sessions.created_at` when the row holds one, and omit the
 * key when it is NULL — never null, never a fabricated value. Since T-6.6 the
 * sync drain reads it too (`session-created-at-sync-payload.test.ts` pins the
 * wire). Drives the real SQLite source.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { BasicUser } from "@repo/api/src/types/user";
import { describe, it } from "vitest";
import { hydrateSyncCandidates } from "../src/main/agent-sync/agent-session-hydration-budget.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { getSharedAgentSessionDetail } from "../src/main/session/shared-agent-session-detail-read.js";
import {
  getSharedAgentSessions,
  getSharedAgentSessionsByIds,
  getSharedAgentSessionsWithLocCostByIds,
} from "../src/main/session/shared-agent-sessions-api.js";

const NOW = "2026-10-14T12:00:00.000Z";
const STARTED_AT = "2026-10-14T10:00:00.000Z";
const CREATED_AT = "2026-10-13T08:30:00.000Z";
const WITH_CREATED_AT = "ses-with-created-at";
const WITHOUT_CREATED_AT = "ses-without-created-at";
const IDS = [WITH_CREATED_AT, WITHOUT_CREATED_AT];
const CREATOR: BasicUser = {
  id: "user-local-creator",
  email: "creator@example.test",
  firstName: "Local",
  lastName: "Creator",
  avatarUrl: null,
};

function emptyAttributionCache() {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}

async function withSeededStore(
  run: (
    db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>
  ) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss12251-created-at-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  try {
    await db.run(
      `INSERT INTO sessions
         (id, status, user_id, started_at, updated_at, last_activity_at, created_at)
       VALUES
         ('${WITH_CREATED_AT}', '${SESSION_STATUS.INACTIVE}', '${CREATOR.id}', '${STARTED_AT}', '${STARTED_AT}', '${STARTED_AT}', '${CREATED_AT}'),
         ('${WITHOUT_CREATED_AT}', '${SESSION_STATUS.INACTIVE}', '${CREATOR.id}', '${STARTED_AT}', '${STARTED_AT}', '${STARTED_AT}', NULL)`
    );
    await run(db);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function byExternalId<T extends { externalSessionId: string }>(
  items: readonly T[]
): Map<string, T> {
  return new Map(items.map((item) => [item.externalSessionId, item]));
}

describe("Desktop local createdAt read (ISS-12251 T-6.5)", () => {
  it("the DB-host list projection serves createdAt, and the local creator as Owner", async () => {
    await withSeededStore(async (db) => {
      const response = await db.syncSource.projectSessionList?.({
        request: { ids: IDS },
        computeTargetId: null,
        users: [CREATOR],
      });
      const items = byExternalId(response?.items ?? []);

      assert.equal(items.get(WITH_CREATED_AT)?.createdAt, CREATED_AT);
      assert.deepEqual(items.get(WITH_CREATED_AT)?.assignee, CREATOR);
      assert.deepEqual(items.get(WITH_CREATED_AT)?.createdBy, CREATOR);
      const withoutCreatedAt = items.get(WITHOUT_CREATED_AT);
      assert.ok(withoutCreatedAt);
      assert.equal(Object.hasOwn(withoutCreatedAt, "createdAt"), false);
    });
  });

  it("the main-process list read serves createdAt only for a non-NULL column", async () => {
    await withSeededStore(async (db) => {
      const response = await getSharedAgentSessions(
        db.syncSource,
        { ids: IDS },
        { orgDirectory: new Map([[CREATOR.id, CREATOR]]) }
      );
      const items = byExternalId(response.items);

      assert.equal(items.get(WITH_CREATED_AT)?.createdAt, CREATED_AT);
      const withoutCreatedAt = items.get(WITHOUT_CREATED_AT);
      assert.ok(withoutCreatedAt);
      assert.equal(Object.hasOwn(withoutCreatedAt, "createdAt"), false);
    });
  });

  it("the detail and by-id reads serve createdAt", async () => {
    await withSeededStore(async (db) => {
      const detail = await getSharedAgentSessionDetail(
        db.syncSource,
        WITH_CREATED_AT
      );
      const emptyDetail = await getSharedAgentSessionDetail(
        db.syncSource,
        WITHOUT_CREATED_AT
      );
      const byIds = await getSharedAgentSessionsByIds(db.syncSource, [
        WITH_CREATED_AT,
      ]);
      const withLocCost = await getSharedAgentSessionsWithLocCostByIds(
        db.syncSource,
        IDS
      );
      const locCostItems = byExternalId(withLocCost.items);

      assert.equal(detail?.createdAt, CREATED_AT);
      assert.ok(emptyDetail);
      assert.equal(Object.hasOwn(emptyDetail, "createdAt"), false);
      assert.equal(byIds[0]?.createdAt, CREATED_AT);
      assert.equal(locCostItems.get(WITH_CREATED_AT)?.createdAt, CREATED_AT);
      const locCostWithout = locCostItems.get(WITHOUT_CREATED_AT);
      assert.ok(locCostWithout);
      assert.equal(Object.hasOwn(locCostWithout, "createdAt"), false);
    });
  });

  it("the sync drain's hydration reads createdAt (T-6.6)", async () => {
    await withSeededStore(async (db) => {
      const { sessions } = await hydrateSyncCandidates(
        db.syncSource,
        [WITH_CREATED_AT],
        emptyAttributionCache()
      );

      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.createdAt, CREATED_AT);
    });
  });
});
