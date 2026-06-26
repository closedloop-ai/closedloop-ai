import { orgSlugSchema } from "@repo/api/src/types/reserved-slugs";
import { z } from "zod";
import { jsonObjectValidator } from "@/lib/validators/json";

export const updateOrganizationValidator = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  settings: jsonObjectValidator.optional(),
});

export type UpdateOrganizationBody = z.infer<
  typeof updateOrganizationValidator
>;

export function validateChangedOrganizationSlug(
  slug: string
): { success: true; slug: string } | { success: false; error: string } {
  const result = orgSlugSchema.safeParse(slug);

  if (result.success) {
    return { success: true, slug: result.data };
  }

  return {
    success: false,
    error: result.error.issues
      .map((issue) => `slug: ${issue.message}`)
      .join(", "),
  };
}
