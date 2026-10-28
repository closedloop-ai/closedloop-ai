/**
 * @file settings-domain.ts
 * @description The Settings data domains and the role policy governing each
 * (ISS-8378).
 *
 * A MIRROR, NOT A NEW RULE: every row is copied off gates the owning `apps/api`
 * route already enforces, and names them. The v1 page renders from one browser
 * `isAdmin` boolean while the server gates each domain separately, so the two
 * disagree; deriving this table from the server side lets a test pin them
 * together instead of adding a third opinion.
 *
 * It authorizes nothing by itself. The routes remain the boundary; ISS-8716
 * put the MIGRATED ones — the set enumerated in
 * `apps/api/lib/auth/settings-command.ts` — on this same table through
 * `authorizeSettingsCommand`, so for those, UI visibility and the write are
 * decided from one row rather than two opinions. Others still gate on
 * `getOrgAdminStatus`; that file names them.
 *
 * HOW MUCH A ROW EDIT ACTUALLY MOVES, because "both together" would be too
 * strong: every migrated gate asks for the `admin` rung, and `admin` is a role
 * fact ANDed with `read` (see {@link resolveSettingsDomainGrants}), not a
 * reading of `edit`. So editing `read`, or emptying `edit` entirely, moves the
 * projection AND the write; loosening a non-empty `edit` moves the projection
 * alone. That is the same asymmetry the `edit: true` note below states, not a
 * second rule.
 */
import type { SettingsActorRole } from "./settings-actor-role.ts";
import { SettingsActorRole as SettingsActorRoleValues } from "./settings-actor-role.ts";
import type { SettingsPanelId } from "./settings-panel.ts";
import {
  SETTINGS_PANEL_IDS,
  SettingsPanelId as SettingsPanelIdValues,
} from "./settings-panel.ts";

/**
 * The eleven Settings data domains, matching the eleven panels one-to-one.
 *
 * Kept as its own axis rather than reusing `SettingsPanelId` because a panel is
 * a place in the navigation and a domain is a body of data with an owning
 * route and an owning gate. They are a bijection today
 * ({@link SETTINGS_PANEL_DOMAIN}, pinned by a test), and naming them separately
 * is what lets that stay a checked fact instead of an assumption.
 */
export const SettingsDomainId = {
  Profile: "profile",
  Organization: "organization",
  Members: "members",
  Connections: "connections",
  Devices: "devices",
  ApiKeys: "api-keys",
  CustomFields: "custom-fields",
  Tags: "tags",
  Compliance: "compliance",
  Sync: "sync",
  /**
   * ISS-10286: the desktop app's own machine-local settings. The one domain
   * with no owning `apps/api` route at all — every read and write is
   * `window.desktopApi`, on the user's own machine — so the mirror this file
   * claims to be has nothing to mirror for it, which is itself the row's fact.
   */
  DesktopApp: "desktop-app",
} as const;

export type SettingsDomainId =
  (typeof SettingsDomainId)[keyof typeof SettingsDomainId];

/**
 * Which panel surfaces which domain. A bijection, asserted in
 * `settings-domain.test.ts` rather than trusted: a panel with no domain would
 * render with no policy behind it, and a domain with no panel would be a policy
 * nothing can reach.
 */
export const SETTINGS_PANEL_DOMAIN: Record<SettingsPanelId, SettingsDomainId> =
  {
    [SettingsPanelIdValues.Profile]: SettingsDomainId.Profile,
    [SettingsPanelIdValues.ConnectedDevices]: SettingsDomainId.Devices,
    [SettingsPanelIdValues.Plugins]: SettingsDomainId.Connections,
    [SettingsPanelIdValues.OrganizationGeneral]: SettingsDomainId.Organization,
    [SettingsPanelIdValues.Members]: SettingsDomainId.Members,
    [SettingsPanelIdValues.CustomFields]: SettingsDomainId.CustomFields,
    [SettingsPanelIdValues.Tags]: SettingsDomainId.Tags,
    [SettingsPanelIdValues.Compliance]: SettingsDomainId.Compliance,
    [SettingsPanelIdValues.ApiKeys]: SettingsDomainId.ApiKeys,
    [SettingsPanelIdValues.OtherLabs]: SettingsDomainId.Sync,
    [SettingsPanelIdValues.DesktopApp]: SettingsDomainId.DesktopApp,
  };

/** Which roles may read a domain, and which may write it. */
export type SettingsDomainAccessRule = {
  read: readonly SettingsActorRole[];
  edit: readonly SettingsActorRole[];
};

const EVERY_ROLE: readonly SettingsActorRole[] = [
  SettingsActorRoleValues.Member,
  SettingsActorRoleValues.Admin,
  SettingsActorRoleValues.Owner,
];

const ADMIN_AND_OWNER: readonly SettingsActorRole[] = [
  SettingsActorRoleValues.Admin,
  SettingsActorRoleValues.Owner,
];

const NO_ROLE: readonly SettingsActorRole[] = [];

