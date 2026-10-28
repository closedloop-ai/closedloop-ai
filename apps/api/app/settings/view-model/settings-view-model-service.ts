import "server-only";

import {
  projectSettingsViewModel,
  type SettingsViewModel,
} from "@repo/api/src/types/settings-view-model";
import {
  type ReadSettingsActorRoleInput,
  readSettingsActorRole,
} from "./settings-actor-role-service";

/**
 * Build the Settings view model for one actor (ISS-8378).
 *
 * QUERY BUDGET, the justification for this endpoint: ONE Clerk membership read
 * inside the handler and zero database queries; the rest is a pure projection
 * over contract tables. It replaces one uncached
 * `getOrganizationMembershipRole` per admin-gated surface plus a client-side
 * `isAdmin` boolean racing eleven server gates. It aggregates authorization,
 * not data: each panel still reads its own domain through the owning route.
 *
 * THE HANDLER'S READ IS NOT ALWAYS THE REQUEST'S ONLY ONE, and claiming
 * otherwise would be wrong on a real path. When `x-organization-id` names an
 * org other than the session's, `resolveOrgHeader` has already spent a
 * `getOrganizationMembershipRole` on the same pair to verify the header, so
 * that request costs two. Deduplicating them would mean reading authority off
 * `AuthContext.orgRole`, which on the session path is a token-time CLAIM that
 * survives a demotion — the one thing this service exists not to do — and
 * `AuthContext` does not say which of the two it is carrying. Collapsing it
 * therefore needs the auth wrappers to distinguish a verified live role from a
 * claim; until they do, the budget is one call per request on the common path
 * and two on the org-switch path.
 */
export async function buildSettingsViewModel(
  input: ReadSettingsActorRoleInput
): Promise<SettingsViewModel> {
  const read = await readSettingsActorRole(input);
  return projectSettingsViewModel({
    resolution: read.resolution,
    staleSessionRole: read.staleSessionRole,
  });
}
