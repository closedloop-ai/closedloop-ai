import { z } from "zod";

/**
 * Org slugs that collide with top-level routes outside the org-scoped layout.
 *
 * All authenticated routes live under /{orgSlug}/..., so they can't collide.
 * Only routes that exist outside that scope need to be reserved.
 */
export const RESERVED_ORG_SLUGS = [
  // Unauthenticated / onboarding routes
  "sign-in",
  "sign-up",
  "onboarding",

  // API and system routes
  "api",
  "d",
  "rum-validation",

  // Auth flow paths
  "auth",
  "sso",
  "oauth",
  "callback",

  // Next.js / infrastructure
  "_next",
] as const;

const reservedOrgSlugSet = new Set<string>(RESERVED_ORG_SLUGS);

export function isReservedOrgSlug(slug: string): boolean {
  return reservedOrgSlugSet.has(slug.toLowerCase());
}

const ORG_SLUG_MIN_LENGTH = 2;
const ORG_SLUG_MAX_LENGTH = 64;
const ORG_SLUG_FORMAT = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const orgSlugSchema = z
  .string()
  .min(
    ORG_SLUG_MIN_LENGTH,
    `Slug must be at least ${ORG_SLUG_MIN_LENGTH} characters`
  )
  .max(
    ORG_SLUG_MAX_LENGTH,
    `Slug must be at most ${ORG_SLUG_MAX_LENGTH} characters`
  )
  .regex(
    ORG_SLUG_FORMAT,
    "Slug must contain only lowercase letters, numbers, and hyphens, and cannot start or end with a hyphen"
  )
  .refine(
    (s) => !isReservedOrgSlug(s),
    "This slug is reserved and cannot be used"
  );
