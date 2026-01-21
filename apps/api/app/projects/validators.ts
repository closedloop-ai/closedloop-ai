import { z } from "zod";
import { jsonObjectValidator } from "@/lib/validators/json";

export const createProjectValidator = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
});

export const updateProjectValidator = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  settings: jsonObjectValidator.optional(),
});
