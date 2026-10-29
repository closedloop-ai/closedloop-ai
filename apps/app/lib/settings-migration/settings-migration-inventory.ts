/**
 * @file settings-migration-inventory.ts
 * @description ISS-8380 — the OPEN half of the Settings legacy-to-v2 migration
 * matrix: the routes, endpoints, commands, role checks, and data fields the
 * legacy Settings surface owns, each with the v2 owner that inherits it. The
 * closed tab↔panel ownership maps are the sibling
 * `./settings-migration-matrix.ts`.
 *
 * An INVENTORY, not a closed set: nothing mechanical proves the list is
 * complete, and that is stated rather than implied. Two things about it ARE
 * mechanical, and are asserted in `__tests__/settings-migration-inventory.test.ts`
 * against the tree rather than against this file:
 *
 *   1. every `legacyOwner` resolves to a real file, and
 *   2. every endpoint row's {@link SettingsMigrationEntry.methods} equals the
 *      HTTP methods that route file actually exports.
 *
 * The second is why each endpoint row names ONE route file: the grouped rows
 * this replaced ("GET /settings/api-keys, /settings/api-keys/org, …") read as
 * fact and were wrong in four places — `/organizations/{id}` takes `PUT` and
 * never `PATCH`, `/settings/api-keys/{org,user}` have no `GET` at all,
 * `/api-keys/{id}` has no `GET`, and `/compute-targets/{id}/sharing` takes
 * `PATCH` and not `PUT`. A matrix a reader cannot check is a matrix that drifts.
 *
 * Sibling sub-routes that share a row's owner and compatibility class are named
 * in its `note`; those are prose and are NOT machine-checked.
 */

import type { SettingsPanelId } from "@repo/api/src/types/settings-panel";
import { SettingsPanelId as SettingsPanelIdValues } from "@repo/api/src/types/settings-panel";

export const SettingsMigrationSubject = {
  Route: "route",
  Endpoint: "endpoint",
  Command: "command",
  RoleCheck: "role-check",
  DataField: "data-field",
} as const;

export type SettingsMigrationSubject =
  (typeof SettingsMigrationSubject)[keyof typeof SettingsMigrationSubject];

/** The HTTP methods a Next route module may export. */
export const SettingsMigrationHttpMethod = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Patch: "PATCH",
  Delete: "DELETE",
} as const;

export type SettingsMigrationHttpMethod =
  (typeof SettingsMigrationHttpMethod)[keyof typeof SettingsMigrationHttpMethod];

export const SETTINGS_MIGRATION_HTTP_METHODS: readonly SettingsMigrationHttpMethod[] =
  Object.values(SettingsMigrationHttpMethod);

/**
 * What this entry's contract does during the rollout and rollback window.
 *
 * None of the three permits a removal. `RetainedAlias` is the strongest claim
 * in the matrix and it still only means "kept until the removal gate is
 * satisfied and a human approves".
 */
export const SettingsMigrationCompatibility = {
  /** v2 consumes the identical identifier; nothing to alias. */
  Unchanged: "unchanged",
  /**
   * Legacy identifier retained for clients that cannot be upgraded in step —
   * bookmarks, shipped Desktop builds, in-flight OAuth round trips.
   */
  RetainedAlias: "retained-alias",
  /** Introduced by v2, therefore optional on the wire for every older client. */
  V2Additive: "v2-additive",
} as const;

export type SettingsMigrationCompatibility =
  (typeof SettingsMigrationCompatibility)[keyof typeof SettingsMigrationCompatibility];

