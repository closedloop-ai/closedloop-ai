import { TeamRole } from "@repo/database";
import { onboardingService } from "@/app/onboarding/service";
import { projectsService } from "@/app/projects/service";
import type { VibeSeedContext } from "../stage";

/**
 * ISS-12017: org setup the base seed leaves out. Both go through the services
 * the product's own routes call, so the rows match what a user would leave.
 */

/**
 * Link every project with no team to the team the local-trusted user owns or
 * administers (the base seed's "Default Team"), falling back to the org's oldest team. Without
 * these links the team Projects page lists nothing. Written through
 * `projectsService.update`, the PUT /projects/:id path.
 */
export async function linkProjectsToOwnedTeam(
  context: VibeSeedContext
): Promise<void> {
  const teamId = await resolveHomeTeamId(context);
  const projects = await context.prisma.project.findMany({
    where: { organizationId: context.organizationId, teams: { none: {} } },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  for (const project of projects) {
    const result = await projectsService.update(
      project.id,
      context.organizationId,
      { teamIds: [teamId] }
    );
    if (!result.ok) {
      throw new Error(
        `linking project ${project.id} to team ${teamId} failed: ${JSON.stringify(result.error)}`
      );
    }
  }
  context.log(`linked ${projects.length} project(s) to team ${teamId}`);
}

/**
 * Stamp `wizardCompletedAt`/`wizardCompletedBy` through
 * `onboardingService.completeWizard`, the POST /onboarding/complete path, so the
 * stack does not open onboarding over the seeded data.
 */
export async function completeOnboardingWizard(
  context: VibeSeedContext
): Promise<void> {
  const status = await onboardingService.completeWizard(
    context.organizationId,
    context.userId
  );
  if (!status.wizardCompleted) {
    throw new Error("onboarding still reports the wizard as not completed");
  }
}

export async function resolveHomeTeamId(
  context: VibeSeedContext
): Promise<string> {
  const owned = await context.prisma.team.findFirst({
    where: {
      organizationId: context.organizationId,
      // ISS-12135: `seedOrgPeople` moves the signed-in person from owner to
      // admin of this team, so either role still identifies it.
      members: {
        some: {
          userId: context.userId,
          role: { in: [TeamRole.OWNER, TeamRole.ADMIN] },
        },
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  const team =
    owned ??
    (await context.prisma.team.findFirst({
      where: { organizationId: context.organizationId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    }));
  if (!team) {
    throw new Error(
      `organization ${context.organizationId} has no team to link projects to; the base seed should have created one`
    );
  }
  return team.id;
}
