/**
 * @file write-core-import-phases-session-coverage.test.ts
 * @description ISS-8730 coverage for `importPhaseSessionAndMainAgent`
 * (`write-core-import-phases-session.ts`) — the gating record-group-1 write.
 *
 * `import-reimport-idempotent.test.ts` already covers the new-session
 * `agents.id` collision recovery (same-session and cross-session), and
 * `session-terminal-end-advance.test.ts` already covers the ALREADY-terminal
 * reconciliation (`reconcileTerminalSession`, a sibling module this phase
 * delegates to). Neither exercises what this file pins: the existing-row
 * content-change gate itself (FEA-3578 name fresh-wins vs cwd first-wins-sticky,
 * FEA-4376 model-upgrade-is-content), the revision-only heal branch that stamps
 * `data_revision` WITHOUT bumping the sync watermark, the reactivation branch
 * (terminal → active), the standalone `ends_with_error` refresh on an
 * already-live re-import, the new-session branch's status/ends_with_error/
 * awaiting_input_since derivation, and the raw
 * `{existed, reactivated, sessionDataChanged, revisionStamped}` contract the
 * function returns to its caller.
 *
 * Driven against a real SQLite store (matching the sibling
 * `write-core-import-phases.test.ts` pattern), not a mocked transaction: this
 * phase IS a sequence of raw conditional SQL UPDATE/INSERT statements, which a
 * hand-rolled recording mock cannot faithfully evaluate.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, test } from "vitest";
import { effectiveDataRevision } from "../src/main/collectors/engine/effective-data-revision.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { Harness } from "../src/main/collectors/types.js";
import {
  DESKTOP_AGENT_STATUS,
  RECENT_ACTIVITY_MS,
} from "../src/main/database/db-constants.js";
import { buildImportSessionContext } from "../src/main/database/import-session-context.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { importPhaseSessionAndMainAgent } from "../src/main/database/write-core-import-phases-session.js";
import { effectiveParsePolicy } from "../src/main/parse-policy/effective-parse-policy.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { emptyAttributionCache } from "./attribution-test-helpers.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-06-07T12:00:00.000Z";
const STARTED_AT = "2026-06-07T10:00:00.000Z";
const ENDED_AT = "2026-06-07T10:30:00.000Z";
/** Inside RECENT_ACTIVITY_MS of NOW, so a session carrying it reads as live. */
const RECENT_FILE_MTIME_MS = Date.parse(NOW) - RECENT_ACTIVITY_MS / 2;
/** Outside RECENT_ACTIVITY_MS of NOW. */
const STALE_FILE_MTIME_MS = Date.parse(NOW) - RECENT_ACTIVITY_MS * 10;