export type SettingsMigrationEntry = {
  subject: SettingsMigrationSubject;
  /** The legacy identifier: a path, an API route, an event name, a column. */
  legacy: string;
  /** Repo-relative path of the module that owns it today. */
  legacyOwner: string;
  /**
   * The v2 panel that inherits it, or `null` when no panel owns it.
   *
   * `null` is load-bearing rather than cosmetic: a row with no v2 owner is a
   * legacy surface whose subject matter would have nowhere to go, so it BLOCKS
   * removal of whatever carries it. Fill this in only against a panel that
   * actually implements the row — a plausible-looking owner that cannot render
   * the subject is worse than an honest gap, because the gate then reads as
   * satisfied. The unowned rows are enumerated in
   * `docs/runbooks/settings-v2-legacy-removal-checklist.md`.
   */
  v2Panel: SettingsPanelId | null;
  compatibility: SettingsMigrationCompatibility;
  /**
   * For an endpoint row: the HTTP methods `legacyOwner` exports, checked
   * against the route module itself. Absent on every other subject.
   */
  methods?: readonly SettingsMigrationHttpMethod[];
  note: string;
};

/**
 * The inventory. Every `legacyOwner` is a real path on `main` so a reader can
 * check a row rather than trust it.
 */
export const SETTINGS_MIGRATION_INVENTORY: readonly SettingsMigrationEntry[] = [
  {
    subject: SettingsMigrationSubject.Route,
    legacy: "/{orgSlug}/settings",
    legacyOwner: "apps/app/app/(authenticated)/[orgSlug]/settings/page.tsx",
    v2Panel: null,
    compatibility: SettingsMigrationCompatibility.RetainedAlias,
    note: "Settings root. The path survives the migration, but what it serves does not: ISS-8977 made v2 Settings a MODAL over the surface the user was on, so on the v2 tree this route mounts a dialog and `?returnTo=` decides where dismissing it lands. The root experience selector chooses the tree.",
  },
  {
    subject: SettingsMigrationSubject.Route,
    legacy: "/{orgSlug}/settings?tab={SettingsTab}",
    legacyOwner:
      "apps/app/app/(authenticated)/[orgSlug]/settings/settings-tabs.ts",
    v2Panel: null,
    compatibility: SettingsMigrationCompatibility.RetainedAlias,
    note: "Bookmarked tab deep link. Forward-mapped by LEGACY_SETTINGS_TAB_SUCCESSOR; ?tab= keeps precedence over ?panel= on the legacy tree.",
  },
  {
    subject: SettingsMigrationSubject.Route,
    legacy: "/{orgSlug}/settings?panel={SettingsPanelId}",
    legacyOwner: "packages/api/src/types/settings-route-links.ts",
    v2Panel: null,
    compatibility: SettingsMigrationCompatibility.V2Additive,
    note: "The v2 deep link. Accepted by the legacy page as a lowest-precedence alias so a v2 bookmark survives a rollback.",
  },
  {
    subject: SettingsMigrationSubject.Route,
    legacy: "/{orgSlug}/settings?tab=integrations#anthropic-api-key",
    legacyOwner: "apps/app/lib/settings-migration/settings-migration-matrix.ts",
    v2Panel: SettingsPanelIdValues.ApiKeys,
    compatibility: SettingsMigrationCompatibility.RetainedAlias,
    note: "Card anchor deep link, kept for bookmarks. The Anthropic key card it named was removed with Loops (PRD-795, ISS-12435). A bare ?tab=integrations forward-maps to Plugins; with this fragment the v2 root replaces it with ?panel=api-keys#anthropic-api-key on the client (LEGACY_SETTINGS_TAB_FRAGMENT_SUCCESSOR), because the server never sees the fragment.",
  },
  {
    subject: SettingsMigrationSubject.Route,
    legacy: "/settings/integrations/desktop/authorize",
    legacyOwner:
      "apps/app/app/(authenticated)/settings/integrations/desktop/authorize/page.tsx",
    v2Panel: SettingsPanelIdValues.ConnectedDevices,
    compatibility: SettingsMigrationCompatibility.RetainedAlias,
    note: "Hard-coded in shipped Desktop BINARIES at apps/desktop/src/main/auth/desktop-authorize-client.ts, which is the citation removal gate 4 needs — apps/app/lib/github-connect-redirect.ts holds the same literal but is the WEB proxy's interceptor, an importer grep can see and not a client that cannot be upgraded. Must never be rewritten by a Settings route change.",
  },
  {
    subject: SettingsMigrationSubject.Route,
    legacy: "/settings/integrations/desktop/connect",
    legacyOwner:
      "apps/app/app/(authenticated)/settings/integrations/desktop/connect/page.tsx",
    v2Panel: SettingsPanelIdValues.ConnectedDevices,
    compatibility: SettingsMigrationCompatibility.RetainedAlias,
    note: "Device pairing entry the Desktop app opens with ?code=. The URL is MINTED SERVER-SIDE as verificationUrl in apps/api/app/desktop/device-onboarding/service.ts, not hard-coded in the binary — so unlike the authorize path it can be changed in one place, but only in lockstep with whatever already-issued codes are still in flight.",
  },
  {
    subject: SettingsMigrationSubject.Route,
    legacy: "/{orgSlug}/organization",
    legacyOwner: "apps/app/lib/app-route-redirects.ts",
    v2Panel: SettingsPanelIdValues.OrganizationGeneral,
    compatibility: SettingsMigrationCompatibility.RetainedAlias,
    note: "Retired in ISS-5011; the proxy forwards it to ?tab=organization, which then forward-maps to the OrganizationGeneral panel.",
  },
  {
    subject: SettingsMigrationSubject.Endpoint,
    legacy: "/api-keys",
    legacyOwner: "apps/api/app/api-keys/route.ts",
    v2Panel: SettingsPanelIdValues.ApiKeys,
    compatibility: SettingsMigrationCompatibility.Unchanged,
    methods: [
      SettingsMigrationHttpMethod.Get,
      SettingsMigrationHttpMethod.Post,
    ],
    note: "Platform API keys. No rename planned; the v2 panel reads the same route.",
  },
  {
    subject: SettingsMigrationSubject.Endpoint,
    legacy: "/api-keys/{id}",
    legacyOwner: "apps/api/app/api-keys/[id]/route.ts",
    v2Panel: SettingsPanelIdValues.ApiKeys,
    compatibility: SettingsMigrationCompatibility.Unchanged,
    methods: [SettingsMigrationHttpMethod.Delete],
    note: "Revoke only. There is no single-key read: the one-time secret is returned at creation and never again.",
  },
  {
    subject: SettingsMigrationSubject.Endpoint,
    legacy: "/settings/api-keys",
    legacyOwner: "apps/api/app/settings/api-keys/route.ts",
    v2Panel: SettingsPanelIdValues.ApiKeys,
    compatibility: SettingsMigrationCompatibility.Unchanged,
    methods: [SettingsMigrationHttpMethod.Get],
    note: "Scope-split ANTHROPIC key listing; not the platform-key route (/api-keys). Retired with Loops (PRD-795, ISS-12435): a 410 tombstone kept for older clients.",
  },
  {
    subject: SettingsMigrationSubject.Endpoint,
    legacy: "/settings/api-keys/org",
    legacyOwner: "apps/api/app/settings/api-keys/org/route.ts",
    v2Panel: SettingsPanelIdValues.ApiKeys,
    compatibility: SettingsMigrationCompatibility.Unchanged,
    methods: [
      SettingsMigrationHttpMethod.Put,
      SettingsMigrationHttpMethod.Delete,
    ],
    note: "Write half of the org Anthropic key. Retired with Loops (PRD-795, ISS-12435): a 410 tombstone kept for older clients.",
  },
  {
    subject: SettingsMigrationSubject.Endpoint,
    legacy: "/settings/api-keys/user",
    legacyOwner: "apps/api/app/settings/api-keys/user/route.ts",
    v2Panel: SettingsPanelIdValues.ApiKeys,
    compatibility: SettingsMigrationCompatibility.Unchanged,
    methods: [
      SettingsMigrationHttpMethod.Put,
      SettingsMigrationHttpMethod.Delete,
    ],
    note: "Write half of the per-user Anthropic key. Retired with Loops (PRD-795, ISS-12435): a 410 tombstone kept for older clients.",
  },
  {
    subject: SettingsMigrationSubject.Endpoint,
    legacy: "/settings/compute-mode",
    legacyOwner: "apps/api/app/settings/compute-mode/route.ts",
    v2Panel: null,
    compatibility: SettingsMigrationCompatibility.Unchanged,
    methods: [SettingsMigrationHttpMethod.Get, SettingsMigrationHttpMethod.Put],
    note: "Cloud compute mode toggle. Retired with Loops (PRD-795, ISS-12435): a 410 tombstone kept for older clients.",
  },
  {
    subject: SettingsMigrationSubject.Endpoint,
    legacy: "/settings/compute-preference",
    legacyOwner: "apps/api/app/settings/compute-preference/route.ts",
    v2Panel: null,
    compatibility: SettingsMigrationCompatibility.Unchanged,
    methods: [SettingsMigrationHttpMethod.Get, SettingsMigrationHttpMethod.Put],
    note: "Per-user preferred compute mode and target. Retired with Loops (PRD-795, ISS-12435): a 410 tombstone kept for older clients.",
  },
  {
    subject: SettingsMigrationSubject.Endpoint,
    legacy: "/settings/frustration",
    legacyOwner: "apps/api/app/settings/frustration/route.ts",
    v2Panel: SettingsPanelIdValues.OtherLabs,
    compatibility: SettingsMigrationCompatibility.Unchanged,
    methods: [SettingsMigrationHttpMethod.Get, SettingsMigrationHttpMethod.Put],
    note: "Org session-frustration policy; admin-gated on write.",
  },
  {
    subject: SettingsMigrationSubject.Endpoint,
    legacy: "/settings/pensero",
    legacyOwner: "apps/api/app/settings/pensero/route.ts",
    v2Panel: SettingsPanelIdValues.ApiKeys,
    compatibility: SettingsMigrationCompatibility.Unchanged,
    methods: [
      SettingsMigrationHttpMethod.Get,
      SettingsMigrationHttpMethod.Put,
      SettingsMigrationHttpMethod.Delete,
    ],
    note: "Pensero org credential. On the v2 API Keys panel (operator decision on ISS-10316), flag-gated by PENSERO_INTEGRATION_FEATURE_FLAG_KEY there as on the legacy tab. Writes are admin-gated.",
  },
  {
    subject: SettingsMigrationSubject.Endpoint,
    legacy: "/integrations/github",
    legacyOwner: "apps/api/app/integrations/github/route.ts",
    v2Panel: null,
    compatibility: SettingsMigrationCompatibility.Unchanged,
    methods: [
      SettingsMigrationHttpMethod.Get,
      SettingsMigrationHttpMethod.Delete,
    ],
    note: "GitHub App connection status and disconnect, read by useGitHubIntegration for the legacy card. UNOWNED in v2: the Profile panel reads Clerk external accounts and never calls this route, and the Plugins panel does not carry GitHub. The ?github= OAuth return therefore has no v2 landing site either — see SETTINGS_CALLBACK_V2_PANEL. Sibling sub-routes not machine-checked here: /connect, /connect/confirm-reset, /clerk-link, /backfill, /public-repositories, /repositories.",
  },
  {
    subject: SettingsMigrationSubject.Endpoint,
    legacy: "/integrations/google",
    legacyOwner: "apps/api/app/integrations/google/route.ts",
    v2Panel: SettingsPanelIdValues.Plugins,
    compatibility: SettingsMigrationCompatibility.Unchanged,
    methods: [
      SettingsMigrationHttpMethod.Get,
      SettingsMigrationHttpMethod.Delete,
    ],
    note: "Google Drive connection status and disconnect. Read by the Google Drive card on the v2 Plugins panel since ISS-10316, flag-gated by google-drive there as on the legacy tab; the ?google= OAuth return opens Plugins and is reported there. Sibling sub-routes: /connect, /files, /import.",
  },
  {
    subject: SettingsMigrationSubject.Endpoint,
    legacy: "/compute-targets",
    legacyOwner: "apps/api/app/compute-targets/route.ts",
    v2Panel: SettingsPanelIdValues.ConnectedDevices,
    compatibility: SettingsMigrationCompatibility.Unchanged,
    methods: [SettingsMigrationHttpMethod.Get],
    note: "Registered desktop machines: machineName, lastSeenAt. Owner-only since ISS-12617 retired org sharing.",
  },
  {
    subject: SettingsMigrationSubject.Endpoint,
    legacy: "/compute-targets/{id}",
    legacyOwner: "apps/api/app/compute-targets/[id]/route.ts",
    v2Panel: null,
    compatibility: SettingsMigrationCompatibility.Unchanged,
    methods: [SettingsMigrationHttpMethod.Delete],
    note: "Deregister one machine. There is no single-target GET; the list route is the only read. PUT was removed by ISS-12784.",
  },
  {
    subject: SettingsMigrationSubject.Endpoint,
    legacy: "/compute-targets/{id}/sharing",
    legacyOwner: "apps/api/app/compute-targets/[id]/sharing/route.ts",
    v2Panel: null,
    compatibility: SettingsMigrationCompatibility.Unchanged,
    methods: [SettingsMigrationHttpMethod.Patch],
    note: "Org sharing for one machine. Retired by ISS-12617: a 410 tombstone kept for older clients. PATCH, not PUT — a client that respells the verb gets a 405.",
  },
  {
    subject: SettingsMigrationSubject.Endpoint,
    legacy: "/compute-targets/{id}/commands",
    legacyOwner: "apps/api/app/compute-targets/[id]/commands/route.ts",
    v2Panel: null,
    compatibility: SettingsMigrationCompatibility.Unchanged,
    methods: [SettingsMigrationHttpMethod.Post],
    note: "Backs the update-and-restart control.",
  },
  {
    subject: SettingsMigrationSubject.Endpoint,
    legacy: "/compute-targets/{id}/commands/{commandId}",
    legacyOwner:
      "apps/api/app/compute-targets/[id]/commands/[commandId]/route.ts",
    v2Panel: null,
    compatibility: SettingsMigrationCompatibility.Unchanged,
    methods: [SettingsMigrationHttpMethod.Get],
    note: "Poll one issued command to completion.",
  },
  {
    subject: SettingsMigrationSubject.Endpoint,
    legacy: "/organizations/{id}",
    legacyOwner: "apps/api/app/organizations/[id]/route.ts",
    v2Panel: SettingsPanelIdValues.OrganizationGeneral,
    compatibility: SettingsMigrationCompatibility.Unchanged,
    methods: [SettingsMigrationHttpMethod.Get, SettingsMigrationHttpMethod.Put],
    note: "Workspace identity: name and slug. PUT, never PATCH. Slug edits change every org-scoped URL, so the legacy editor's confirmation stays required.",
  },
  {
    subject: SettingsMigrationSubject.Endpoint,
    legacy: "/organizations/invitations",
    legacyOwner: "apps/api/app/organizations/invitations/route.ts",
    v2Panel: SettingsPanelIdValues.Members,
    compatibility: SettingsMigrationCompatibility.Unchanged,
    methods: [
      SettingsMigrationHttpMethod.Get,
      SettingsMigrationHttpMethod.Post,
    ],
    note: "Members administration. In legacy this is reached only through Clerk's embedded OrganizationProfile inside the Organization tab, which is why the Members panel's legacy origin is that tab.",
  },
  {
    subject: SettingsMigrationSubject.Endpoint,
    legacy: "/desktop/device-onboarding/start",
    legacyOwner: "apps/api/app/desktop/device-onboarding/start/route.ts",
    v2Panel: SettingsPanelIdValues.ConnectedDevices,
    compatibility: SettingsMigrationCompatibility.Unchanged,
    methods: [SettingsMigrationHttpMethod.Post],
    note: "Device pairing handshake driven by shipped Desktop builds; request and response shapes are version-skew critical. Siblings /poll, /approve, /session are POST on the same contract.",
  },
  {
    subject: SettingsMigrationSubject.Endpoint,
    legacy: "/settings/view-model",
    legacyOwner: "apps/api/app/settings/view-model/route.ts",
    v2Panel: null,
    compatibility: SettingsMigrationCompatibility.V2Additive,
    methods: [SettingsMigrationHttpMethod.Get],
    note: "ISS-8378's authorized Settings view model — the per-panel capability projection the v2 shell resolves against. Serves the whole shell rather than one panel, and has no legacy counterpart: the legacy page derives one browser `isAdmin` boolean instead.",
  },
  {
    subject: SettingsMigrationSubject.Endpoint,
    legacy: "/settings/browser-sessions",
    legacyOwner: "apps/api/app/settings/browser-sessions/route.ts",
    v2Panel: SettingsPanelIdValues.ConnectedDevices,
    compatibility: SettingsMigrationCompatibility.V2Additive,
    methods: [SettingsMigrationHttpMethod.Get],
    note: "ISS-9085's browser sign-in list, for the v2 Connected Devices panel. No legacy tab renders it, so a rollback simply loses the list rather than breaking a legacy screen.",
  },
  {
    subject: SettingsMigrationSubject.Endpoint,
    legacy: "/settings/browser-sessions/{sessionId}",
    legacyOwner: "apps/api/app/settings/browser-sessions/[sessionId]/route.ts",
    v2Panel: SettingsPanelIdValues.ConnectedDevices,
    compatibility: SettingsMigrationCompatibility.V2Additive,
    methods: [SettingsMigrationHttpMethod.Delete],
    note: "Revoke one of the caller's own browser sign-ins. Same v2-additive standing as the list.",
  },
  {
    subject: SettingsMigrationSubject.Command,
    legacy: "settingsTabHref(tab) -> #/settings?tab={DesktopSettingsTab}",
    legacyOwner: "apps/desktop/src/renderer/navigation/route-table.ts",
    v2Panel: null,
    compatibility: SettingsMigrationCompatibility.RetainedAlias,
    note: "In-renderer desktop deep link, validated against visibleSettingsTabs. Unrelated to the web SettingsTab set; do not alias the two.",
  },
  {
    subject: SettingsMigrationSubject.RoleCheck,
    legacy: "hasAdminRole(has) server-side tab allowlist",
    legacyOwner: "apps/app/app/(authenticated)/[orgSlug]/settings/page.tsx",
    v2Panel: null,
    compatibility: SettingsMigrationCompatibility.RetainedAlias,
    note: "Decides ADMIN_SETTINGS_TABS. Its v2 successor has LANDED rather than being planned: ISS-8378 replaced the boolean with the per-panel SettingsPanelCapability projection served by /settings/view-model, where pending and error are not denials.",
  },
  {
    subject: SettingsMigrationSubject.RoleCheck,
    legacy: "<Show when={hasAdminRole}> panel-body gate",
    legacyOwner:
      "apps/app/app/(authenticated)/[orgSlug]/settings/components/settings-page.tsx",
    v2Panel: null,
    compatibility: SettingsMigrationCompatibility.RetainedAlias,
    note: "Defense-in-depth behind the allowlist. v2's equivalent is the forbidden resolution status, kept distinct from unavailable.",
  },
  {
    subject: SettingsMigrationSubject.RoleCheck,
    legacy: "isAdmin prop threaded into settings cards",
    legacyOwner:
      "apps/app/app/(authenticated)/[orgSlug]/settings/components/settings-page.tsx",
    v2Panel: null,
    compatibility: SettingsMigrationCompatibility.RetainedAlias,
    note: "One boolean drives read-only rendering in the slug, transcript-search, session-sync, frustration and Pensero cards; v2 splits it into read vs edit capability.",
  },
  {
    subject: SettingsMigrationSubject.RoleCheck,
    legacy: "authorizeSettingsCommand(domain, capability) write gate",
    legacyOwner: "apps/api/lib/auth/settings-command.ts",
    v2Panel: null,
    compatibility: SettingsMigrationCompatibility.Unchanged,
    note: "ISS-8716 moved the SERVER half of the role check onto the shared domain policy for one enumerated set of Settings mutations, so the v2 projection and the write already read one table. Unchanged, not additive: a refusal still answers with the org-admin gate's existing 403 / 503 role_unresolved shapes, so no older client sees a new error. That module enumerates exactly which boundaries moved.",
  },
  {
    subject: SettingsMigrationSubject.RoleCheck,
    legacy: "getOrgAdminStatus / requireOrgAdmin write gate",
    legacyOwner: "apps/api/lib/auth/org-admin.ts",
    v2Panel: null,
    compatibility: SettingsMigrationCompatibility.RetainedAlias,
    note: "The Settings mutations ISS-8716 did NOT migrate still gate here — the org and per-entity API-key writes and PUT /organizations/{id} among them. Retained because migrating a gate changes who may write; the unmigrated set is named in apps/api/lib/auth/settings-command.ts and must be re-read there, not assumed from this row.",
  },
  {
    subject: SettingsMigrationSubject.RoleCheck,
    legacy: "SETTINGS_DOMAIN_ACCESS_POLICY (11 domains)",
    legacyOwner: "packages/api/src/types/settings-domain.ts",
    v2Panel: null,
    compatibility: SettingsMigrationCompatibility.V2Additive,
    note: "The policy table both halves of the v2 gate read. A mirror of gates the routes already enforced rather than a new rule, and a bijection with SettingsPanelId that the owning package pins with its own test.",
  },
  {
    subject: SettingsMigrationSubject.RoleCheck,
    legacy: "User.role (ApproverRole)",
    legacyOwner: "packages/database/prisma/schema.prisma",
    v2Panel: SettingsPanelIdValues.Members,
    compatibility: SettingsMigrationCompatibility.Unchanged,
    note: "Closedloop role, distinct from the Clerk org role. Its legacy editor is behind SHOW_CLOSEDLOOP_ROLES = false and renders nowhere today.",
  },
  {
    subject: SettingsMigrationSubject.DataField,
    legacy: "Organization.slug, Organization.name",
    legacyOwner: "packages/database/prisma/schema.prisma",
    v2Panel: SettingsPanelIdValues.OrganizationGeneral,
    compatibility: SettingsMigrationCompatibility.Unchanged,
    note: "No column change. Renaming a slug rewrites every org-scoped URL, including the retained Desktop paths above.",
  },
  {
    subject: SettingsMigrationSubject.DataField,
    legacy:
      "Organization.claudeApiKeyEncrypted, claudeApiKeyLastFour, claudeApiKeySetAt",
    legacyOwner: "packages/database/prisma/schema.prisma",
    v2Panel: SettingsPanelIdValues.ApiKeys,
    compatibility: SettingsMigrationCompatibility.Unchanged,
    note: "Anthropic BYO key. Retired with Loops (PRD-795, ISS-12435): no surface reads or writes it.",
  },
  {
    subject: SettingsMigrationSubject.DataField,
    legacy: "Organization.searchIncludeTranscripts",
    legacyOwner: "packages/database/prisma/schema.prisma",
    v2Panel: SettingsPanelIdValues.OtherLabs,
    compatibility: SettingsMigrationCompatibility.Unchanged,
    note: "Transcript-search privacy gate, rendered by the Organization tab's TranscriptSearchCard.",
  },
  {
    subject: SettingsMigrationSubject.DataField,
    legacy: "Organization.settings (Json)",
    legacyOwner: "packages/database/prisma/schema.prisma",
    v2Panel: SettingsPanelIdValues.OtherLabs,
    compatibility: SettingsMigrationCompatibility.Unchanged,
    note: "Free-form org settings bag.",
  },
  {
    subject: SettingsMigrationSubject.DataField,
    legacy: "User.preferredComputeMode, User.preferredComputeTargetId",
    legacyOwner: "packages/database/prisma/schema.prisma",
    v2Panel: null,
    compatibility: SettingsMigrationCompatibility.Unchanged,
    note: "Per-user compute preference. Retired with Loops (PRD-795, ISS-12435): no surface reads or writes it.",
  },
  {
    subject: SettingsMigrationSubject.DataField,
    legacy: "User.githubUsername",
    legacyOwner: "packages/database/prisma/schema.prisma",
    v2Panel: null,
    compatibility: SettingsMigrationCompatibility.Unchanged,
    note: "Our copy of the GitHub identity, read back by the legacy connection card. No v2 panel reads this column — Profile derives its GitHub row from Clerk's external accounts instead — so it follows the unowned /integrations/github row above.",
  },
  {
    subject: SettingsMigrationSubject.DataField,
    legacy: "ComputeTarget.machineName, lastSeenAt",
    legacyOwner: "packages/database/prisma/schema.prisma",
    v2Panel: SettingsPanelIdValues.ConnectedDevices,
    compatibility: SettingsMigrationCompatibility.Unchanged,
    note: "Read by the Registered desktops list on Connected Devices. The sharing column is unread since ISS-12617 (ISS-12450 drops it).",
  },
  {
    subject: SettingsMigrationSubject.DataField,
    legacy: "?intent={SettingsPanelIntent}",
    legacyOwner: "packages/api/src/types/settings-panel.ts",
    v2Panel: SettingsPanelIdValues.Members,
    compatibility: SettingsMigrationCompatibility.V2Additive,
    note: "New secondary deep-link target. Omitted when it is the default, so a build that never heard of intents still lands on the right panel.",
  },
  {
    subject: SettingsMigrationSubject.DataField,
    legacy: "?returnTo={path}",
    legacyOwner: "packages/api/src/types/settings-route-links.ts",
    v2Panel: null,
    compatibility: SettingsMigrationCompatibility.V2Additive,
    note: "Host-absolute close target, and load-bearing since ISS-8977 made Settings a modal: it is where a dismiss lands. The legacy tree has no close control and ignores it, which is the correct degradation.",
  },
  {
    subject: SettingsMigrationSubject.DataField,
    legacy: "localStorage `theme` (next-themes)",
    legacyOwner: "packages/design-system/providers/theme.tsx",
    v2Panel: null,
    compatibility: SettingsMigrationCompatibility.RetainedAlias,
    note: "NO LONGER STRANDS ANYONE (ISS-9889). next-themes persists an explicit Light/Dark choice, so removing the control does not return a user to the OS setting — and the v2 workspace menu shipped without one, which would have left that stored value applied forever with no in-app way to change it. The v2 menu now carries ThemeSubmenu, so the preference is editable on both trees and the value simply ages like any other. This is why the runbook's blocked fix (having v2 write `system` back) is moot rather than decided: restoring the control destroys no preference, so the product question that fix raised never has to be answered. Desktop is unaffected either way — apps/desktop/src/renderer/components/layout/Sidebar.tsx renders its own ThemeSubmenu ungated, and nothing on desktop mounts the v2 menu.",
  },
];
