import { Priority } from "@repo/api/src/types/common";
import {
  defaultRepositoryValidator,
  ProjectStatus,
  repositoryOverridesValidator,
} from "@repo/api/src/types/project";
import { z } from "zod";
import { transformIsoDateTime } from "@/lib/validators/date-time";
import { jsonValueValidator } from "@/lib/validators/json";

const priorityEnum = z.enum(Priority);
const projectStatusEnum = z.enum(ProjectStatus);

// Settings is a free-form JSON column, but the keys we know about must conform
// to their declared shapes. Unknown keys pass through untouched.
const projectSettingsBodyValidator = z
  .object({
    defaultRepository: defaultRepositoryValidator.optional(),
    repositoryOverrides: repositoryOverridesValidator.optional(),
  })
  .catchall(jsonValueValidator);

export const createProjectValidator = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  priority: priorityEnum.optional(),
  status: projectStatusEnum.optional(),
  assigneeId: z.uuid().nullable().optional(),
  slug: z.string().nullable().optional(),
  targetDate: z.iso
    .datetime()
    .nullable()
    .optional()
    .transform(transformIsoDateTime),
  teamIds: z.array(z.uuid()).optional(),
});

export const reorderProjectsValidator = z.object({
  projectIds: z.array(z.uuid()),
});

export const updateProjectValidator = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  priority: priorityEnum.optional(),
  status: projectStatusEnum.optional(),
  assigneeId: z.uuid().nullable().optional(),
  targetDate: z.iso
    .datetime()
    .nullable()
    .optional()
    .transform(transformIsoDateTime),
  teamIds: z.array(z.uuid()).optional(),
  settings: projectSettingsBodyValidator.optional(),
  codebaseSummary: z.string().nullable().optional(),
  lastIndexedAt: z.iso
    .datetime()
    .nullable()
    .optional()
    .transform(transformIsoDateTime),
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
