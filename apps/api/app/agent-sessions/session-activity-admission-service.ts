import { ArtifactType, withDb } from "@repo/database";

/** Admit a Session feed only when its detail exists in the caller's org. */
export const sessionActivityAdmissionService = {
  async findVisibleArtifactId(
    organizationId: string,
    artifactId: string
  ): Promise<string | null> {
    const artifact = await withDb((db) =>
      db.artifact.findFirst({
        where: {
          id: artifactId,
          organizationId,
          type: ArtifactType.SESSION,
          session: { isNot: null },
        },
        select: { id: true },
      })
    );
    return artifact?.id ?? null;
  },
};
