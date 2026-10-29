/**
 * ISS-9465 against a real Postgres.
 *
 * Three things have no fake that could answer them. Whether the new
 * `artifact_activity_events.transaction_id` column actually persists and the
 * rows of one batch can be LISTED by it — the acceptance criterion is a
 * correctness property (the rows carry a shared, queryable value), and ruling 5
 * deliberately left it unindexed, so an unindexed scan IS the access path under
 * test. Whether the hash chain still verifies once `detail` carries the id,
 * since `detail` participates in `AuditHashInput` and a serialization change
 * there would break every entry silently. And whether the tag pre-read really
 * separates "already tagged" from "gained the tag", which is a property of
 * `createMany({ skipDuplicates })` over a real unique index.
 *
 * TWO TABLES and TWO ROUTES' worth of rows throughout: ruling 3 is a per-table
 * contract and ruling 6 a per-route one, and a single-table or single-route
 * fixture passes against an implementation that stamps one global id.
 */
import { randomUUID } from "node:crypto";
import { AuditActorType } from "@repo/api/src/types/audit";
import { IssueStatus } from "@repo/api/src/types/document";
import { TagEntityType } from "@repo/api/src/types/tag";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { auditLedgerService } from "@/app/audit/audit-ledger-service";
import { artifactActivityService } from "@/app/documents/artifact-activity-service";
import { batchApplyTagService } from "@/app/tags/batch-apply-tag-service";
import { createTestOrganization, createTestUser } from "../utils/db-helpers";

const hasDatabase = Boolean(keys().DATABASE_URL);

/**
 * Literals, never the `AuditAction` const: the ledger's values are hashed into
 * an append-only chain, so a fixture that reads them from the same constant the
 * production path reads agrees with any mistake in it.
 */
const ARTIFACT_TAG_APPLIED = "artifact.tag_applied";
const DOCUMENT_PRIORITY_CHANGED = "document.priority_changed";
const ARTIFACT_OBJECT_TYPE = "artifact";
const DOCUMENT_OBJECT_TYPE = "document";

type World = { organizationId: string; userId: string };

async function seedWorld(): Promise<World> {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  return { organizationId, userId: user.id };
}

function seedArtifact(world: World, name: string): Promise<string> {
  return withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId: world.organizationId,
        createdById: world.userId,
        type: ArtifactType.DOCUMENT,
        subtype: ArtifactSubtype.ISSUE,
        name,
        slug: null,
        status: IssueStatus.Todo,
      },
      select: { id: true },
    });
    return artifact.id;
  });
}

function seedTag(world: World): Promise<string> {
  return withDb(async (db) => {
    const tag = await db.tag.create({
      data: {
        organizationId: world.organizationId,
        createdById: world.userId,
        name: `tag-${randomUUID().slice(0, 8)}`,
        color: "blue",
      },
      select: { id: true },
    });
    return tag.id;
  });
}

function readActivityByTransaction(organizationId: string, id: string) {
  return withDb((db) =>
    db.artifactActivityEvent.findMany({
      where: { organizationId, transactionId: id },
      orderBy: { artifactId: "asc" },
      select: { artifactId: true, action: true, after: true },
    })
  );
}

