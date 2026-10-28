import type { ApiResult } from "@repo/api/src/types/common";
import type { NextResponse } from "next/server";
import type { OrgAdminStatus } from "@/lib/auth/org-admin";
import { OrgAdminDenialReason } from "@/lib/auth/org-admin-denial";
import { forbiddenResponse } from "@/lib/route-utils";

/**
 * Doubles for an admin-style route gate, shared by the suites that stub the
 * gate function rather than the Clerk client behind it.
 *
 * `requireOrgAdmin` and — since ISS-8716 — `requireSettingsCommand` answer the
 * same way: `null` for an admitted caller and the refusal response otherwise,
 * so a stub returning a bare boolean would be truthy in BOTH directions and
 * `true` would read as a refusal. These names make the two answers
 * unmistakable at the call site, whichever of the two a route stubs.
 */
export const ORG_ADMIN_ADMITTED: NextResponse<ApiResult<never>> | null = null;

/** A genuine non-admin refusal. Fresh response per call: a body is read once. */
export function orgAdminRefused(): NextResponse<ApiResult<never>> {
  return forbiddenResponse();
}

/** Clerk answered and the caller holds no privileged role. */
export const ORG_ADMIN_STATUS_NOT_ADMIN: OrgAdminStatus = {
  isAdmin: false,
  reason: OrgAdminDenialReason.NotAdmin,
};

/** Clerk could not be reached, so no role was resolved at all. */
export const ORG_ADMIN_STATUS_PROVIDER_ERROR: OrgAdminStatus = {
  isAdmin: false,
  reason: OrgAdminDenialReason.ProviderError,
};

export const ORG_ADMIN_STATUS_ADMIN: OrgAdminStatus = {
  isAdmin: true,
  reason: "admin",
};
