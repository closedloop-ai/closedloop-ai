import { z } from "zod";
import { jsonObjectValidator } from "@/lib/validators/json";

const prioritySchema = z.enum(["NOT_SET", "LOW", "MEDIUM", "HIGH"]);

export const createProjectValidator = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  priority: prioritySchema.optional(),
  ownerId: z.string().nullable().optional(),
  targetDate: z.string().nullable().optional(), // ISO date string
  teamIds: z.array(z.string()).optional(),
});

export const updateProjectValidator = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  priority: prioritySchema.optional(),
  ownerId: z.string().nullable().optional(),
  targetDate: z.string().nullable().optional(), // ISO date string
  teamIds: z.array(z.string()).optional(),
  settings: jsonObjectValidator.optional(),
});