/**
 * THE policy, one row per domain.
 *
 * THE RULE: `read` is the gate on the domain's reads. `edit` is the LOOSEST
 * write the domain admits — "may perform at least one write here", never "every
 * write here" — and an admin-gated write inside a domain rides the `admin` rung
 * rather than being expressed by withholding `edit` from everyone.
 *
 * Taking the STRICTEST write instead was tried and rejected: it silently
 * withdraws capabilities members hold today (their own integration disconnects,
 * the org rename). Which member-reachable controls v2 may withhold is a product
 * decision, so this table makes none and mirrors what the routes allow.
 *
 * Consequently `edit: true` permits rendering a domain's writable surface, not
 * every control in it: a control backed by an admin-gated write must be gated
 * on `admin` through `authorizeSettingsCommand`, or a member is offered a
 * button its route answers 403 to.
 *
 * Rows, and the gates each was read from:
 *
 * - **Profile** — `GET /me`, `PUT /users/[id]`: ungated; the actor's own record.
 * - **Organization** — `GET` open to any member. A `PUT` naming an
 *   `ADMIN_ONLY_ORGANIZATION_FIELDS` member or the slug goes through
 *   `getOrgAdminStatus`; a `{ name }`-only body reaches
 *   `updateOrganizationLocally` with no role check.
 * - **Members** — reads open to any member; every write admin-gated through
 *   `requireSettingsCommand`. Deliberately not enumerated: the write set grows
 *   with PLN-1911's membership and invitation mutations, so a list of routes
 *   here would go stale on each one.
 * - **Connections** — `GET /integrations/*` and `GET /settings/pensero` open to
 *   any member. `DELETE /integrations/{github,google,linear}` are ungated;
 *   `PUT`/`DELETE /settings/pensero` is admin-gated.
 * - **Devices** — `GET /compute-targets` open to any member; writes are
 *   owner-of-target scoped (`updateOwned`/`deleteOwned`), not role scoped.
 * - **ApiKeys** — reads open to any member. `POST /api-keys` and the user
 *   Claude key writes are ungated; the org Claude key write is admin-gated.
 * - **CustomFields** — `GET` open to any member; `POST`/`PUT`/`DELETE` all call
 *   `isOrgAdmin`.
 * - **Tags** — no admin gate anywhere in `apps/api/app/tags`.
 * - **Compliance** — the ONLY gated READ:
 *   `GET /agent-components/compliance` calls `isOrgAdmin` and answers 403.
 *   Read-only, so `edit` is empty for every role rather than mirroring `read`.
 * - **Sync** — `calculateSessionFrustration` is member-readable and
 *   admin-writable (`PUT /settings/frustration`).
 * - **DesktopApp** — no gate to mirror. There is no route: the controls read and
 *   write the local Electron main process over `window.desktopApi`, on the
 *   machine the actor is sitting at. Every role therefore reads and writes,
 *   because an org role is not a fact about somebody's own laptop, and
 *   withholding it here would be this table inventing a rule rather than
 *   copying one — which the header says it must not do.
 */
export const SETTINGS_DOMAIN_ACCESS_POLICY: Record<
  SettingsDomainId,
  SettingsDomainAccessRule
> = {
  [SettingsDomainId.Profile]: { read: EVERY_ROLE, edit: EVERY_ROLE },
  [SettingsDomainId.Organization]: { read: EVERY_ROLE, edit: EVERY_ROLE },
  [SettingsDomainId.Members]: { read: EVERY_ROLE, edit: ADMIN_AND_OWNER },
  [SettingsDomainId.Connections]: { read: EVERY_ROLE, edit: EVERY_ROLE },
  [SettingsDomainId.Devices]: { read: EVERY_ROLE, edit: EVERY_ROLE },
  [SettingsDomainId.ApiKeys]: { read: EVERY_ROLE, edit: EVERY_ROLE },
  [SettingsDomainId.CustomFields]: { read: EVERY_ROLE, edit: ADMIN_AND_OWNER },
  [SettingsDomainId.Tags]: { read: EVERY_ROLE, edit: EVERY_ROLE },
  [SettingsDomainId.Compliance]: { read: ADMIN_AND_OWNER, edit: NO_ROLE },
  [SettingsDomainId.Sync]: { read: EVERY_ROLE, edit: ADMIN_AND_OWNER },
  [SettingsDomainId.DesktopApp]: { read: EVERY_ROLE, edit: EVERY_ROLE },
};

/**
 * How a domain's ACCESS question turned out. Four values, each rendered
 * differently. The reason the axis exists: ten places on the v1 Settings page
 * destructure `{ data: xs = [] }` and never read `isError`, so a 403, a 500 and
 * a timeout each render as a confident "you have none".
 *
 * No `Empty` or `Pending` here — those are properties of a domain's own payload
 * read, which each panel still performs, and inventing them here would be
 * contract surface with no producer.
 */
