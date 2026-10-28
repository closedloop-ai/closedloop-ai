import type { Prisma } from "@repo/database";

/**
 * Deactivated and deleted orgs carry `active: false`. Shared by the ingestion
 * policy lookup and the fleet org count (ISS-12050) so the two agree on which
 * orgs exist.
 */
export const ACTIVE_ORGANIZATION_WHERE = {
  active: true,
} as const satisfies Prisma.OrganizationWhereInput;
