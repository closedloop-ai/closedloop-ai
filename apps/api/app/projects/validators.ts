import { Priority } from "@repo/api/src/types/common";
import { ProjectStatus } from "@repo/api/src/types/project";
import { z } from "zod";
import { transformIsoDateTime } from "@/lib/validators/date-time";
import { jsonObjectValidator } from "@/lib/validators/json";

const priorityEnum = z.enum(Priority);
const projectStatusEnum = z.enum(ProjectStatus);

export const createProjectValidator = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  priority: priorityEnum.optional(),
  status: projectStatusEnum.optional(),
  assigneeId: z.uuidv7().nullable().optional(),
  slug: z.string().nullable().optional(),
  targetDate: z.iso
    .datetime()
    .nullable()
    .optional()
    .transform(transformIsoDateTime),
  teamIds: z.array(z.uuidv7()).optional(),
});

export const reorderProjectsValidator = z.object({
  projectIds: z.array(z.uuidv7()),
});

export const updateProjectValidator = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  priority: priorityEnum.optional(),
  status: projectStatusEnum.optional(),
  assigneeId: z.uuidv7().nullable().optional(),
  slug: z.string().nullable().optional(),
  targetDate: z.iso
    .datetime()
    .nullable()
    .optional()
    .transform(transformIsoDateTime),
  teamIds: z.array(z.uuidv7()).optional(),
  settings: jsonObjectValidator.optional(),
  codebaseSummary: z.string().nullable().optional(),
  lastIndexedAt: z.iso
    .datetime()
    .nullable()
    .optional()
    .transform(transformIsoDateTime),
});
