import "server-only";

import type { ApiResult } from "@repo/api/src/types/common";
import { SettingsCommandCapability } from "@repo/api/src/types/settings-command";
import { SettingsDomainId } from "@repo/api/src/types/settings-domain";
import type { NextResponse } from "next/server";
import { requireSettingsCommand } from "@/lib/auth/settings-command";

/**
 * The Custom Fields domain's write gate, stated once for the six mutation
 * handlers under `/custom-fields` (ISS-8716).
 *
 * Shared so the domain/capability pair cannot drift between the definition
 * routes and the enum-option routes: a divergence there would mean two of them
 * enforce a rule the Settings projection does not advertise.
 */
export function requireCustomFieldsAdmin(
  clerkOrgId: string,
  clerkUserId: string
): Promise<NextResponse<ApiResult<never>> | null> {
  return requireSettingsCommand({
    clerkOrgId,
    clerkUserId,
    domain: SettingsDomainId.CustomFields,
    capability: SettingsCommandCapability.Admin,
  });
}
