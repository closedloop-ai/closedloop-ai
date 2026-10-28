import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
} from "@repo/api/src/types/artifact-activity";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { artifactActivityService } from "@/app/documents/artifact-activity-service";
import { captureSystemSessionStatusChange } from "@/lib/artifact-activity-recording";

const tracker = createCommittedTestOrganizationTracker();

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-10992 System Session status receipt transaction",
  () => {
    afterEach(async () => {
      vi.restoreAllMocks();
      await tracker.cleanup();
    });

    it("commits a System receipt with the status transition", async () => {
      const organizationId = await tracker.create();
      const owner = await createTestUser(organizationId);
      const artifactId = await createTestSessionDetail({
        organizationId,
        userId: owner.id,
        label: "system-status-success",
      });

      await withDb.tx(async (tx) => {
        await tx.artifact.updateMany({
          where: { id: artifactId, organizationId },
          data: { status: SESSION_STATUS.INACTIVE },
        });
        await captureSystemSessionStatusChange({
          tx,
          organizationId,
          artifactId,
          before: SESSION_STATUS.ACTIVE,
          after: SESSION_STATUS.INACTIVE,
        });
      });

      const state = await withDb((db) =>
        db.artifact.findUniqueOrThrow({
          where: { id: artifactId },
          select: {
            status: true,
            activityEvents: {
              select: {
                action: true,
                actorType: true,
                actorId: true,
                before: true,
                after: true,
              },
            },
          },
        })
      );
      expect(state.status).toBe(SESSION_STATUS.INACTIVE);
      expect(state.activityEvents).toEqual([
        {
          action: ArtifactActivityAction.StatusChange,
          actorType: ArtifactActivityActorType.System,
          actorId: null,
          before: SESSION_STATUS.ACTIVE,
          after: SESSION_STATUS.INACTIVE,
        },
      ]);
    });

    it("rolls the status back when its activity receipt fails", async () => {
      const organizationId = await tracker.create();
      const owner = await createTestUser(organizationId);
      const artifactId = await createTestSessionDetail({
        organizationId,
        userId: owner.id,
        label: "system-status-rollback",
      });
      vi.spyOn(
        artifactActivityService,
        "recordActivityEvent"
      ).mockRejectedValueOnce(new Error("receipt unavailable"));

      await expect(
        withDb.tx(async (tx) => {
          await tx.artifact.updateMany({
            where: { id: artifactId, organizationId },
            data: { status: SESSION_STATUS.INACTIVE },
          });
          await captureSystemSessionStatusChange({
            tx,
            organizationId,
            artifactId,
            before: SESSION_STATUS.ACTIVE,
            after: SESSION_STATUS.INACTIVE,
          });
        })
      ).rejects.toThrow("receipt unavailable");

      const state = await withDb((db) =>
        db.artifact.findUniqueOrThrow({
          where: { id: artifactId },
          select: {
            status: true,
            _count: { select: { activityEvents: true } },
          },
        })
      );
      expect(state.status).toBe(SESSION_STATUS.ACTIVE);
      expect(state._count.activityEvents).toBe(0);
    });
  }
);
