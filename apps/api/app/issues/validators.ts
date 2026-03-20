import { Priority } from "@repo/api/src/types/common";
import { IssueStatus } from "@repo/api/src/types/issue";
import { z } from "zod";
import { uuidOrSlug } from "@/lib/identifier-utils";

const issueStatusEnum = z.enum(IssueStatus);
const priorityEnum = z.enum(Priority);

export const createIssueValidator = z.object({
  workstreamId: uuidOrSlug().optional(),
  projectId: uuidOrSlug(),
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  status: issueStatusEnum.optional(),
  priority: priorityEnum.optional(),
  assigneeId: z.uuid().optional(),
});

export const updateIssueValidator = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  status: issueStatusEnum.optional(),
  priority: priorityEnum.optional(),
  assigneeId: z.uuid().nullable().optional(),
  projectId: uuidOrSlug().optional(),
  customFields: z
    .record(
      z.uuid(),
      z.union([
        z.string().max(10_000),
        z.number(),
        z.array(z.uuid()).max(100),
        z.null(),
      ])
    )
    .optional(),
});

export const findIssuesQueryValidator = z.object({
  workstreamId: uuidOrSlug().optional(),
  projectId: uuidOrSlug().optional(),
  status: issueStatusEnum.optional(),
  priority: priorityEnum.optional(),
  assigneeId: z.uuid().optional(),
});
