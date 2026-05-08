import { z } from "zod";
import { jsonObjectValidator } from "@/lib/validators/json";

export const updateOrganizationValidator = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  settings: jsonObjectValidator.optional(),
});
