import {
  ISSUE_PRIORITY_OPTIONS,
  ISSUE_STATUS_OPTIONS,
} from "@repo/api/src/types/issue";
import { z } from "zod";

const issueStatusEnum = z.enum(ISSUE_STATUS_OPTIONS);
const issuePriorityEnum = z.enum(ISSUE_PRIORITY_OPTIONS);

export const createIssueValidator = z
  .object({
    workstreamId: z.uuidv7().optional(),
    projectId: z.uuidv7().optional(),
    title: z.string().min(1, "Title is required"),
    description: z.string().optional(),
    status: issueStatusEnum.optional(),
    priority: issuePriorityEnum.optional(),
    assigneeId: z.uuidv7().optional(),
  })
  .refine((data) => data.workstreamId || data.projectId, {
    message: "Either workstreamId or projectId is required",
  });

export const updateIssueValidator = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  status: issueStatusEnum.optional(),
  priority: issuePriorityEnum.optional(),
  assigneeId: z.uuidv7().nullable().optional(),
  projectId: z.uuidv7().nullable().optional(),
});

export const findIssuesQueryValidator = z.object({
  workstreamId: z.uuidv7().optional(),
  projectId: z.uuidv7().optional(),
  status: issueStatusEnum.optional(),
  priority: issuePriorityEnum.optional(),
  assigneeId: z.uuidv7().optional(),
});
