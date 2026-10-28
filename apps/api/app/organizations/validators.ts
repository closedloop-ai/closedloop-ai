import { OrgInviteRole } from "@repo/api/src/types/onboarding";
import {
  ORGANIZATION_MEMBERS_OFFSET_MAX,
  ORGANIZATION_MEMBERS_PAGE_LIMIT_DEFAULT,
  ORGANIZATION_MEMBERS_PAGE_LIMIT_MAX,
} from "@repo/api/src/types/organization-members";
import { clampPageLimit } from "@repo/api/src/types/page-limit-bounds";
import { orgSlugSchema } from "@repo/api/src/types/reserved-slugs";
import { z } from "zod";
import { jsonObjectValidator } from "@/lib/validators/json";
import {
  clampPageOffset,
  pageBoundValidator,
} from "@/lib/validators/pagination";

export const updateOrganizationValidator = z.object({
  // 255 is the bound the promote route already applies to a catalog `name`, and
  // the sibling `orgSlugSchema` in this file bounds the slug at 64 — this is the
  // one field on the object with a floor and no ceiling.
  //
  // `Organization.name` is Postgres `text`, so nothing downstream bounds it, and
  // `updateOrganizationLocally` writes the DB BEFORE pushing to Clerk and
  // swallows a Clerk rejection into a log — an oversized name would leave the
  // two divergent while the route answered 200. 255 matches the `name` bound the
  // promote route already applies. Server only: the client half of this surface
  // has no production host (ISS-8859).
  name: z.string().min(1).max(255).optional(),
  slug: z.string().min(1).optional(),
  // Org-wide policy blob (ISS-7121). Admin-only — the route enforces org-admin
  // before persisting this field (see updateOrganizationForRoute). Writes
  // replace the whole column; this validator does not merge.
  settings: jsonObjectValidator.optional(),
  // Transcript-content search privacy gate (FEA-3930). Admin-only — the route
  // enforces org-admin before persisting this field (see updateOrganizationForRoute).
  searchIncludeTranscripts: z.boolean().optional(),
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

/**
 * Query contract for both Members list reads (ISS-9083).
 *
 * ONE validator for two routes: they take the same two params and must bound
 * them identically, and two copies would let the roster and the invitation list
 * drift into different page caps.
 *
 * `.strict()` is deliberate. `parseQueryParams` hands every search key to this
 * schema, so a non-strict object would strip a misspelled `?limt=20` — or a
 * `?role=org:admin` filter neither route honors — and answer with the default
 * page. That is a 200 for a request the route did not perform.
 *
 * THE TWO BOUNDS ARE ENFORCED DIFFERENTLY, and the asymmetry is the point.
 *
 * An over-max LIMIT clamps: the caller asked for more rows than the page
 * allows, and the largest legal page is a truthful answer to that.
 *
 * An over-max OFFSET is REJECTED, because clamping it aliases pages. Both list
 * services derive `hasMore` from the offset they were handed, so a clamped
 * offset makes every request past the ceiling return the SAME page with
 * `hasMore: true` — and nothing in the response echoes the offset that was
 * actually used, so a paging client cannot detect it and loops on that page
 * forever. A 400 is the only answer that does not lie: no such page exists.
 *
 * Both bounds are applied in the transform rather than in the service, so what
 * `parseQueryParams` hands back is already inside them and no caller can forget
 * to narrow it.
 */
export const organizationListQueryValidator = z
  .object({
    limit: pageBoundValidator,
    offset: pageBoundValidator,
  })
  .strict()
  .refine(
    (query) =>
      query.offset === undefined ||
      query.offset <= ORGANIZATION_MEMBERS_OFFSET_MAX,
    {
      message: `must not exceed ${ORGANIZATION_MEMBERS_OFFSET_MAX}`,
      path: ["offset"],
    }
  )
  .transform((query) => ({
    limit: clampPageLimit(query.limit, {
      defaultLimit: ORGANIZATION_MEMBERS_PAGE_LIMIT_DEFAULT,
      maxLimit: ORGANIZATION_MEMBERS_PAGE_LIMIT_MAX,
    }),
    // The refine above owns the ceiling; the clamp owns the floor and the
    // fractional case. It is passed the same maximum so the two cannot disagree
    // about where the ceiling is.
    offset: clampPageOffset(query.offset, ORGANIZATION_MEMBERS_OFFSET_MAX),
  }));

export type OrganizationListQuery = z.infer<
  typeof organizationListQueryValidator
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
