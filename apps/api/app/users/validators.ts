import { APPROVER_ROLE_OPTIONS } from "@repo/api/src/types/user";
import { z } from "zod";

const approverRoleEnum = z.enum(APPROVER_ROLE_OPTIONS);

export const updateUserValidator = z.object({
  name: z.string().optional(),
  avatarUrl: z.url().optional(),
  role: approverRoleEnum.optional(),
  linearUserId: z.string().optional(),
  slackUserId: z.string().optional(),
  githubUsername: z.string().optional(),
});
