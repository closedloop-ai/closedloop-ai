import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { test } from "vitest";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  sqliteMarkOutboxWithheld,
  sqliteReEnqueueRecoveredDeadLetter,
  sqliteRePendWithheldOutbox,
  sqliteRependDeadLetteredForFormulaRewalk,
  sqliteRependSessionDeadLetters,
} from "../src/main/database/sync-outbox-store.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";
import {
  burndownQuery,
  DELIVERY_SOURCE_KEY,
  SESSION_SOURCE_KEY,
} from "./support/sync-burndown-fixtures.js";

const OLD_PENDING_SINCE = "2026-01-01T00:00:00.000Z";

async function withDb(
  body: (
    db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>
  ) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss10379-pending-since-"));
  try {
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => "2026-09-18T21:45:00.000Z",
    });
    try {
      await body(db);
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function pendingSince(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  sourceKey: string,
  id: string
): Promise<string | null> {
  const rows = await db.prisma.client.agentSessionSyncOutbox.findMany({
    where: { sourceKey, externalSessionId: id },
    select: { pendingSince: true },
  });
  return rows[0]?.pendingSince ?? null;
}

async function seedSessionRow(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  sourceKey: string,
  id: string,
  status: string,
  pendingSinceIso: string | null = OLD_PENDING_SINCE
): Promise<void> {
  await db.run(
    `INSERT INTO agent_session_sync_outbox
       (source_key, external_session_id, status, sync_class, attempt_count,
        pending_since, created_at, updated_at)
     VALUES (?, ?, ?, 'backfill', 0, ?, ?, ?)`,
    sourceKey,
    id,
    status,
    pendingSinceIso,
    "2025-01-01T00:00:00.000Z",
    OLD_PENDING_SINCE
  );
}

async function seedInvocationRow(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  id: string,
  pendingSinceIso: string | null
): Promise<void> {
  await db.run(
    `INSERT INTO agent_component_invocation_sync_outbox
       (source_key, external_session_id, external_generation_id, part_index,
        part_count, part_hash, source_updated_at, data_revision, source_sequence,
        payload, status, attempt_count, pending_since, created_at, updated_at)
     VALUES (?, ?, ?, 0, 1, ?, ?, 1, 1, '{}', ?, 0, ?, ?, ?)`,
    DELIVERY_SOURCE_KEY,
    id,
    `${id}-generation`.padEnd(64, "0").slice(0, 64),
    `${id}-part`.padEnd(64, "0").slice(0, 64),
    OLD_PENDING_SINCE,
    OutboxStatus.Pending,
    pendingSinceIso,
    "2025-01-01T00:00:00.000Z",
    OLD_PENDING_SINCE
  );
}

test("ISS-10379: enqueue and every session re-pend stamp pending_since while retries preserve it", async () => {
  await withDb(async (db) => {
    await db.syncSource.enqueueOutboxEntries?.(SESSION_SOURCE_KEY, [
      {
        externalSessionId: "initial",
        syncClass: AgentSessionSyncMode.Backfill,
      },
    ]);
    const initial = await pendingSince(db, SESSION_SOURCE_KEY, "initial");
    assert.ok(initial, "initial enqueue records when delivery debt began");

    await db.syncSource.recordOutboxRetry?.(
      SESSION_SOURCE_KEY,
      "initial",
      1,
      "2026-09-18T22:00:00.000Z",
      SyncReason.IngestionFailed,
      null
    );
    assert.equal(
      await pendingSince(db, SESSION_SOURCE_KEY, "initial"),
      initial,
      "retry bookkeeping must not make an old pending row look new"
    );

    await db.syncSource.enqueueOutboxEntries?.(SESSION_SOURCE_KEY, [
      {
        externalSessionId: "initial",
        syncClass: AgentSessionSyncMode.Incremental,
      },
    ]);
    assert.equal(
      await pendingSince(db, SESSION_SOURCE_KEY, "initial"),
      initial,
      "the batched conflict refresh is not a transition into pending"
    );

    const cases = [
      ["single", "agent_sessions:single"],
      ["formula", "agent_sessions:formula"],
      ["boot", "agent_sessions:boot"],
      ["withheld", "agent_sessions:withheld"],
    ] as const;
    for (const [id, sourceKey] of cases) {
      await seedSessionRow(
        db,
        sourceKey,
        id,
        id === "withheld" ? OutboxStatus.Withheld : OutboxStatus.DeadLettered
      );
    }

    await sqliteReEnqueueRecoveredDeadLetter(
      db.prisma,
      "agent_sessions:single",
      "single"
    );
    await sqliteRependDeadLetteredForFormulaRewalk(
      db.prisma,
      "agent_sessions:formula"
    );
    await sqliteRependSessionDeadLetters(db.prisma, "agent_sessions:boot", [
      "boot",
    ]);
    await sqliteRePendWithheldOutbox(db.prisma, "agent_sessions:withheld", [
      "withheld",
    ]);

    for (const [id, sourceKey] of cases) {
      const stamped = await pendingSince(db, sourceKey, id);
      assert.ok(
        stamped && stamped > OLD_PENDING_SINCE,
        `${id} re-pend restamps age`
      );
    }

    await sqliteMarkOutboxWithheld(db.prisma, SESSION_SOURCE_KEY, ["initial"]);
    assert.equal(
      await pendingSince(db, SESSION_SOURCE_KEY, "initial"),
      initial,
      "leaving pending does not rewrite the remembered transition time"
    );
  });
});

for (const [label, pendingSinceIso, laterPendingSinceIso] of [
  ["ordinary date", "2026-09-18T21:40:00.000Z", "2026-09-18T21:44:00.000Z"],
  ["leap day", "2024-02-29T23:59:59.123Z", "2024-03-01T00:00:00.000Z"],
  ["leap century", "2000-02-29T00:00:00.000Z", "2000-03-01T00:00:00.000Z"],
] as const) {
  test(`ISS-10379: burn-down minima use pending_since for both outboxes (${label})`, async () => {
    await withDb(async (db) => {
      await seedSessionRow(
        db,
        SESSION_SOURCE_KEY,
        "session-age",
        OutboxStatus.Pending,
        pendingSinceIso
      );
      await seedInvocationRow(db, "invocation-age", pendingSinceIso);
      await seedSessionRow(
        db,
        SESSION_SOURCE_KEY,
        "session-later",
        OutboxStatus.Pending,
        laterPendingSinceIso
      );
      await seedInvocationRow(db, "invocation-later", laterPendingSinceIso);

      const readSyncBurndown = db.syncSource.readSyncBurndown;
      assert.ok(readSyncBurndown);
      const sample = await readSyncBurndown(burndownQuery());
      assert.equal(sample.sessionOutbox.oldestPendingSinceIso, pendingSinceIso);
      assert.equal(
        sample.invocationOutbox.oldestPendingSinceIso,
        pendingSinceIso
      );
      assert.equal(sample.sessionOutbox.pending, 2);
      assert.equal(sample.invocationOutbox.pendingParts, 2);
    });
  });
}

for (const [label, unreadable, stamped] of [
  ["lexically late malformed", "zzz-malformed", OLD_PENDING_SINCE],
  ["lexically early malformed", "!malformed", OLD_PENDING_SINCE],
  ["blank", "", OLD_PENDING_SINCE],
  ["invalid hour", "2026-09-18T24:00:01.000Z", OLD_PENDING_SINCE],
  ["invalid date", "2026-13-18T21:40:00.000Z", OLD_PENDING_SINCE],
  ["February 30", "2026-02-30T00:00:00.000Z", "2026-03-01T00:00:00.000Z"],
  ["April 31", "2026-04-31T00:00:00.000Z", "2026-05-01T00:00:00.000Z"],
  [
    "non-leap February 29",
    "2026-02-29T00:00:00.000Z",
    "2026-03-01T00:00:00.000Z",
  ],
] as const) {
  for (const lane of ["sessionOutbox", "invocationOutbox"] as const) {
    test(`ISS-10379: ${lane} retains all pending debt but no age with a ${label} sibling`, async () => {
      await withDb(async (db) => {
        for (const id of ["stamped", "unreadable"]) {
          await seedSessionRow(
            db,
            SESSION_SOURCE_KEY,
            id,
            OutboxStatus.Pending,
            id === "stamped" ? stamped : unreadable
          );
        }
        await seedInvocationRow(db, "stamped", stamped);
        await seedInvocationRow(db, "unreadable", unreadable);

        const readSyncBurndown = db.syncSource.readSyncBurndown;
        assert.ok(readSyncBurndown);
        const sample = await readSyncBurndown(burndownQuery());
        const outbox = sample[lane];
        assert.equal(outbox.pending, 2);
        assert.equal(outbox.readyPending, 2);
        assert.equal(outbox.deadLettered, 0);
        assert.equal(outbox.withheld, 0);
        assert.equal(outbox.unmeasuredRows, 0);
        assert.equal(outbox.oldestPendingSinceIso, null);
        assert.equal(sample.invocationOutbox.pendingSessions, 2);
        assert.equal(sample.invocationOutbox.pendingParts, 2);
        assert.equal(sample.invocationOutbox.pendingPayloadBytes, 4);
      });
    });
  }
}

test("ISS-10379: empty outboxes have no pending age or debt", async () => {
  await withDb(async (db) => {
    const readSyncBurndown = db.syncSource.readSyncBurndown;
    assert.ok(readSyncBurndown);
    const sample = await readSyncBurndown(burndownQuery());
    for (const outbox of [sample.sessionOutbox, sample.invocationOutbox]) {
      assert.equal(outbox.pending, 0);
      assert.equal(outbox.readyPending, 0);
      assert.equal(outbox.oldestPendingSinceIso, null);
    }
    assert.equal(sample.invocationOutbox.pendingParts, 0);
    assert.equal(sample.invocationOutbox.pendingPayloadBytes, 0);
  });
});

test("ISS-10379: session age is absent for a mixed stamped and legacy pending population", async () => {
  await withDb(async (db) => {
    await seedSessionRow(
      db,
      SESSION_SOURCE_KEY,
      "session-stamped",
      OutboxStatus.Pending
    );
    await seedSessionRow(
      db,
      SESSION_SOURCE_KEY,
      "session-legacy",
      OutboxStatus.Pending
    );
    await db.run(
      `UPDATE agent_session_sync_outbox SET pending_since = NULL
        WHERE source_key = ? AND external_session_id = ?`,
      SESSION_SOURCE_KEY,
      "session-legacy"
    );

    const readSyncBurndown = db.syncSource.readSyncBurndown;
    assert.ok(readSyncBurndown);
    const sample = await readSyncBurndown(burndownQuery());
    assert.equal(sample.sessionOutbox.oldestPendingSinceIso, null);
    assert.equal(sample.sessionOutbox.pending, 2);
    assert.equal(sample.sessionOutbox.readyPending, 2);
  });
});

test("ISS-10379: invocation age is absent for a mixed stamped and legacy pending population", async () => {
  await withDb(async (db) => {
    await seedInvocationRow(db, "invocation-stamped", OLD_PENDING_SINCE);
    await seedInvocationRow(db, "invocation-legacy", null);

    const readSyncBurndown = db.syncSource.readSyncBurndown;
    assert.ok(readSyncBurndown);
    const sample = await readSyncBurndown(burndownQuery());
    assert.equal(sample.invocationOutbox.oldestPendingSinceIso, null);
    assert.equal(sample.invocationOutbox.pendingParts, 2);
    assert.equal(sample.invocationOutbox.readyPending, 2);
    assert.equal(sample.invocationOutbox.pendingPayloadBytes, 4);
  });
});
