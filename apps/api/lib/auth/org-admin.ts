import { log } from "@repo/observability/log";
import { clerkService } from "@/lib/auth/clerk-service";

const ADMIN_ROLES = new Set(["org:admin", "org:owner"]);

export async function isOrgAdmin(
  clerkOrgId: string,
  clerkUserId: string
): Promise<boolean> {
  try {
    const role = await clerkService.getOrganizationMembershipRole(
      clerkOrgId,
      clerkUserId
    );
    return ADMIN_ROLES.has(role);
  } catch (error) {
    log.error("Failed to resolve Clerk org role", {
      clerkOrgId,
      clerkUserId,
      error,
    });
    return false;
  }
}
