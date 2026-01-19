import { z } from "zod";

export const createOrganizationSchema = z.object({
  name: z.string().min(1, "Name is required"),
  slug: z.string().min(1, "Slug is required"),
  anthropicApiKey: z.string().optional(),
});

export const updateOrganizationSchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  anthropicApiKey: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
