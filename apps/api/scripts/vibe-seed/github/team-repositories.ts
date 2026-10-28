import { AddRepositoryError, teamsService } from "@/app/teams/service";
import type { VibeSeedContext } from "../stage";
import { SYMPHONY_REPOSITORY } from "./repositories";

/**
 * ISS-12017: give every team of the vibe org its repositories through
 * `teamsService.addRepository`, the write behind POST
 * /teams/:teamId/repositories. The repository the golden sessions worked in
 * is each team's primary; the org's other installed repositories follow it.
 */
export async function linkTeamRepositories(
  context: VibeSeedContext
): Promise<void> {
  const [teams, repositories] = await Promise.all([
    context.prisma.team.findMany({
      where: { organizationId: context.organizationId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    }),
    context.prisma.gitHubInstallationRepository.findMany({
      where: {
        removedAt: null,
        installation: { organizationId: context.organizationId },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, fullName: true },
    }),
  ]);
  const ordered = [
    ...repositories.filter(
      (repository) => repository.fullName === SYMPHONY_REPOSITORY.fullName
    ),
    ...repositories.filter(
      (repository) => repository.fullName !== SYMPHONY_REPOSITORY.fullName
    ),
  ];
  let added = 0;
  for (const team of teams) {
    for (const [index, repository] of ordered.entries()) {
      const result = await teamsService.addRepository(
        team.id,
        context.organizationId,
        { installationRepositoryId: repository.id, isPrimary: index === 0 }
      );
      if (result.ok) {
        added += 1;
      } else if (result.error !== AddRepositoryError.AlreadyAdded) {
        throw new Error(
          `adding ${repository.fullName} to team ${team.id} failed: ${result.error}`
        );
      }
    }
  }
  context.log(
    `mapped ${added} team repositor${added === 1 ? "y" : "ies"} across ${teams.length} team(s)`
  );
}
