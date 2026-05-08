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
  userId: z.uuid(),
  role: teamRoleSchema.optional(),
});

export const updateMemberValidator = z.object({
  role: teamRoleSchema,
});

export const addTeamRepositoryValidator = z.object({
  installationRepositoryId: z.uuid(),
  isDefaultSelected: z.boolean().optional(),
  isPrimary: z.boolean().optional(),
});

export const updateTeamRepositoryValidator = z
  .object({
    isDefaultSelected: z.boolean().optional(),
    isPrimary: z.boolean().optional(),
  })
  .refine(
    (data) =>
      data.isDefaultSelected !== undefined || data.isPrimary !== undefined,
    { message: "At least one field must be provided" }
  );
