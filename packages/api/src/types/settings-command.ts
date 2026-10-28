/**
 * @file settings-command.ts
 * @description The contract vocabulary of a Settings mutation: the authority it
 * requires, and why a refused one was refused (ISS-8378).
 *
 * VALUES ONLY. The decision itself is server behavior with an
 * identity-provider dependency and lives with the surface that owns it,
 * `apps/api/lib/auth/settings-command.ts` (ISS-8716), which the Settings
 * mutation boundaries enumerated there call.
 *
 * NOT ON THE WIRE, and do not read the codes below as if they were. A refused
 * command answers with the org-admin gate's existing shapes — a bare 403, or a
 * 503 carrying `OrgAdminGateErrorCode.RoleUnresolved` — so no value declared
 * here is serialized into a response body today. They are the vocabulary the
 * gate branches on in-process and the key its telemetry reason is mapped from.
 * Serializing them would be new wire surface with no consumer asking for it,
 * and respelling the 503's existing `role_unresolved` would break the clients
 * already handling it; both are their own decision, not a tidy-up.
 */
import type {
  SettingsActorRole,
  SettingsActorRoleResolution,
} from "./settings-actor-role.ts";
import type { SettingsDomainId } from "./settings-domain.ts";

/**
 * The authority a command requires. `read` is deliberately absent — this axis
 * governs mutations, and admitting a read capability here would let a caller
 * satisfy a write gate with a read grant.
 */
export const SettingsCommandCapability = {
  Edit: "edit",
  Admin: "admin",
  Owner: "owner",
} as const;

export type SettingsCommandCapability =
  (typeof SettingsCommandCapability)[keyof typeof SettingsCommandCapability];

/**
 * Why a command was refused. These are contract values a programmatic caller
 * branches on, so they are stable strings, not prose.
 *
 * {@link SettingsCommandDenialCode.RoleUnresolved} is the one that is NOT a
 * denial in substance: the caller may well be entitled, and the server could
 * not find out. It is kept separate precisely so a route can answer 503 to it
 * and 403 to the rest — folding it into a denial tells an entitled admin they
 * are forbidden and invites them to stop retrying something a provider outage
 * would have fixed on its own.
 */
export const SettingsCommandDenialCode = {
  /** Membership could not be read. Retryable; NOT an authorization answer. */
  RoleUnresolved: "settings_role_unresolved",
  /** The lookup settled and the actor is not a member of this organization. */
  NotAMember: "settings_not_a_member",
  /** The actor is a member and their role does not carry this authority. */
  InsufficientRole: "settings_insufficient_role",
  /** The domain accepts no mutations at all, for any role. */
  DomainReadOnly: "settings_domain_read_only",
} as const;

export type SettingsCommandDenialCode =
  (typeof SettingsCommandDenialCode)[keyof typeof SettingsCommandDenialCode];

export type SettingsCommandDecision =
  | { allowed: true; role: SettingsActorRole }
  | { allowed: false; code: SettingsCommandDenialCode };

export type AuthorizeSettingsCommandInput = {
  resolution: SettingsActorRoleResolution;
  domain: SettingsDomainId;
  capability: SettingsCommandCapability;
};
