import "server-only";

import type { ApiResult } from "@repo/api/src/types/common";
import {
  SETTINGS_ACTOR_ROLES,
  SettingsActorRoleStatus,
} from "@repo/api/src/types/settings-actor-role";
import type {
  AuthorizeSettingsCommandInput,
  SettingsCommandCapability,
  SettingsCommandDecision,
} from "@repo/api/src/types/settings-command";
import { SettingsCommandDenialCode } from "@repo/api/src/types/settings-command";
import type { SettingsDomainId } from "@repo/api/src/types/settings-domain";
import { resolveSettingsDomainGrants } from "@repo/api/src/types/settings-domain";
import type { NextResponse } from "next/server";
import { readSettingsActorRole } from "@/app/settings/view-model/settings-actor-role-service";
import {
  OrgAdminDenialReason,
  roleUnresolvedResponse,
} from "@/lib/auth/org-admin-denial";
import { forbiddenResponse } from "@/lib/route-utils";

/**
 * @file settings-command.ts
 * @description The Settings authorization SERVICE: it decides one Settings
 * mutation from the actor's live organization role and the shared domain
 * policy, and turns a refusal into the response the route returns (ISS-8716).
 *
 * WHY IT LIVES IN `apps/api` AND THE TABLE DOES NOT. `SETTINGS_DOMAIN_ACCESS_POLICY`
 * is a serializable contract value both apps read — the view model is projected
 * from it and travels to a browser. The DECISION is server-side behavior with an
 * identity-provider dependency, so it belongs to the owning surface; ISS-8378
 * landed it in `packages/api/src/types/` where the repo's type-placement rule
 * reserves the directory for types both apps consume.
 *
 * WHY THE ROUTES CALL IT RATHER THAN KEEPING THEIR OWN CHECK. Moving the file
 * would not have closed the gap the ticket names: two policy sources drift
 * wherever they sit. What closes it is the write reading THE SAME TABLE the
 * projection is built from — for the boundaries listed below, and only those.
 *
 * MIGRATED BY ISS-8716, the whole set still served: `PUT /settings/frustration`, `PUT` and `DELETE /settings/pensero`,
 * `POST /organizations/invitations`, and the six mutation handlers under
 * `/custom-fields`.
 *
 * STILL ON `getOrgAdminStatus`/`requireOrgAdmin`, so a policy row does NOT move
 * them: `PUT /organizations/[id]`, the per-entity `custom-field-settings`
 * handlers, and every non-Settings admin gate (catalog, distributions). `GET /agent-components/compliance` is a
 * READ gate and cannot migrate at all — {@link SettingsCommandCapability} has no
 * `read` member by construction, because admitting one would let a read grant
 * satisfy a write gate.
 */

export type SettingsCommandGateInput = {
  clerkOrgId: string;
  clerkUserId: string;
  domain: SettingsDomainId;
  capability: SettingsCommandCapability;
};

/**
 * Decide one command, from the actor's resolved role and the domain policy.
 *
 * Order is load-bearing. An unresolved role is answered FIRST, before the
 * policy is consulted at all, because consulting it would mean choosing a role
 * we do not have; and `DomainReadOnly` is distinguished from
 * `InsufficientRole` so a caller cannot conclude from a refusal that some other
 * role would have succeeded when none would.
 *
 * THE DOMAIN'S WRITABILITY IS ASKED BEFORE THE ACTOR'S CAPABILITY, and that
 * order is the fix for a fail-open, not a tidy-up. `admin` and `owner` are ROLE
 * facts ANDed only with `read`, so on a read-only domain an admin still holds
 * `admin: true` — Compliance is exactly that shape (`read: admin+owner`,
 * `edit: []`). Consulting the grant first therefore answered `allowed: true`
 * for `capability: Admin` on a domain whose policy admits no mutation by
 * anyone, and never reached `DomainReadOnly`. A domain that no role may write
 * may not be written by the privileged rungs either.
 */
export function authorizeSettingsCommand(
  input: AuthorizeSettingsCommandInput
): SettingsCommandDecision {
  const { resolution } = input;

  if (resolution.status === SettingsActorRoleStatus.Unresolved) {
    return { allowed: false, code: SettingsCommandDenialCode.RoleUnresolved };
  }
  if (resolution.status === SettingsActorRoleStatus.NotAMember) {
    return { allowed: false, code: SettingsCommandDenialCode.NotAMember };
  }
  if (!isDomainMutableByAnyRole(input.domain)) {
    return { allowed: false, code: SettingsCommandDenialCode.DomainReadOnly };
  }

  const grants = resolveSettingsDomainGrants(input.domain, resolution.role);
  if (grants[input.capability]) {
    return { allowed: true, role: resolution.role };
  }

  return {
    allowed: false,
    code: isCapabilityReachableByAnyRole(input.domain, input.capability)
      ? SettingsCommandDenialCode.InsufficientRole
      : SettingsCommandDenialCode.DomainReadOnly,
  };
}

