import { TeamRole } from "@repo/api/src/types/teams";
import { z } from "zod";

const teamRoleSchema = z.enum(TeamRole);

export const createTeamValidator = z.object({
  name: z.string().min(1, "Team name is required"),
  slug: z.string().optional(),
});

export const updateTeamValidator = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().optional(),
});

export const addMemberValidator = z.object({
  userId: z.uuidv7(),
  role: teamRoleSchema.optional(),
});

export const updateMemberValidator = z.object({
  role: teamRoleSchema,
});
