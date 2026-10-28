import { TeamRole } from "@repo/api/src/types/teams";
import { ApproverRole } from "@repo/api/src/types/user";
import type { VibeSeedContext } from "../stage";
import type { SeedRoster } from "./base-seed-plan";
import { resolveHomeTeamId } from "./org-setup";
import { VIBE_SEED_TEAMMATES } from "./seed-people";

/**
 * ISS-12135: who the seeded work belongs to. The ONE place that names the
 * signed-in person (locally the local-trusted user; on Vercel the row the
 * person running the session adopts at finalize) and the org owner, so a
 * change to which rows those are touches only {@link signedInPersonId} and
 * {@link homeTeamOwnerId}.
 */

/** The row the signed-in person uses: the stack's local-trusted user. */
export function signedInPersonId(context: VibeSeedContext): string {
  return context.userId;
}

/** The org owner: the earliest active OWNER of the home team, if any. */
export async function homeTeamOwnerId(
  context: VibeSeedContext
): Promise<string | null> {
  const teamId = await resolveHomeTeamId(context);
  const owner = await context.prisma.teamMember.findFirst({
    where: {
      teamId,
      role: TeamRole.Owner,
      user: { organizationId: context.organizationId, active: true },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { userId: true },
  });
  return owner?.userId ?? null;
}

/** Engineers and tech leads both take plans and issues. */
const ROLE_POOLS: Readonly<Record<ApproverRole, keyof RosterPools | null>> = {
  [ApproverRole.Pm]: "pms",
  [ApproverRole.Engineer]: "engineers",
  [ApproverRole.TechLead]: "engineers",
  [ApproverRole.Designer]: "designers",
  [ApproverRole.Stakeholder]: null,
};

type RosterPools = Pick<SeedRoster, "pms" | "engineers" | "designers">;

/**
 * The seeded teammates, by role, resolved to their rows in this org. The
 * signed-in person is never in a pool: their slice is assigned on purpose.
 */
export async function loadSeedRoster(
  context: VibeSeedContext
): Promise<SeedRoster> {
  const admin = signedInPersonId(context);
  const rows = await context.prisma.user.findMany({
    where: {
      organizationId: context.organizationId,
      clerkId: { in: VIBE_SEED_TEAMMATES.map((person) => person.clerkId) },
    },
    select: { id: true, clerkId: true },
  });
  const idByClerkId = new Map(rows.map((row) => [row.clerkId, row.id]));
  const pools: { [K in keyof RosterPools]: string[] } = {
    pms: [],
    engineers: [],
    designers: [],
  };
  for (const person of VIBE_SEED_TEAMMATES) {
    const id = idByClerkId.get(person.clerkId);
    const pool = ROLE_POOLS[person.role];
    if (id && pool && id !== admin) {
      pools[pool].push(id);
    }
  }
  return { admin, ...pools };
}
