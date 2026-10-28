/**
 * @file invocation-sync-environment-gate.test.ts
 * @description ISS-7096: the invocation-parts lane's ownership gate. A compute
 * target is assigned per authenticated account+machine, so sessions another
 * identity pair owns — on a multi-environment device, the other environment's
 * sessions — are (a) released from the delivery queue with their per-session
 * cursors cleared, and (b) never materialized into it again. Delivery rows are
 * DERIVED artifacts: clearing the cursor is the ISS-6909 lever that lets
 * promotion re-materialize the session whole if this device ever syncs as its
 * owner.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
  buildAgentComponentInvocationSyncSourceKey,
} from "../src/main/agent-sync/agent-component-invocation-sync-constants.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";
import {
  type Db,
  makeInvocationSyncDir,
  openDb,
  SKILL_CONTENT_V1,
  skillSession,
} from "./helpers/invocation-sync-fixtures.js";

const MINE = {
  organizationId: "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f",
  userId: "019c2a66-37e4-7221-9c3b-e159549f4c93",
};
const OTHER = {
  organizationId: "019bec6e-27c2-7320-8be0-40e514918765",
  userId: "019e227c-52fb-75e5-bcad-b62cf2685dc6",
};

async function stampOwner(
  db: Db,
  sessionId: string,
  owner: { organizationId: string; userId: string }
): Promise<void> {
  await db.prisma.write((client) =>
    client.session.update({
      where: { id: sessionId },
      data: {
        organizationId: owner.organizationId,
        userId: owner.userId,
      },
    })
  );
}

async function pendingDeliverySessionIds(
  db: Db,
  target: string
): Promise<string[]> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { external_session_id: string }[]
  >(
    `SELECT DISTINCT external_session_id
       FROM agent_component_invocation_sync_outbox
      WHERE source_key = $1 AND status = $2
      ORDER BY external_session_id`,
    target,
    OutboxStatus.Pending
  );
  return rows.map((row) => row.external_session_id);
}

describe("ISS-7096 invocation-parts environment gate", () => {
  test("promotion never materializes a foreign-owned session, and the revision still completes", async () => {
    const dir = await makeInvocationSyncDir("aci-env-gate-");
    const db = await openDb(dir);
    try {
      await db.importer.importSession(
        skillSession("session-own", [SKILL_CONTENT_V1]),
        "claude"
      );
      await db.importer.importSession(
        skillSession("session-foreign", [SKILL_CONTENT_V1]),
        "claude"
      );
      await stampOwner(db, "session-own", MINE);
      await stampOwner(db, "session-foreign", OTHER);
      const target = buildAgentComponentInvocationSyncSourceKey("target-gate");
      const prepare = db.syncSource.prepareInvocationSyncTarget;
      assert.ok(prepare);

      await prepare(
        target,
        AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        10,
        MINE
      );
      assert.deepEqual(await pendingDeliverySessionIds(db, target), [
        "session-own",
      ]);

      // A second pass stays quiet: the foreign session must not hold the
      // revision open and be re-walked forever.
      await prepare(
        target,
        AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        10,
        MINE
      );
      assert.deepEqual(await pendingDeliverySessionIds(db, target), [
        "session-own",
      ]);
    } finally {
      await db.close();
    }
  });

  test("a foreign-owned session's delivery rows are released and re-materialize once owned", async () => {
    const dir = await makeInvocationSyncDir("aci-env-sweep-");
    const db = await openDb(dir);
    try {
      await db.importer.importSession(
        skillSession("session-keep", [SKILL_CONTENT_V1]),
        "claude"
      );
      await db.importer.importSession(
        skillSession("session-swept", [SKILL_CONTENT_V1]),
        "claude"
      );
      await stampOwner(db, "session-keep", MINE);
      await stampOwner(db, "session-swept", MINE);
      const target = buildAgentComponentInvocationSyncSourceKey("target-sweep");
      const prepare = db.syncSource.prepareInvocationSyncTarget;
      assert.ok(prepare);

      // Materialize both while both are owned (pre-ISS-7096 pollution shape).
      await prepare(
        target,
        AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        10,
        MINE
      );
      assert.deepEqual(await pendingDeliverySessionIds(db, target), [
        "session-keep",
        "session-swept",
      ]);

      // The device now syncs as MINE but the session turns out to be OTHER's.
      await stampOwner(db, "session-swept", OTHER);
      await prepare(
        target,
        AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        10,
        MINE
      );
      assert.deepEqual(await pendingDeliverySessionIds(db, target), [
        "session-keep",
      ]);
      const sweptCursor = await db.prisma.client.$queryRawUnsafe<
        { external_session_id: string }[]
      >(
        `SELECT external_session_id
           FROM agent_component_invocation_sync_cursors
          WHERE source_key = $1 AND external_session_id = $2`,
        target,
        "session-swept"
      );
      assert.deepEqual(sweptCursor, [], "the per-session cursor is cleared");

      // The release loses nothing: when the OWNING account syncs, its own
      // compute target (targets are assigned per authenticated account+machine,
      // so it is a different delivery key) re-materializes the session whole
      // from the template — the ISS-6909 re-materialization property.
      const ownerTarget = buildAgentComponentInvocationSyncSourceKey(
        "target-owner-device"
      );
      await prepare(
        ownerTarget,
        AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        10,
        OTHER
      );
      assert.deepEqual(await pendingDeliverySessionIds(db, ownerTarget), [
        "session-swept",
      ]);
    } finally {
      await db.close();
    }
  });

  test("a null identity degrades to the ungated behavior", async () => {
    const dir = await makeInvocationSyncDir("aci-env-null-");
    const db = await openDb(dir);
    try {
      await db.importer.importSession(
        skillSession("session-anyone", [SKILL_CONTENT_V1]),
        "claude"
      );
      await stampOwner(db, "session-anyone", OTHER);
      const target = buildAgentComponentInvocationSyncSourceKey("target-null");
      const prepare = db.syncSource.prepareInvocationSyncTarget;
      assert.ok(prepare);

      await prepare(
        target,
        AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        10,
        null
      );
      assert.deepEqual(await pendingDeliverySessionIds(db, target), [
        "session-anyone",
      ]);
    } finally {
      await db.close();
    }
  });

  test("cr-81036: a foreign block longer than the page cap defers instead of stamping the revision complete", async () => {
    const dir = await makeInvocationSyncDir("aci-env-cap-");
    const db = await openDb(dir);
    try {
      for (let index = 1; index <= 11; index++) {
        const id = `session-f-${String(index).padStart(2, "0")}`;
        await db.importer.importSession(
          skillSession(id, [SKILL_CONTENT_V1]),
          "claude"
        );
        await stampOwner(db, id, OTHER);
      }
      await db.importer.importSession(
        skillSession("session-z-own", [SKILL_CONTENT_V1]),
        "claude"
      );
      await stampOwner(db, "session-z-own", MINE);
      const target = buildAgentComponentInvocationSyncSourceKey("target-cap");
      const prepare = db.syncSource.prepareInvocationSyncTarget;
      assert.ok(prepare);

      // sessionLimit 1 → the 10-page cap covers only the first 10 foreign
      // sessions. The buggy shape stamped the revision complete here, so the
      // owned session ordered behind the block was never materialized.
      await prepare(
        target,
        AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        1,
        MINE
      );
      assert.deepEqual(await pendingDeliverySessionIds(db, target), []);

      // The next pass resumes past the walked block and reaches the owner's
      // real work instead of early-returning on a falsely-completed revision.
      await prepare(
        target,
        AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        1,
        MINE
      );
      assert.deepEqual(await pendingDeliverySessionIds(db, target), [
        "session-z-own",
      ]);
    } finally {
      await db.close();
    }
  });
});