async function withDb(
  label: string,
  run: (db: SqliteAgentDatabase) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), label));
  const db = await openTestDb(dir, { now: () => NOW });
  try {
    await run(db);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Call `importPhaseSessionAndMainAgent` directly against a real transaction,
 * mirroring the `runDerivedRollups` helper in `write-core-import-phases.test.ts`.
 */
async function runSessionPhase(
  db: SqliteAgentDatabase,
  session: NormalizedSession,
  now: string,
  revisionToStamp?: number
) {
  const ctx = buildImportSessionContext(
    db.tokenUsage,
    { detectBillingMode: () => "unknown", log: () => {} },
    session,
    Harness.Claude,
    now,
    emptyAttributionCache(),
    effectiveParsePolicy()
  );
  return await db.prisma.write((client) =>
    client.$transaction((tx) =>
      importPhaseSessionAndMainAgent(tx, ctx, revisionToStamp)
    )
  );
}

async function querySessionRow(db: SqliteAgentDatabase, sessionId: string) {
  const rows = await db.prisma.client.$queryRawUnsafe<
    Array<{
      status: string;
      name: string;
      cwd: string | null;
      model: string | null;
      ended_at: string | null;
      updated_at: string;
      data_revision: number;
      ends_with_error: number;
    }>
  >(
    "SELECT status, name, cwd, model, ended_at, updated_at, data_revision, ends_with_error FROM sessions WHERE id = $1",
    sessionId
  );
  return rows[0];
}

async function queryMainAgentRow(db: SqliteAgentDatabase, sessionId: string) {
  const rows = await db.prisma.client.$queryRawUnsafe<
    Array<{
      status: string;
      ended_at: string | null;
      current_tool: string | null;
      awaiting_input_since: string | null;
    }>
  >(
    "SELECT status, ended_at, current_tool, awaiting_input_since FROM agents WHERE id = $1",
    `${sessionId}-main`
  );
  return rows[0];
}

describe("ISS-8730 importPhaseSessionAndMainAgent coverage", () => {
  test("a fresh name wins on reimport (FEA-3578) while cwd stays first-wins sticky", async () => {
    await withDb("iss8730-name-cwd-", async (db) => {
      const sessionId = "iss8730-name-cwd";
      const session1 = makeSession({
        sessionId,
        name: "Original Title",
        cwd: "/first/cwd",
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
      });
      await db.importer.importSession(session1, Harness.Claude);

      const session2: NormalizedSession = {
        ...session1,
        name: "Updated Title",
        cwd: "/second/cwd",
      };
      const second = await db.importer.importSession(session2, Harness.Claude);

      const row = await querySessionRow(db, sessionId);
      assert.equal(
        row?.name,
        "Updated Title",
        "the freshly-parsed name must win over the stored one"
      );
      assert.equal(
        row?.cwd,
        "/first/cwd",
        "cwd is first-wins sticky and must not move on reimport"
      );
      assert.equal(
        second.skipped,
        false,
        "a name change is a content change, not a no-op"
      );
    });
  });

  test("a real assistant model id upgrades a stored /model fallback label and counts as a content change", async () => {
    await withDb("iss8730-model-upgrade-", async (db) => {
      const sessionId = "iss8730-model-upgrade";
      const session1 = makeSession({
        sessionId,
        model: "/model opus label",
        modelIsFallback: true,
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
      });
      await db.importer.importSession(session1, Harness.Claude);
      assert.equal(
        (await querySessionRow(db, sessionId))?.model,
        "/model opus label",
        "precondition: the fallback label was actually stored"
      );

      const session2: NormalizedSession = {
        ...session1,
        model: "claude-opus-4-5",
        modelIsFallback: false,
      };
      const second = await db.importer.importSession(session2, Harness.Claude);

      const row = await querySessionRow(db, sessionId);
      assert.equal(
        row?.model,
        "claude-opus-4-5",
        "a real assistant model id must overwrite a stored /model fallback label"
      );
      assert.equal(
        second.skipped,
        false,
        "a model upgrade is a content change even though buildImportMetadata omits model"
      );
    });
  });

  test("a stale data_revision heals on an otherwise-unchanged reimport without bumping the sync watermark", async () => {
    await withDb("iss8730-revision-heal-", async (db) => {
      const sessionId = "iss8730-revision-heal";
      const session = makeSession({
        sessionId,
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
      });
      const staleRevision = effectiveDataRevision() - 1;

      const created = await runSessionPhase(db, session, NOW, staleRevision);
      assert.equal(created.existed, false);
      assert.equal(created.revisionStamped, true);
      const afterCreate = await querySessionRow(db, sessionId);
      assert.equal(afterCreate?.data_revision, staleRevision);

      // Reimport the BYTE-IDENTICAL session at the current DATA_REVISION (the
      // default `revisionToStamp`). Content is unchanged, so this must take the
      // revision-only heal branch, not the content-changed branch.
      const healed = await runSessionPhase(
        db,
        session,
        "2026-06-07T13:00:00.000Z"
      );

      assert.equal(healed.existed, true);
      assert.equal(
        healed.sessionDataChanged,
        false,
        "an unchanged reimport must not report a content change"
      );
      assert.equal(
        healed.revisionStamped,
        true,
        "a stale data_revision must still be healed"
      );
      const afterHeal = await querySessionRow(db, sessionId);
      assert.equal(afterHeal?.data_revision, effectiveDataRevision());
      assert.equal(
        afterHeal?.updated_at,
        afterCreate?.updated_at,
        "a revision-only heal must not bump the sync watermark — it would re-queue the whole corpus for no content change"
      );
    });
  });

  test("a resumed session reimported inside the recently-active window reactivates and clears the main agent's stale tool", async () => {
    await withDb("iss8730-reactivate-", async (db) => {
      const sessionId = "iss8730-reactivate";
      const mainId = `${sessionId}-main`;
      const session1 = makeSession({
        sessionId,
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
        fileModifiedAt: STALE_FILE_MTIME_MS,
      });
      await db.importer.importSession(session1, Harness.Claude);
      assert.equal(
        (await querySessionRow(db, sessionId))?.status,
        SESSION_STATUS.INACTIVE,
        "precondition: the first import must land terminal"
      );
      // Leave the main agent mid-tool, matching the ISS-4476 orphan shape, so
      // clearing it below is an observed effect and not a vacuous null check.
      await db.prisma.write((client) =>
        client.$executeRawUnsafe(
          "UPDATE agents SET current_tool = $1 WHERE id = $2",
          "Bash",
          mainId
        )
      );

      const session2: NormalizedSession = {
        ...session1,
        endedAt: null,
        fileModifiedAt: RECENT_FILE_MTIME_MS,
      };
      const second = await db.importer.importSession(session2, Harness.Claude);

      assert.equal(second.reactivated, true);
      const sessionRow = await querySessionRow(db, sessionId);
      assert.equal(sessionRow?.status, SESSION_STATUS.ACTIVE);
      assert.equal(sessionRow?.ended_at, null);
      const agentRow = await queryMainAgentRow(db, sessionId);
      assert.equal(agentRow?.status, DESKTOP_AGENT_STATUS.WAITING);
      assert.equal(agentRow?.ended_at, null);
      assert.equal(
        agentRow?.current_tool,
        null,
        "reactivation must clear a stale current_tool"
      );
      assert.notEqual(
        agentRow?.awaiting_input_since,
        null,
        "reactivation must stamp awaiting_input_since so the Kanban board places the session in Waiting"
      );
    });
  });

  test("ends_with_error refreshes on every reimport of an already-live session, not only on reactivation", async () => {
    await withDb("iss8730-live-ends-with-error-", async (db) => {
      const sessionId = "iss8730-live-ends-with-error";
      const session1 = makeSession({
        sessionId,
        startedAt: STARTED_AT,
        endedAt: null,
        fileModifiedAt: RECENT_FILE_MTIME_MS,
        endedOnUnrecoveredError: false,
      });
      await db.importer.importSession(session1, Harness.Claude);
      assert.equal(
        (await querySessionRow(db, sessionId))?.ends_with_error,
        0,
        "precondition: the first import carried no unrecovered error"
      );

      const session2: NormalizedSession = {
        ...session1,
        endedOnUnrecoveredError: true,
      };
      const second = await db.importer.importSession(session2, Harness.Claude);

      assert.equal(
        second.reactivated,
        false,
        "the row was already live — this must not travel the reactivation path"
      );
      assert.equal(
        (await querySessionRow(db, sessionId))?.ends_with_error,
        1,
        "a fresh trailing unrecovered error must refresh the durable flag on a live row"
      );
    });
  });

  test("a new recently-active session is created ACTIVE with its main agent's awaiting_input_since stamped", async () => {
    await withDb("iss8730-new-active-", async (db) => {
      const sessionId = "iss8730-new-active";
      const session = makeSession({
        sessionId,
        startedAt: STARTED_AT,
        endedAt: null,
        fileModifiedAt: RECENT_FILE_MTIME_MS,
      });
      await db.importer.importSession(session, Harness.Claude);

      const sessionRow = await querySessionRow(db, sessionId);
      assert.equal(sessionRow?.status, SESSION_STATUS.ACTIVE);
      assert.equal(sessionRow?.ended_at, null);
      const agentRow = await queryMainAgentRow(db, sessionId);
      assert.notEqual(agentRow?.awaiting_input_since, null);
    });
  });

  test("a new terminal session that ended on an unrecovered error is created ERROR with its main agent status ERROR", async () => {
    await withDb("iss8730-new-error-", async (db) => {
      const sessionId = "iss8730-new-error";
      const session = makeSession({
        sessionId,
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
        fileModifiedAt: STALE_FILE_MTIME_MS,
        endedOnUnrecoveredError: true,
      });
      await db.importer.importSession(session, Harness.Claude);

      const sessionRow = await querySessionRow(db, sessionId);
      assert.equal(sessionRow?.status, SESSION_STATUS.ERROR);
      assert.equal(sessionRow?.ends_with_error, 1);
      const agentRow = await queryMainAgentRow(db, sessionId);
      assert.equal(agentRow?.status, DESKTOP_AGENT_STATUS.ERROR);
    });
  });

  test("importPhaseSessionAndMainAgent's return contract: new row, unchanged reimport, then a content change", async () => {
    await withDb("iss8730-return-contract-", async (db) => {
      const sessionId = "iss8730-return-contract";
      const session = makeSession({
        sessionId,
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
      });

      const created = await runSessionPhase(db, session, NOW);
      assert.deepEqual(created, {
        existed: false,
        reactivated: false,
        sessionDataChanged: true,
        createdAtChanged: false,
        revisionStamped: true,
      });

      const unchanged = await runSessionPhase(
        db,
        session,
        "2026-06-07T13:00:00.000Z"
      );
      assert.deepEqual(unchanged, {
        existed: true,
        reactivated: false,
        sessionDataChanged: false,
        createdAtChanged: false,
        revisionStamped: false,
      });

      const changedSession: NormalizedSession = {
        ...session,
        name: "Renamed",
      };
      const changed = await runSessionPhase(
        db,
        changedSession,
        "2026-06-07T14:00:00.000Z"
      );
      assert.equal(changed.existed, true);
      assert.equal(changed.sessionDataChanged, true);
      assert.equal(changed.revisionStamped, true);
    });
  });
});