describe.skipIf(!hasDatabase)("bulk mutation transaction identity", () => {
  it("lists exactly one batch's activity rows by their shared transaction id", async () => {
    const world = await seedWorld();
    const [first, second, unrelated] = await Promise.all([
      seedArtifact(world, "txn-first"),
      seedArtifact(world, "txn-second"),
      seedArtifact(world, "txn-unrelated"),
    ]);
    const batchId = randomUUID();
    const otherBatchId = randomUUID();

    await artifactActivityService.recordActivityEvents({
      organizationId: world.organizationId,
      transactionId: batchId,
      events: [first, second].map((artifactId) => ({
        artifactId,
        actorType: "user",
        actorId: world.userId,
        action: "field_change",
        after: { field: "priority", value: "HIGH" },
      })),
    });
    // A SECOND batch, so the read below is proven to select rather than to
    // return everything this organization ever wrote.
    await artifactActivityService.recordActivityEvents({
      organizationId: world.organizationId,
      transactionId: otherBatchId,
      events: [
        {
          artifactId: unrelated,
          actorType: "user",
          actorId: world.userId,
          action: "field_change",
          after: { field: "projectId", value: null },
        },
      ],
    });

    const rows = await readActivityByTransaction(world.organizationId, batchId);
    expect(rows.map((row) => row.artifactId).sort()).toEqual(
      [first, second].sort()
    );

    const others = await readActivityByTransaction(
      world.organizationId,
      otherBatchId
    );
    expect(others.map((row) => row.artifactId)).toEqual([unrelated]);
  });

  it("leaves a single-artifact receipt with no transaction to group it", async () => {
    const world = await seedWorld();
    const artifactId = await seedArtifact(world, "txn-single");

    await artifactActivityService.recordActivityEvent({
      organizationId: world.organizationId,
      artifactId,
      actorType: "user",
      actorId: world.userId,
      action: "field_change",
      after: { field: "title", value: "renamed" },
    });

    const row = await withDb((db) =>
      db.artifactActivityEvent.findFirst({
        where: { organizationId: world.organizationId, artifactId },
        select: { transactionId: true },
      })
    );
    expect(row?.transactionId).toBeNull();
  });

  it("keeps the hash chain verifiable with the transaction id inside detail", async () => {
    const world = await seedWorld();
    const [tagged, prioritized] = await Promise.all([
      seedArtifact(world, "chain-tagged"),
      seedArtifact(world, "chain-prioritized"),
    ]);
    const transactionId = randomUUID();

    // Two ROUTES' vocabulary on one chain, because ruling 6 put every bulk
    // route on the ledger and a one-action fixture cannot tell that apart from
    // a single path that happens to work.
    await auditLedgerService.append({
      organizationId: world.organizationId,
      action: ARTIFACT_TAG_APPLIED,
      actorType: AuditActorType.User,
      actorId: world.userId,
      objectType: ARTIFACT_OBJECT_TYPE,
      objectId: tagged,
      detail: { tagId: randomUUID(), transactionId },
    });
    await auditLedgerService.append({
      organizationId: world.organizationId,
      action: DOCUMENT_PRIORITY_CHANGED,
      actorType: AuditActorType.User,
      actorId: world.userId,
      objectType: DOCUMENT_OBJECT_TYPE,
      objectId: prioritized,
      detail: { from: null, to: "HIGH", transactionId },
    });

    expect(await auditLedgerService.verifyChain(world.organizationId)).toEqual({
      ok: true,
    });

    const entries = await withDb((db) =>
      db.auditEntry.findMany({
        where: { organizationId: world.organizationId },
        orderBy: { seq: "asc" },
        select: { action: true, detail: true },
      })
    );
    expect(entries.map((entry) => entry.action)).toEqual([
      ARTIFACT_TAG_APPLIED,
      DOCUMENT_PRIORITY_CHANGED,
    ]);
    for (const entry of entries) {
      expect(entry.detail).toMatchObject({ transactionId });
    }
  });

  it("reports only the artifacts that GAINED the tag, not every applied item", async () => {
    const world = await seedWorld();
    const tagId = await seedTag(world);
    const [alreadyTagged, fresh] = await Promise.all([
      seedArtifact(world, "tag-existing"),
      seedArtifact(world, "tag-fresh"),
    ]);
    await withDb((db) =>
      db.tagArtifact.create({ data: { tagId, artifactId: alreadyTagged } })
    );

    const result = await batchApplyTagService.applyPerItem(
      tagId,
      TagEntityType.Artifact,
      [alreadyTagged, fresh],
      world.organizationId
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Both items are `applied` on the wire — the caller's intent held for both
    // — and only ONE of them changed anything, which is the split ruling 1
    // exists for and the one `createMany`'s count cannot express.
    expect(result.value.results.get(alreadyTagged)).toMatchObject({
      status: 200,
    });
    expect(result.value.results.get(fresh)).toMatchObject({ status: 200 });
    expect(result.value.newlyTaggedIds).toEqual([fresh]);
  });
});
