import { ArtifactType } from "@repo/api/src/types/artifact";
import { artifactFavoritesService } from "@/app/artifacts/favorites-service";
import { projectsService } from "@/app/projects/service";
import type { VibeSeedContext } from "../stage";

/**
 * ISS-12017: the local-trusted user's starred documents, sessions and projects,
 * written through the services the star buttons call. Both upsert, so a re-run
 * adds nothing.
 */

const FAVORITE_DOCUMENT_COUNT = 5;
const FAVORITE_SESSION_COUNT = 2;
const FAVORITE_PROJECT_COUNT = 2;

export async function seedFavorites(context: VibeSeedContext): Promise<void> {
  const { prisma, organizationId, userId } = context;
  const [documents, sessions, projects] = await Promise.all([
    prisma.artifact.findMany({
      where: { organizationId, type: ArtifactType.Document },
      orderBy: [{ slug: "asc" }, { id: "asc" }],
      take: FAVORITE_DOCUMENT_COUNT,
      select: { id: true },
    }),
    prisma.artifact.findMany({
      where: { organizationId, type: ArtifactType.Session },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: FAVORITE_SESSION_COUNT,
      select: { id: true },
    }),
    prisma.project.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: FAVORITE_PROJECT_COUNT,
      select: { id: true },
    }),
  ]);
  for (const artifact of [...documents, ...sessions]) {
    const result = await artifactFavoritesService.addFavorite(
      artifact.id,
      userId,
      organizationId
    );
    if (result === null) {
      throw new Error(`favoriting artifact ${artifact.id} found no artifact`);
    }
  }
  for (const project of projects) {
    const result = await projectsService.addFavorite(
      project.id,
      userId,
      organizationId
    );
    if (result === null) {
      throw new Error(`favoriting project ${project.id} found no project`);
    }
  }
  context.log(
    `favorites: ${documents.length + sessions.length} artifact(s), ${projects.length} project(s)`
  );
}
