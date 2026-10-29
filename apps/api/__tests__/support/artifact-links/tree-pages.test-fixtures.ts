import { randomUUID } from "node:crypto";
import { LinkType } from "@repo/api/src/types/artifact";
import { IssueStatus } from "@repo/api/src/types/document";
import { ArtifactType, type Prisma, withDb } from "@repo/database";
import { createTestOrganization } from "@/__tests__/utils/db-helpers";

export async function seedPagedTree(width = 1100, depth = 3) {
  const organizationId = await createTestOrganization();
  const root = randomUUID();
  const levels = Array.from({ length: depth }, () =>
    Array.from({ length: width }, () => randomUUID())
  );
  const nodes = [root, ...levels.flat()];
  for (let start = 0; start < nodes.length; start += 1000) {
    await withDb((db) =>
      db.artifact.createMany({
        data: nodes.slice(start, start + 1000).map((id) => ({
          id,
          organizationId,
          type: ArtifactType.DOCUMENT,
          name: id,
          status: IssueStatus.InProgress,
        })),
      })
    );
  }
  const links: Prisma.ArtifactLinkCreateManyInput[] = levels.flatMap(
    (level, depthIndex) =>
      level.map((targetId, index) => ({
        id: randomUUID(),
        organizationId,
        targetId,
        sourceId: depthIndex === 0 ? root : levels[depthIndex - 1][index],
        linkType: LinkType.Produces,
        createdAt: new Date(1_700_000_000_000 + index),
      }))
  );
  for (let start = 0; start < links.length; start += 1000) {
    await withDb((db) =>
      db.artifactLink.createMany({ data: links.slice(start, start + 1000) })
    );
  }
  const expected = levels.flatMap((_, index) =>
    links
      .slice(index * width, (index + 1) * width)
      .reverse()
      .map((link) => link.id)
  );
  return { organizationId, root, levels, links, expected };
}
