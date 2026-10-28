import { ProjectStatus } from "@repo/api/src/types/project";
import { projectsService } from "@/app/projects/service";
import { resolveHomeTeamId } from "../core/org-setup";
import type { VibeSeedContext } from "../stage";
import { SEED_ARCHIVED_PROJECT } from "./content";

/**
 * ISS-12043: one archived project on the home team, so the team's archived
 * projects view has a row (the base seed archives nothing). Written through
 * `projectsService.create`, the POST /projects path, and skipped by name when
 * already present.
 */
export async function seedArchivedProject(
  context: VibeSeedContext
): Promise<void> {
  const { prisma, organizationId, userId } = context;
  const existing = await prisma.project.findFirst({
    where: { organizationId, name: SEED_ARCHIVED_PROJECT.name },
    select: { id: true },
  });
  if (existing) {
    context.log(`archived project already present: ${existing.id}`);
    return;
  }
  const teamId = await resolveHomeTeamId(context);
  const result = await projectsService.create(organizationId, userId, {
    name: SEED_ARCHIVED_PROJECT.name,
    description: SEED_ARCHIVED_PROJECT.description,
    status: ProjectStatus.Archived,
    teamIds: [teamId],
  });
  if (!result.ok) {
    throw new Error(
      `creating the archived project failed: ${JSON.stringify(result.error)}`
    );
  }
  // ISS-12135: archived long before the current work; the create path takes no time.
  await prisma.project.update({
    where: { id: result.value.id },
    data: {
      createdAt: new Date(context.now.getTime() - CREATED_DAYS_AGO * DAY_MS),
      updatedAt: new Date(context.now.getTime() - ARCHIVED_DAYS_AGO * DAY_MS),
    },
    select: { id: true },
  });
  context.log(`archived project: ${result.value.id} on team ${teamId}`);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CREATED_DAYS_AGO = 150;
const ARCHIVED_DAYS_AGO = 80;
