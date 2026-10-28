/**
 * ISS-10332 (#7762 review) — a session or branch search row carries the
 * priority its artifact holds when the row is WRITTEN, not the one the indexer
 * captured earlier.
 *
 * The transcript indexer reads the session, then reads the transcript from
 * object storage, then upserts. A priority `PATCH` committing in that window
 * re-projects the row itself, and a stale capture landing after it must not
 * undo that. Each case captures a projection, moves the artifact's priority,
 * then upserts the stale capture — on both the insert path and the conflict
 * path — and reads the stored row back.
 *
 * Real Postgres (self-skips without DATABASE_URL); every case runs in an
 * auto-rollback transaction.
 *
 * Run explicitly:
 *
 *   DATABASE_URL=... NODE_ENV=test pnpm --filter api exec vitest run \
 *     --config vitest.config.integration.mts --no-file-parallelism \
 *     __tests__/integration/search-priority-reindex-capture.integration.test.ts
 */
import { ArtifactType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { withDb } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
} from "@/__tests__/utils/db-helpers";
import { hasDatabase } from "@/app/documents/__tests__/blocked-dependent-fixtures";
import {
  agentSessionProjection,
  branchProjection,
  searchIndexService,
} from "@/app/search/search-index-service";

const describeIfDb = hasDatabase ? describe : describe.skip;

const CAPTURED_AT = new Date("2026-09-22T00:00:00Z");

describeIfDb(
  "search priority written from the artifact, not the capture",
  () => {
    it("a session row takes the artifact's priority on insert and on conflict", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const artifactId = await seedArtifact(
          organizationId,
          ArtifactType.Session,
          Priority.High
        );
        const capture = sessionCapture(
          organizationId,
          artifactId,
          Priority.High
        );

        await setPriority(artifactId, Priority.Low);
        await searchIndexService.upsert(capture);
        expect(await storedPriority(organizationId, artifactId)).toBe(
          Priority.Low
        );

        await setPriority(artifactId, Priority.Urgent);
        await searchIndexService.upsert(capture);
        expect(await storedPriority(organizationId, artifactId)).toBe(
          Priority.Urgent
        );
      });
    });

    it("a cleared priority is written as none, not replaced by the capture", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const artifactId = await seedArtifact(
          organizationId,
          ArtifactType.Session,
          Priority.High
        );
        const capture = sessionCapture(
          organizationId,
          artifactId,
          Priority.High
        );

        await setPriority(artifactId, null);
        await searchIndexService.upsert(capture);

        expect(await storedPriority(organizationId, artifactId)).toBeNull();
      });
    });

    it("a branch row takes the artifact's priority the same way", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const artifactId = await seedArtifact(
          organizationId,
          ArtifactType.Branch,
          Priority.Medium
        );
        const capture = branchProjection({
          artifactId,
          organizationId,
          title: "feat/priority-capture",
          body: null,
          priority: Priority.Medium,
          updatedAt: CAPTURED_AT,
        });

        await setPriority(artifactId, Priority.Urgent);
        await searchIndexService.upsert(capture);

        expect(await storedPriority(organizationId, artifactId)).toBe(
          Priority.Urgent
        );
      });
    });
  }
);

function sessionCapture(
  organizationId: string,
  artifactId: string,
  priority: Priority
) {
  return agentSessionProjection({
    artifactId,
    organizationId,
    title: "priority capture session",
    body: null,
    userId: null,
    priority,
    updatedAt: CAPTURED_AT,
  });
}

async function seedArtifact(
  organizationId: string,
  type: ArtifactType,
  priority: Priority
): Promise<string> {
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        type,
        name: "priority capture",
        status: SESSION_STATUS.ACTIVE,
        priority,
      },
      select: { id: true },
    })
  );
  return artifact.id;
}

async function setPriority(
  artifactId: string,
  priority: Priority | null
): Promise<void> {
  await withDb((db) =>
    db.artifact.update({
      where: { id: artifactId },
      data: { priority },
      select: { id: true },
    })
  );
}

async function storedPriority(
  organizationId: string,
  entityId: string
): Promise<string | null> {
  const row = await withDb((db) =>
    db.searchDocument.findFirstOrThrow({
      where: { organizationId, entityId },
      select: { priority: true },
    })
  );
  return row.priority;
}