/**
 * Read the actor's role live and decide the command.
 *
 * The role read is the same one the view model performs, so the projection that
 * offered a control and the gate that admits its write cannot disagree about
 * who the actor is either. It never falls back to the session role claim: that
 * is minted with the token and survives a demotion.
 *
 * Prefer {@link requireSettingsCommand}; reach for the decision only where the
 * gate must also report WHY it refused (denial telemetry).
 */
export async function getSettingsCommandDecision(
  input: SettingsCommandGateInput
): Promise<SettingsCommandDecision> {
  const { resolution } = await readSettingsActorRole({
    clerkOrgId: input.clerkOrgId,
    clerkUserId: input.clerkUserId,
  });
  return authorizeSettingsCommand({
    resolution,
    domain: input.domain,
    capability: input.capability,
  });
}

/**
 * Gate a Settings mutation. Returns `null` when the caller is admitted,
 * otherwise the refusal response the caller should return as-is.
 */
export async function requireSettingsCommand(
  input: SettingsCommandGateInput
): Promise<NextResponse<ApiResult<never>> | null> {
  const decision = await getSettingsCommandDecision(input);
  return decision.allowed ? null : settingsCommandDenialResponse(decision.code);
}

/**
 * The response a refused command answers with, split by WHY it refused.
 *
 * Reuses the org-admin gate's own refusal helpers rather than restating 403 and
 * 503 here, so the wire copy and the `role_unresolved` code cannot drift
 * between the two gates a Settings route may go through. Exhaustive by
 * construction: a new denial code fails typecheck until it is answered, rather
 * than defaulting into the 403 that would tell an entitled admin they are
 * forbidden when the truth is that nobody could check.
 */
export function settingsCommandDenialResponse(
  code: SettingsCommandDenialCode
): NextResponse<ApiResult<never>> {
  return SETTINGS_COMMAND_DENIAL_RESPONSES[code]();
}

/**
 * The same refusal, as the reason `org_admin_gate_denied` carries, for a gate
 * enrolled in that monitor. The event's population is unchanged by this
 * mapping — only the gates that already reported still report.
 */
export function settingsCommandDenialReason(
  code: SettingsCommandDenialCode
): OrgAdminDenialReason {
  return SETTINGS_COMMAND_DENIAL_REASONS[code];
}

/**
 * Whether the domain admits ANY mutation, by any role — read off `edit` alone,
 * which is the policy's one statement about writability. Deliberately NOT
 * parameterised by capability: the privileged rungs are role facts that read
 * true on any readable domain, so asking them here would answer "mutable" for
 * a domain whose `edit` list is empty.
 */
function isDomainMutableByAnyRole(domain: SettingsDomainId): boolean {
  return SETTINGS_ACTOR_ROLES.some(
    (role) => resolveSettingsDomainGrants(domain, role).edit
  );
}

/**
 * Whether ANY role could have satisfied this capability on this domain. Asked
 * only on the refusal path of a domain already known to be mutable, to pick
 * between the two denial codes.
 */
function isCapabilityReachableByAnyRole(
  domain: SettingsDomainId,
  capability: SettingsCommandCapability
): boolean {
  return SETTINGS_ACTOR_ROLES.some(
    (role) => resolveSettingsDomainGrants(domain, role)[capability]
  );
}

const SETTINGS_COMMAND_DENIAL_RESPONSES: Record<
  SettingsCommandDenialCode,
  () => NextResponse<ApiResult<never>>
> = {
  [SettingsCommandDenialCode.RoleUnresolved]: roleUnresolvedResponse,
  [SettingsCommandDenialCode.NotAMember]: () => forbiddenResponse(),
  [SettingsCommandDenialCode.InsufficientRole]: () => forbiddenResponse(),
  [SettingsCommandDenialCode.DomainReadOnly]: () => forbiddenResponse(),
};

const SETTINGS_COMMAND_DENIAL_REASONS: Record<
  SettingsCommandDenialCode,
  OrgAdminDenialReason
> = {
  [SettingsCommandDenialCode.RoleUnresolved]:
    OrgAdminDenialReason.ProviderError,
  [SettingsCommandDenialCode.NotAMember]: OrgAdminDenialReason.NotAdmin,
  [SettingsCommandDenialCode.InsufficientRole]: OrgAdminDenialReason.NotAdmin,
  [SettingsCommandDenialCode.DomainReadOnly]: OrgAdminDenialReason.NotAdmin,
};
