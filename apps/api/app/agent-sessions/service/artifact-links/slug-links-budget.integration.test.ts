import { randomUUID } from "node:crypto";
import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import {
  ArtifactRefMethod,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { observeStatements } from "@/__tests__/support/db-statement-observer";
import {
  autoRollbackTransaction,
  createTestOrganization,
} from "@/__tests__/utils/db-helpers";
import { persistArtifactLinks } from "./slug-links";

const describeIfDb = keys().DATABASE_URL ? describe : describe.skip;
const observedAt = new Date("2026-09-18T14:59:30.000Z");

describeIfDb("slug ingest statement budget", () => {
  it("replays 54 references in three statements without rewriting metadata or timestamps", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const sourceId = randomUUID();
      const refs = Array.from({ length: 54 }, (_, index) => ({
        kind: ArtifactRefTargetKind.ClosedloopArtifact,
        slug: `ISS-${index + 1}`,
        method: ArtifactRefMethod.McpToolCall,
        isPrimary: false,
        observedAt: observedAt.toISOString(),
      }));
      const slugMap = new Map(refs.map((ref) => [ref.slug, randomUUID()]));
      await withDb(async (tx) => {
        await tx.artifact.createMany({
          data: [sourceId, ...slugMap.values()].map((id) => ({
            id,
            organizationId,
            type: ArtifactType.Session,
            name: id,
            status: SESSION_STATUS.INACTIVE,
          })),
        });
        await persistArtifactLinks(
          tx,
          organizationId,
          sourceId,
          refs,
          slugMap,
          observedAt
        );
        const before = await tx.artifactLink.findMany({
          where: { organizationId, sourceId },
          orderBy: { targetId: "asc" },
        });
        const { statements } = await observeStatements(() =>
          persistArtifactLinks(
            tx,
            organizationId,
            sourceId,
            [...refs, refs[0]].reverse(),
            slugMap,
            new Date("2026-09-01T00:00:00Z")
          )
        );
        const after = await tx.artifactLink.findMany({
          where: { organizationId, sourceId },
          orderBy: { targetId: "asc" },
        });
        expect(after).toEqual(before);
        expect(after).toHaveLength(54);
        expect(
          after.every(
            (row) =>
              row.linkType === LinkType.RelatesTo &&
              row.lastContributedAt?.getTime() === observedAt.getTime()
          )
        ).toBe(true);
        expect(statements.length).toBeLessThanOrEqual(3);
      });
    });
  });
});
