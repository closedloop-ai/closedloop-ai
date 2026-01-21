import { z } from "zod";

const prioritySchema = z.enum(["NOT_SET", "LOW", "MEDIUM", "HIGH"]);

export const createProjectSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  priority: prioritySchema.optional(),
  ownerId: z.string().nullable().optional(),
  targetDate: z.string().nullable().optional(), // ISO date string
  teamIds: z.array(z.string()).optional(),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  priority: prioritySchema.optional(),
  ownerId: z.string().nullable().optional(),
  targetDate: z.string().nullable().optional(), // ISO date string
  teamIds: z.array(z.string()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
