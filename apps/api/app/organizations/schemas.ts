import { z } from "zod";

export const updateOrganizationSchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  anthropicApiKey: z.string().optional(),
  settings: z.object().optional(),
});
