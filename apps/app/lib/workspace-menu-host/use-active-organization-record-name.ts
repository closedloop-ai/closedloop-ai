"use client";

import { useOrganization as useOrganizationRecord } from "@repo/app/organizations/hooks/use-organizations";
import { useCurrentUser } from "@repo/app/users/hooks/use-users";

/**
 * ISS-12135: the product's own name for the active Clerk organization, or
 * `null` until that record is read (or if it names a different organization).
 *
 * A seeded `$vibe` preview binds the person's real Clerk organization to the
 * seeded org row in its own schema (ISS-12056), named "<their email> Co"
 * (ISS-12135), and no Clerk organization is ever renamed for it (ISS-12135
 * decision), so only this record carries the seeded name. Matched on `clerkId` so a stale read from before a workspace
 * switch never labels the new one.
 */
export function useActiveOrganizationRecordName(
  clerkOrganizationId: string | null
): string | null {
  const currentUser = useCurrentUser({
    enabled: clerkOrganizationId !== null,
  });
  const organizationId = currentUser.data?.organizationId ?? "";
  const { data: organization } = useOrganizationRecord(organizationId, {
    enabled: clerkOrganizationId !== null && organizationId !== "",
  });
  if (!organization || organization.clerkId !== clerkOrganizationId) {
    return null;
  }
  return organization.name;
}
