import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { DocumentType, IssueStatus } from "@repo/api/src/types/document";
import { type ArtifactSubtype, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";

/**
 * Shared seed/read helpers for the ISS-9632 DB-backed suites.
 *
 * Five files now drive the same graph shape — a `BLOCKED` dependent, one or more
 * inbound `BLOCKS` edges, and the statuses on either end — against a real
 * Postgres. Keeping the fixture in one place is what stops them from drifting
 * into subtly different notions of "a blocked artifact", which is the one thing
 * that would make their agreement meaningless.
 */

/** The DB-backed tiers self-skip when no database is configured. */
export const hasDatabase = Boolean(keys().DATABASE_URL);

export async function seedArtifact(params: {
  organizationId: string;
  status: string;
  subtype?: ArtifactSubtype;
  name?: string;
}): Promise<string> {
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId: params.organizationId,
        type: ArtifactType.Document,
        subtype: (params.subtype ?? DocumentType.Feature) as ArtifactSubtype,
        name: params.name ?? "seeded artifact",
        status: params.status,
      },
      select: { id: true },
    })
  );
  return artifact.id;
}

export async function seedBlocksEdge(params: {
  organizationId: string;
  sourceId: string;
  targetId: string;
}): Promise<string> {
  const link = await withDb((db) =>
    db.artifactLink.create({
      data: {
        organizationId: params.organizationId,
        sourceId: params.sourceId,
        targetId: params.targetId,
        linkType: LinkType.Blocks,
      },
      select: { id: true },
    })
  );
  return link.id;
}

export function readStatus(id: string): Promise<string> {
  return withDb(async (db) => {
    const row = await db.artifact.findUniqueOrThrow({
      where: { id },
      select: { status: true },
    });
    return row.status;
  });
}

/** Move a blocker to a terminal status the way a real write path would. */
export async function terminalize(params: {
  organizationId: string;
  id: string;
  status: string;
}): Promise<void> {
  await withDb((db) =>
    db.artifact.update({
      where: { id: params.id, organizationId: params.organizationId },
      data: { status: params.status },
    })
  );
}

/**
 * Seed `count` BLOCKED dependents all blocked by one artifact, in TWO bulk
 * statements rather than 2N round-trips — this fixture is only worth having if
 * it can exceed the chunk bound without dominating the suite's runtime.
 *
 * `createManyAndReturn` rather than `createMany` then a read-back: the insert
 * already knows the ids it generated, so re-reading them cost a third
 * round-trip AND an org-wide `status = BLOCKED` scan, inside the ambient
 * auto-rollback transaction whose 5s budget spans the whole case. The read-back
 * was also wider than its caller: it selected every BLOCKED row in the org
 * rather than the rows just inserted, so it silently depended on the case
 * seeding no other blocked artifact.
 */
export async function seedBlockedFanOut(params: {
  organizationId: string;
  blockerId: string;
  count: number;
}): Promise<string[]> {
  const rows = Array.from({ length: params.count }, (_, index) => ({
    organizationId: params.organizationId,
    type: ArtifactType.Document,
    subtype: DocumentType.Feature as ArtifactSubtype,
    name: `fan-out dependent ${index}`,
    status: IssueStatus.Blocked,
  }));
  const seeded = await withDb((db) =>
    db.artifact.createManyAndReturn({ data: rows, select: { id: true } })
  );

  await withDb((db) =>
    db.artifactLink.createMany({
      data: seeded.map((row) => ({
        organizationId: params.organizationId,
        sourceId: params.blockerId,
        targetId: row.id,
        linkType: LinkType.Blocks,
      })),
    })
  );
  return seeded.map((row) => row.id);
}
