import { type Prisma, withDb } from "@repo/database";

/**
 * Seeds PRODUCES rows the way a database written before cycle admission still
 * holds them. Migration 20261022022500 refuses new cycles with a trigger, so a
 * suite whose subject is how reads tolerate a LEGACY cycle inserts it with that
 * trigger off, in one transaction that turns it back on before committing.
 */
export function createLegacyProducesLinks(
  data: Prisma.ArtifactLinkCreateManyInput[]
) {
  return withDb.tx(async (tx) => {
    await tx.$executeRaw`ALTER TABLE artifact_links DISABLE TRIGGER artifact_links_reject_produces_cycle`;
    await tx.artifactLink.createMany({ data });
    await tx.$executeRaw`ALTER TABLE artifact_links ENABLE TRIGGER artifact_links_reject_produces_cycle`;
  });
}
