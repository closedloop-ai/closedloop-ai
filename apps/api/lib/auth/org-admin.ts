import type { ApiResult } from "@repo/api/src/types/common";
import { isOrgAdminRole } from "@repo/api/src/types/org-admin-role";
import { log } from "@repo/observability/log";
import type { NextResponse } from "next/server";
import { clerkService } from "@/lib/auth/clerk-service";
import {
  OrgAdminDenialReason,
  orgAdminDenialResponse,
} from "@/lib/auth/org-admin-denial";

export type OrgAdminStatus =
  | { isAdmin: true; reason: "admin" }
  | { isAdmin: false; reason: OrgAdminDenialReason };

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
      return { isAdmin: false, reason: OrgAdminDenialReason.NotAdmin };
    }
    if (!isOrgAdminRole(role)) {
      return { isAdmin: false, reason: OrgAdminDenialReason.NotAdmin };
    }
    return { isAdmin: true, reason: "admin" };
  } catch (error) {
    log.error("Failed to resolve Clerk org role", {
      clerkOrgId,
      clerkUserId,
      error,
    });
    return { isAdmin: false, reason: OrgAdminDenialReason.ProviderError };
  }
}

/**
 * Gate a route on org-admin authority. Returns `null` when the caller is
 * admitted, otherwise the refusal response the caller should return as-is.
 *
 * Prefer this over reading {@link getOrgAdminStatus} directly; reach for the
 * status only where the gate also has to report the reason (denial telemetry)
 * or needs the verdict as a capability rather than a stop.
 */
export async function requireOrgAdmin(
  clerkOrgId: string,
  clerkUserId: string
): Promise<NextResponse<ApiResult<never>> | null> {
  const status = await getOrgAdminStatus(clerkOrgId, clerkUserId);
  return status.isAdmin ? null : orgAdminDenialResponse(status.reason);
}
