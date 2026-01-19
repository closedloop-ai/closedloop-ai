import { APPROVER_ROLE_OPTIONS } from "@repo/api/src/types/artifact";
import { z } from "zod";

const approverRoleEnum = z.enum(APPROVER_ROLE_OPTIONS);

export const createUserSchema = z.object({
  organizationId: z.string().min(1, "organizationId is required"),
  email: z.string().email("Invalid email format"),
  name: z.string().optional(),
  avatarUrl: z.string().url().optional(),
  role: approverRoleEnum.optional(),
});

export const updateUserSchema = z.object({
  name: z.string().optional(),
  avatarUrl: z.string().url().optional(),
  role: approverRoleEnum.optional(),
  linearUserId: z.string().optional(),
  slackUserId: z.string().optional(),
  githubUsername: z.string().optional(),
});
