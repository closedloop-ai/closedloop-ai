import type { VibeSeedContext } from "../stage";
import type { SeededBranch } from "./seeded-branches";

/**
 * ISS-12135: the branch's creator and assignee are the org member whose GitHub
 * handle pushed it, as a push webhook's source artifact records its creator.
 * Session-linked branches are materialized with neither, which put every
 * branch on whoever the Owner column fell back to and left the Insights "Me"
 * scope (branches the viewer created) with no merged pull requests at all.
 * A branch that already names either keeps it.
 */
export async function assignBranchOwner(
  context: VibeSeedContext,
  branch: SeededBranch,
  login: string
): Promise<void> {
  const owner = await context.prisma.user.findFirst({
    where: { organizationId: context.organizationId, githubUsername: login },
    select: { id: true },
  });
  if (owner === null) {
    return;
  }
  await context.prisma.artifact.updateMany({
    where: {
      id: branch.artifactId,
      organizationId: context.organizationId,
      createdById: null,
    },
    data: { createdById: owner.id },
  });
  await context.prisma.artifact.updateMany({
    where: {
      id: branch.artifactId,
      organizationId: context.organizationId,
      assigneeId: null,
    },
    data: { assigneeId: owner.id },
  });
}
