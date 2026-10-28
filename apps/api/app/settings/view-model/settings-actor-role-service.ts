import "server-only";

import {
  resolveSettingsActorRole,
  type SettingsActorRoleResolution,
  SettingsActorRoleStatus,
  SettingsActorRoleUnresolvedReason,
} from "@repo/api/src/types/settings-actor-role";
import { log } from "@repo/observability/log";
import { clerkService } from "@/lib/auth/clerk-service";

/**
 * Diagnostic event for a membership read that could not complete (ISS-8378).
 *
 * NOT an alert, and deliberately not folded into `org_admin_gate_denied`: that
 * event carries the six org-policy-WRITE gates, its monitor threshold was
 * baselined against that population, and its own contract says admitting a
 * signal from outside it is a decision about what the alert means rather than
 * a mechanical extension. This line exists so the outage is greppable next to
 * the `error` the caller already receives; the user-visible signal is that
 * explicit error state, not this log.
 *
 * SINCE ISS-8716 THIS IS NOT ONLY A READ-PATH EVENT. The Settings mutation
 * boundaries migrated by that ticket — the set enumerated in
 * `apps/api/lib/auth/settings-command.ts`, not every admin-gated write in
 * `apps/api` — resolve the actor's role through {@link readSettingsActorRole},
 * so an unreadable role on one of those writes emits this too. That widened the
 * event's population deliberately: it is the same failure with the same remedy.
 * `org_admin_gate_denied`'s population is untouched, and that is the one a
 * monitor keys on.
 */
const SETTINGS_ACTOR_ROLE_UNREADABLE_EVENT = "settings_actor_role_unreadable";

export type SettingsActorRoleRead = {
  resolution: SettingsActorRoleResolution;
  /** The session claim disagreed with the live read. Reported, never trusted. */
  staleSessionRole: boolean;
};

export type ReadSettingsActorRoleInput = {
  clerkOrgId: string;
  clerkUserId: string;
  /**
   * `AuthContext.orgRole`. Usually the role claim minted into the caller's
   * Clerk session; absent on `sk_live_` API-key and desktop-session requests.
   * NOT always a claim: when `x-organization-id` names a non-session org,
   * `resolveOrgHeader` has already read the role live and puts THAT here, so a
   * disagreement is impossible on that path and `staleSessionRole` is false.
   * Either way it is only ever compared, never authorized on.
   */
  sessionRole?: string;
};

/**
 * Read the actor's organization role, authoritatively.
 *
 * THE LIVE READ WINS, AND A FAILED ONE DOES NOT FALL BACK. The session claim is
 * minted with the token and does not change when an admin is demoted, so
 * authorizing off it grants a revoked role for the token's lifetime. It is used
 * only to detect that disagreement and report it as
 * {@link SettingsActorRoleRead.staleSessionRole}. Falling back to it during an
 * outage would turn a failure into a stale grant.
 *
 * It is also what makes this correct for non-browser callers: an `sk_live_` key
 * and a desktop-session token carry no `orgRole` at all, so a claim-based
 * projection reports every desktop caller as `member` whatever their authority.
 */
export async function readSettingsActorRole(
  input: ReadSettingsActorRoleInput
): Promise<SettingsActorRoleRead> {
  let liveRole: string | null;
  try {
    liveRole = await clerkService.getOrganizationMembershipRole(
      input.clerkOrgId,
      input.clerkUserId
    );
  } catch (error) {
    log.error(SETTINGS_ACTOR_ROLE_UNREADABLE_EVENT, {
      clerkOrgId: input.clerkOrgId,
      clerkUserId: input.clerkUserId,
      reason: SettingsActorRoleUnresolvedReason.ProviderError,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      resolution: {
        status: SettingsActorRoleStatus.Unresolved,
        reason: SettingsActorRoleUnresolvedReason.ProviderError,
      },
      staleSessionRole: false,
    };
  }

  const resolution = resolveSettingsActorRole(liveRole);
  if (resolution.status === SettingsActorRoleStatus.Unresolved) {
    // Reached when the lookup SUCCEEDED and returned a membership whose role is
    // unusable. Same event as the throw above because it is the same outcome
    // for the caller — an unreadable role and a retryable 503 — and the
    // `reason` field is what separates corrupt data from an outage. The role
    // value itself is not logged: it is provider data of unknown shape.
    log.error(SETTINGS_ACTOR_ROLE_UNREADABLE_EVENT, {
      clerkOrgId: input.clerkOrgId,
      clerkUserId: input.clerkUserId,
      reason: resolution.reason,
    });
  }
  return {
    resolution,
    staleSessionRole: isSessionRoleStale(input.sessionRole, liveRole),
  };
}

/**
 * Stale only when BOTH values are present and differ. A caller with no session
 * claim (API key, desktop session) is not stale — it never made a claim — and
 * reporting it as stale would send every desktop user to a pointless re-login.
 */
function isSessionRoleStale(
  sessionRole: string | undefined,
  liveRole: string | null
): boolean {
  if (typeof sessionRole !== "string" || sessionRole.length === 0) {
    return false;
  }
  return sessionRole !== (liveRole ?? "");
}
