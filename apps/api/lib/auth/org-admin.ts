import { log } from "@repo/observability/log";
import { clerkService } from "@/lib/auth/clerk-service";

const ADMIN_ROLES = new Set(["org:admin", "org:owner"]);

export type OrgAdminStatus =
  | { isAdmin: true; reason: "admin" }
  | { isAdmin: false; reason: "not_admin" | "provider_error" };

export async function getOrgAdminStatus(
  clerkOrgId: string,
  clerkUserId: string
): Promise<OrgAdminStatus> {
  try {
    const role = await clerkService.getOrganizationMembershipRole(
      clerkOrgId,
      clerkUserId
    );
    if (!role) {
      return { isAdmin: false, reason: "not_admin" };
    }
    if (!ADMIN_ROLES.has(role)) {
      return { isAdmin: false, reason: "not_admin" };
    }
    return { isAdmin: true, reason: "admin" };
  } catch (error) {
    log.error("Failed to resolve Clerk org role", {
      clerkOrgId,
      clerkUserId,
      error,
    });
    return { isAdmin: false, reason: "provider_error" };
  }
}

export async function isOrgAdmin(
  clerkOrgId: string,
  clerkUserId: string
): Promise<boolean> {
  const status = await getOrgAdminStatus(clerkOrgId, clerkUserId);
  return status.isAdmin;
}
