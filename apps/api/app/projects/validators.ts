import { ProjectPriority } from "@repo/api/src/types/organization";
import { z } from "zod";
import { jsonObjectValidator } from "@/lib/validators/json";

const prioritySchema = z.enum(ProjectPriority);

export const createProjectValidator = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  priority: prioritySchema.optional(),
  ownerId: z.uuidv7().nullable().optional(),
  targetDate: z.date().nullable().optional(),
  teamIds: z.array(z.uuidv7()).optional(),
});

export const updateProjectValidator = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  priority: prioritySchema.optional(),
  ownerId: z.uuidv7().nullable().optional(),
  targetDate: z.date().nullable().optional(),
  teamIds: z.array(z.uuidv7()).optional(),
  settings: jsonObjectValidator.optional(),
});
