import { randomUUID } from "node:crypto";
import { BranchStatus } from "@repo/api/src/types/branch";
import { CommitProvenanceSource } from "@repo/api/src/types/commit";
import { ArtifactType, type Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
} from "@/__tests__/utils/db-helpers";
import { updateCommitBatch } from "./commit-batch-updates";
import { reconcileCommitsOnTx } from "./commit-service";

const REPO = "iss9278/commits";
const sha = (index: number) => index.toString(16).padStart(40, "0");

async function fixture() {
  const organizationId = await createTestOrganization();
  const branch = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        status: BranchStatus.Open,
        name: "Commit batch test",
      },
    })
  );
  return {
    organizationId,
    repositoryFullName: REPO,
    branchArtifactId: branch.id,
  };
}

describe.skipIf(!keys().DATABASE_URL)("batched commit updates", () => {
  it("persists 2200 changed rows in two bounded update statements", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await fixture();
      await withDb(async (tx) => {
        for (let offset = 0; offset < 2200; offset += 1000) {
          await tx.commitDetail.createMany({
            data: Array.from(
              { length: Math.min(1000, 2200 - offset) },
              (_, index) => ({
                ...scope,
                sha: sha(offset + index),
                source: CommitProvenanceSource.DesktopSync,
              })
            ),
          });
        }
        const statements: Prisma.Sql[] = [];
        const measured = new Proxy(tx, {
          get(target, key) {
            if (key === "$executeRaw") {
              return (query: Prisma.Sql) => {
                statements.push(query);
                return target.$executeRaw(query);
              };
            }
            return Reflect.get(target, key);
          },
        });
        const observations = Array.from({ length: 2200 }, (_, index) => ({
          ...scope,
          sha: sha(index),
          source: CommitProvenanceSource.PushWebhook,
          message: `Commit ${index}`,
          linesAdded: index,
          authoredAt: new Date("2026-09-18T12:00:00Z"),
        }));
        await reconcileCommitsOnTx(measured, observations);
        expect(statements).toHaveLength(2);
        expect(statements.every((query) => query.values.length < 32_767)).toBe(
          true
        );
        const rows = await tx.commitDetail.findMany({
          where: { organizationId: scope.organizationId },
          orderBy: { sha: "asc" },
        });
        expect(
          rows.map((row) => [
            row.sha,
            row.message,
            row.linesAdded,
            row.authoredAt,
          ])
        ).toEqual(
          observations.map((row) => [
            row.sha,
            row.message,
            row.linesAdded,
            row.authoredAt,
          ])
        );
        const timestamps = rows.map((row) => row.updatedAt);
        statements.length = 0;
        await reconcileCommitsOnTx(measured, observations);
        expect(statements).toHaveLength(0);
        expect(
          (
            await tx.commitDetail.findMany({
              where: { organizationId: scope.organizationId },
              orderBy: { sha: "asc" },
            })
          ).map((row) => row.updatedAt)
        ).toEqual(timestamps);
      });
    });
  });

  it("preserves provenance, original branch and foreign-org rows while expanding SHAs", async () => {
    await autoRollbackTransaction(async () => {
      const scope = await fixture();
      const foreign = await fixture();
      const otherBranch = await withDb((db) =>
        db.artifact.create({
          data: {
            organizationId: scope.organizationId,
            type: ArtifactType.BRANCH,
            status: BranchStatus.Open,
            name: "Later branch",
          },
        })
      );
      await withDb(async (tx) => {
        await reconcileCommitsOnTx(tx, [
          {
            ...scope,
            sha: "abcdef0",
            source: CommitProvenanceSource.DesktopSync,
            message: "desktop",
            linesAdded: 4,
          },
          {
            ...scope,
            sha: "1234567",
            source: CommitProvenanceSource.PushWebhook,
            message: "authoritative",
            isMerge: true,
          },
          {
            ...foreign,
            sha: "abcdef0",
            source: CommitProvenanceSource.DesktopSync,
            message: "foreign",
          },
        ]);
        await reconcileCommitsOnTx(tx, [
          {
            ...scope,
            branchArtifactId: otherBranch.id,
            sha: `abcdef0${"a".repeat(33)}`,
            source: CommitProvenanceSource.PushWebhook,
            message: "webhook",
            linesRemoved: 2,
            authorLogin: "verified",
            isMerge: true,
          },
          {
            ...scope,
            branchArtifactId: otherBranch.id,
            sha: "1234567",
            source: CommitProvenanceSource.DesktopSync,
            message: "ignored",
            linesAdded: 8,
            isMerge: false,
          },
        ]);
        const rows = await tx.commitDetail.findMany({
          where: {
            organizationId: {
              in: [scope.organizationId, foreign.organizationId],
            },
          },
          orderBy: { sha: "asc" },
        });
        expect(
          rows.find((row) => row.organizationId === foreign.organizationId)
        ).toMatchObject({
          message: "foreign",
          sha: "abcdef0",
          branchArtifactId: foreign.branchArtifactId,
        });
        expect(rows.find((row) => row.sha === "1234567")).toMatchObject({
          message: "authoritative",
          source: CommitProvenanceSource.PushWebhook,
          isMerge: true,
          linesAdded: 8,
          branchArtifactId: scope.branchArtifactId,
        });
        expect(rows.find((row) => row.sha.length === 40)).toMatchObject({
          message: "webhook",
          linesAdded: 4,
          linesRemoved: 2,
          authorLogin: "verified",
          isMerge: true,
          branchArtifactId: scope.branchArtifactId,
        });
      });
    });
  });

  it("rolls back earlier writes and preserves P2002 on an exact SHA conflict", async () => {
    const scope = await fixture();
    try {
      await withDb((db) =>
        db.commitDetail.createMany({
          data: [1, 2].map((index) => ({
            ...scope,
            sha: sha(index),
            source: CommitProvenanceSource.DesktopSync,
            message: "original",
          })),
        })
      );
      const rows = await withDb((db) =>
        db.commitDetail.findMany({
          where: { organizationId: scope.organizationId },
          orderBy: { sha: "asc" },
        })
      );
      await expect(
        withDb.tx(async (tx) => {
          await tx.commitDetail.update({
            where: { id: rows[1].id },
            data: { message: "must roll back" },
            select: { id: true },
          });
          await updateCommitBatch(tx, [
            {
              id: rows[0].id,
              organizationId: scope.organizationId,
              data: { ...rows[0], sha: rows[1].sha },
            },
          ]);
        })
      ).rejects.toMatchObject({ code: "P2002" });
      expect(
        await withDb((db) =>
          db.commitDetail.findMany({
            where: { organizationId: scope.organizationId },
            orderBy: { sha: "asc" },
          })
        )
      ).toEqual(rows);
      await expect(
        withDb.tx((tx) =>
          updateCommitBatch(tx, [
            {
              id: randomUUID(),
              organizationId: scope.organizationId,
              data: rows[0],
            },
          ])
        )
      ).rejects.toMatchObject({ code: "P2025" });
    } finally {
      await withDb(async (db) => {
        await db.commitDetail.deleteMany({
          where: { organizationId: scope.organizationId },
        });
        await db.artifact.deleteMany({
          where: { organizationId: scope.organizationId },
        });
        await db.organization.delete({ where: { id: scope.organizationId } });
      });
    }
  });
});
