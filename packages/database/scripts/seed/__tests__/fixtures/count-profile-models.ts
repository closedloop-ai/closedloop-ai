import type { SeedProfileTargets } from "../../profiles";
import type { EphemeralDbContext } from "./ephemeral-db";

export async function countProfileModels(
  ctx: EphemeralDbContext
): Promise<SeedProfileTargets> {
  const { prisma, organizationId } = ctx;
  return {
    projects: await prisma.project.count({ where: { organizationId } }),
    artifacts: await prisma.artifact.count({ where: { organizationId } }),
    comments: await prisma.comment.count({
      where: { thread: { organizationId } },
    }),
    loops: await prisma.loop.count({ where: { organizationId } }),
  };
}
