/**
 * @file session-created-at-sync-payload.test.ts
 * @description ISS-12251 (PLN-2176 T-6.6): the upload carries
 * `sessions.created_at` as `createdAt`, and omits the key for a NULL column —
 * never `null`. Both upload paths that read the session row are covered: the
 * sync drain (`hydrateSyncCandidates` → `prepareAgentSessionPayload`, the egress
 * sanitizer included) and the oversize probe, which must size the same field
 * the drain ships. Drives the real SQLite source.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, it } from "vitest";
import { hydrateSyncCandidates } from "../src/main/agent-sync/agent-session-hydration-budget.js";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { prepareAgentSessionPayload } from "../src/main/agent-sync/agent-session-sync-payload.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { findSqliteLocallyOversizedSessions } from "../src/main/database/sync-source-session-rows.js";

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const NOW = "2026-10-14T12:00:00.000Z";
const STARTED_AT = "2026-10-14T10:00:00.000Z";
const CREATED_AT = "2026-10-13T08:30:00.000Z";
/** Same length, so the two payloads differ only by the `createdAt` member. */
const WITH_CREATED_AT = "ses-created-at-1";
const WITHOUT_CREATED_AT = "ses-created-at-0";
const IDS = [WITH_CREATED_AT, WITHOUT_CREATED_AT];
const MAX_PAYLOAD_BYTES = 256 * 1024;

async function withSeededStore(run: (db: Db) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "iss12251-sync-created-at-")
  );
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  try {
    await db.run(
      `INSERT INTO sessions
         (id, status, started_at, updated_at, last_activity_at, created_at)
       VALUES
         ('${WITH_CREATED_AT}', '${SESSION_STATUS.INACTIVE}', '${STARTED_AT}', '${STARTED_AT}', '${STARTED_AT}', '${CREATED_AT}'),
         ('${WITHOUT_CREATED_AT}', '${SESSION_STATUS.INACTIVE}', '${STARTED_AT}', '${STARTED_AT}', '${STARTED_AT}', NULL)`
    );
    await run(db);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Each session exactly as the sync lane would send it. */
async function wirePayloads(db: Db): Promise<Map<string, SyncedAgentSession>> {
  const { sessions } = await hydrateSyncCandidates(db.syncSource, IDS, {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  });
  const byId = new Map<string, SyncedAgentSession>();
  for (const session of sessions) {
    const prepared = prepareAgentSessionPayload(session, MAX_PAYLOAD_BYTES);
    if (prepared.kind !== "session") {
      throw new Error(`expected a whole session payload, got ${prepared.kind}`);
    }
    byId.set(prepared.session.externalSessionId, prepared.session);
  }
  return byId;
}

describe("ISS-12251: the sync payload carries createdAt", () => {
  it("the sync drain sends createdAt, and omits it for a NULL column", async () => {
    await withSeededStore(async (db) => {
      const payloads = await wirePayloads(db);

      assert.equal(payloads.get(WITH_CREATED_AT)?.createdAt, CREATED_AT);
      const without = payloads.get(WITHOUT_CREATED_AT);
      assert.ok(without);
      assert.equal(Object.hasOwn(without, "createdAt"), false);
    });
  });

  it("the oversize probe sizes the createdAt member the drain ships", async () => {
    await withSeededStore(async (db) => {
      // A 1-byte cap reports every session with the size it measured.
      const sized = await findSqliteLocallyOversizedSessions(db.prisma, IDS, 1);
      const bytes = new Map(sized.map((row) => [row.id, row.payloadBytes]));
      const withBytes = bytes.get(WITH_CREATED_AT);
      const withoutBytes = bytes.get(WITHOUT_CREATED_AT);
      assert.ok(withBytes !== undefined && withoutBytes !== undefined);

      const member = `,${JSON.stringify({ createdAt: CREATED_AT }).slice(1, -1)}`;
      assert.equal(withBytes - withoutBytes, Buffer.byteLength(member));
    });
  });
});
