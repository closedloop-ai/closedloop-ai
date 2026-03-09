import { Priority } from "@repo/api/src/types/common";
import { IssueStatus } from "@repo/api/src/types/issue";
import { z } from "zod";

const issueStatusEnum = z.enum(IssueStatus);
const priorityEnum = z.enum(Priority);

export const createIssueValidator = z.object({
  workstreamId: z.uuidv7().optional(),
  projectId: z.uuidv7(),
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  status: issueStatusEnum.optional(),
  priority: priorityEnum.optional(),
  assigneeId: z.uuidv7().optional(),
});

export const updateIssueValidator = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  status: issueStatusEnum.optional(),
  priority: priorityEnum.optional(),
  assigneeId: z.uuidv7().nullable().optional(),
  projectId: z.uuidv7().optional(),
  customFields: z
    .record(
      z.string().uuid(),
      z.union([
        z.string().max(10_000),
        z.number(),
        z.array(z.string().uuid()).max(100),
        z.null(),
      ])
    )
    .optional(),
});

export const findIssuesQueryValidator = z.object({
  workstreamId: z.uuidv7().optional(),
  projectId: z.uuidv7().optional(),
  status: issueStatusEnum.optional(),
  priority: priorityEnum.optional(),
  assigneeId: z.uuidv7().optional(),
});
