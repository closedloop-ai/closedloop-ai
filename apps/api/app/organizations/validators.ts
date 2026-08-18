import { OrgInviteRole } from "@repo/api/src/types/onboarding";
import { orgSlugSchema } from "@repo/api/src/types/reserved-slugs";
import { z } from "zod";
import { jsonObjectValidator } from "@/lib/validators/json";

export const updateOrganizationValidator = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  settings: jsonObjectValidator.optional(),
  // Transcript-content search privacy gate (FEA-3930). Admin-only — the route
  // enforces org-admin before persisting this field (see updateOrganizationForRoute).
  searchIncludeTranscripts: z.boolean().optional(),
  // Org session-sync privacy policy (FEA-4169). Admin-only — the route enforces
  // org-admin before persisting this field (see updateOrganizationForRoute).
  sessionSyncPolicyEnabled: z.boolean().optional(),
});

export type UpdateOrganizationBody = z.infer<
  typeof updateOrganizationValidator
>;

const MAX_INVITES_PER_REQUEST = 50;

/**
 * Validates `POST /organizations/invitations`. Emails are normalized
 * (trim + lowercase) and de-duplicated so the invite route never mints two
 * Clerk invitations for the same address in one batch.
 */
export const inviteMembersValidator = z.object({
  emailAddresses: z
    .array(z.email().transform((value) => value.trim().toLowerCase()))
    .min(1, "At least one email address is required")
    .max(
      MAX_INVITES_PER_REQUEST,
      `A maximum of ${MAX_INVITES_PER_REQUEST} invitations may be sent at once`
    )
    .transform((emails) => [...new Set(emails)]),
  role: z.enum(OrgInviteRole).optional(),
});

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
