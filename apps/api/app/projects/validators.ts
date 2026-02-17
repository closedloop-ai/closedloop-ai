import { ProjectPriority } from "@repo/api/src/types/organization";
import { z } from "zod";
import { transformIsoDateTime } from "@/lib/validators/date-time";
import { jsonObjectValidator } from "@/lib/validators/json";

const prioritySchema = z.enum(ProjectPriority);

export const createProjectValidator = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  priority: prioritySchema.optional(),
  ownerId: z.uuidv7().nullable().optional(),
  targetDate: z.iso
    .datetime()
    .nullable()
    .optional()
    .transform(transformIsoDateTime),
  teamIds: z.array(z.uuidv7()).optional(),
});

export const reorderProjectsValidator = z.object({
  projectIds: z.array(z.string().uuid()),
});

export const updateProjectValidator = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  priority: prioritySchema.optional(),
  ownerId: z.uuidv7().nullable().optional(),
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