export const SettingsDomainStatus = {
  /** The actor may read this domain. */
  Ready: "ready",
  /** The actor's role does not admit reading this domain. An ANSWER. */
  Forbidden: "forbidden",
  /** This host or build does not offer the domain. Not a denial. */
  Unavailable: "unavailable",
  /** The read failed, or the actor's role could not be determined. */
  Error: "error",
} as const;

export type SettingsDomainStatus =
  (typeof SettingsDomainStatus)[keyof typeof SettingsDomainStatus];

/**
 * Why a domain could not be decided. Only ever set on `Error`.
 *
 * There is deliberately no not-a-member reason: that lookup SETTLED, so it
 * projects as `Forbidden` and never reaches this axis. A value for it would be
 * contract surface no producer can emit.
 */
export const SettingsDomainFailureReason = {
  /** The upstream that owns the domain threw, timed out, or was unreachable. */
  UpstreamUnavailable: "upstream_unavailable",
  /** The actor's membership role could not be read, so nothing can be decided. */
  RoleUnresolved: "role_unresolved",
} as const;

export type SettingsDomainFailureReason =
  (typeof SettingsDomainFailureReason)[keyof typeof SettingsDomainFailureReason];

/**
 * What the actor may do with a domain once its read settled. Separate booleans
 * rather than a single level, because "may read but not write" is the common
 * case and the ticket requires members to receive read and edit SEPARATELY.
 */
export type SettingsDomainGrants = {
  read: boolean;
  edit: boolean;
  admin: boolean;
  owner: boolean;
};

/** No capability at all — the shape a denial and an unreadable role both carry. */
export const NO_SETTINGS_DOMAIN_GRANTS: SettingsDomainGrants = {
  read: false,
  edit: false,
  admin: false,
  owner: false,
};

/**
 * What one role may do with one domain, read off {@link SETTINGS_DOMAIN_ACCESS_POLICY}.
 *
 * `admin` and `owner` are role facts rather than per-domain ones: they say what
 * authority the actor carries, which is what an admin-only or owner-only
 * COMMAND is gated on. They are ANDed with `read` so a domain the actor may not
 * even read never reports admin authority over it — otherwise Compliance would
 * hand a member `admin: false, read: false` and an admin `admin: true` while a
 * hypothetical fourth role could report authority over a domain it cannot see.
 */
export function resolveSettingsDomainGrants(
  domain: SettingsDomainId,
  role: SettingsActorRole
): SettingsDomainGrants {
  const rule = SETTINGS_DOMAIN_ACCESS_POLICY[domain];
  const read = rule.read.includes(role);
  return {
    read,
    edit: rule.edit.includes(role),
    admin:
      read &&
      (role === SettingsActorRoleValues.Admin ||
        role === SettingsActorRoleValues.Owner),
    owner: read && role === SettingsActorRoleValues.Owner,
  };
}

/**
 * Whether an `apps/api` route is the AUTHORITY on a domain's access, keyed
 * exhaustively so a new domain must answer this here rather than inherit a
 * default (ISS-10286, davetho #4038745930).
 *
 * Every domain but one is answered by the server, and a grant absent from a
 * `GET /settings/view-model` response for those is a real denial. `DesktopApp`
 * is the exception and is exceptional by NATURE, not by rollout stage: its
 * controls read and write the local Electron main process over
 * `window.desktopApi`, on the machine the actor is sitting at, so there is no
 * route to ask and no org role that could withhold it.
 *
 * WHAT THIS IS FOR. `apps/api` and the Desktop build deploy separately. A
 * desktop binary carrying this panel can meet an already-released view-model
 * response that predates the id, and turning that omission into `forbidden`
 * would lock a user out of their own machine's settings until the API caught
 * up — the version-skew failure the repo's cross-repo rule forbids.
 */
export const SETTINGS_DOMAIN_HAS_SERVER_AUTHORITY: Record<
  SettingsDomainId,
  boolean
> = {
  [SettingsDomainId.Profile]: true,
  [SettingsDomainId.Organization]: true,
  [SettingsDomainId.Members]: true,
  [SettingsDomainId.Connections]: true,
  [SettingsDomainId.Devices]: true,
  [SettingsDomainId.ApiKeys]: true,
  [SettingsDomainId.CustomFields]: true,
  [SettingsDomainId.Tags]: true,
  [SettingsDomainId.Compliance]: true,
  [SettingsDomainId.Sync]: true,
  [SettingsDomainId.DesktopApp]: false,
};

/**
 * The panels no server answers for, DERIVED from the record above rather than
 * listed again: a side inventory of the same members compiles fine when a
 * member is added, which is the hole a hand-written list leaves open.
 */
export const LOCALLY_AUTHORITATIVE_SETTINGS_PANEL_IDS: readonly SettingsPanelId[] =
  Object.freeze(
    SETTINGS_PANEL_IDS.filter(
      (id) => !SETTINGS_DOMAIN_HAS_SERVER_AUTHORITY[SETTINGS_PANEL_DOMAIN[id]]
    )
  );
