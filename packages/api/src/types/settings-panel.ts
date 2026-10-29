/**
 * @file settings-panel.ts
 * @description The Settings v2 panel vocabulary: the closed set of panel ids,
 * their groups and display order, their labels, the host/capability axes, and
 * the route parameter keys. Values only — no zod, no parser — so a
 * bundle-sensitive `"use client"` surface can render a panel label or read a
 * param key without pulling a validator in. The parsing and href half lives
 * next door in `./settings-route.ts` (ISS-8362).
 *
 * The id set is owned HERE rather than by the panel packages that implement
 * them, which is what lets a panel module (ISS-8363..8369) be authored and
 * tested without editing any shared file: it claims an existing id, it does not
 * mint one. {@link SETTINGS_PANEL_LABEL} is an exhaustive `Record`, so a new id
 * fails `tsc` here until it is named.
 */

export const SettingsPanelGroup = {
  User: "user",
  Organization: "organization",
  Labs: "labs",
} as const;

export type SettingsPanelGroup =
  (typeof SettingsPanelGroup)[keyof typeof SettingsPanelGroup];

export const SettingsPanelId = {
  Profile: "profile",
  ConnectedDevices: "connected-devices",
  Plugins: "plugins",
  OrganizationGeneral: "organization",
  Members: "members",
  CustomFields: "custom-fields",
  Tags: "tags",
  Compliance: "compliance",
  ApiKeys: "api-keys",
  /**
   * ISS-10286: the desktop app's own machine-local settings — the ones held by
   * the Electron main process rather than by the cloud. Desktop-only by nature,
   * so it is the first id in this set that no web shell can render.
   */
  DesktopApp: "desktop-app",
  OtherLabs: "other-labs",
} as const;

export type SettingsPanelId =
  (typeof SettingsPanelId)[keyof typeof SettingsPanelId];

/**
 * Which panels sit in which group, in navigation order. This is the ordering
 * SSOT: registration order must not decide what a user sees, or the nav would
 * reshuffle as panel packages land.
 */
export const SETTINGS_PANEL_GROUP_MEMBERS: Record<
  SettingsPanelGroup,
  readonly SettingsPanelId[]
> = {
  [SettingsPanelGroup.User]: [
    SettingsPanelId.Profile,
    SettingsPanelId.ConnectedDevices,
    SettingsPanelId.Plugins,
  ],
  [SettingsPanelGroup.Organization]: [
    SettingsPanelId.OrganizationGeneral,
    SettingsPanelId.Members,
  ],
  [SettingsPanelGroup.Labs]: [
    SettingsPanelId.CustomFields,
    SettingsPanelId.Tags,
    SettingsPanelId.Compliance,
    SettingsPanelId.ApiKeys,
    SettingsPanelId.DesktopApp,
    SettingsPanelId.OtherLabs,
  ],
};

export const SETTINGS_PANEL_GROUP_ORDER: readonly SettingsPanelGroup[] = [
  SettingsPanelGroup.User,
  SettingsPanelGroup.Organization,
  SettingsPanelGroup.Labs,
];

export const SETTINGS_PANEL_IDS: readonly SettingsPanelId[] =
  SETTINGS_PANEL_GROUP_ORDER.flatMap(
    (group) => SETTINGS_PANEL_GROUP_MEMBERS[group]
  );

export const SETTINGS_PANEL_LABEL: Record<SettingsPanelId, string> = {
  [SettingsPanelId.Profile]: "Profile",
  [SettingsPanelId.ConnectedDevices]: "Connected Devices",
  [SettingsPanelId.Plugins]: "Plugins",
  [SettingsPanelId.OrganizationGeneral]: "General",
  [SettingsPanelId.Members]: "Members",
  [SettingsPanelId.CustomFields]: "Custom Fields",
  [SettingsPanelId.Tags]: "Tags",
  [SettingsPanelId.Compliance]: "Compliance",
  [SettingsPanelId.ApiKeys]: "API Keys",
  [SettingsPanelId.DesktopApp]: "Desktop App",
  [SettingsPanelId.OtherLabs]: "Other Labs Settings",
};

export const SETTINGS_PANEL_GROUP_LABEL: Record<SettingsPanelGroup, string> = {
  [SettingsPanelGroup.User]: "User settings",
  [SettingsPanelGroup.Organization]: "Organization settings",
  [SettingsPanelGroup.Labs]: "Labs",
};

export const DEFAULT_SETTINGS_PANEL_ID: SettingsPanelId =
  SettingsPanelId.Profile;

/**
 * Surfaces a panel can be offered on. A panel absent from a host is
 * `unavailable` there — a state kept distinct from `forbidden`, because "this
 * build cannot do that" and "you are not allowed to do that" are different
 * facts and a user acts on them differently.
 */
export const SettingsPanelHost = {
  Web: "web",
  Desktop: "desktop",
} as const;

export type SettingsPanelHost =
  (typeof SettingsPanelHost)[keyof typeof SettingsPanelHost];

export const SETTINGS_PANEL_HOST_LABEL: Record<SettingsPanelHost, string> = {
  [SettingsPanelHost.Web]: "the web app",
  [SettingsPanelHost.Desktop]: "the desktop app",
};

/**
 * Capability an actor holds over one panel. Ordered least to most privileged;
 * a grant does NOT imply the ones below it, so a projection that means "may
 * edit" sends both `read` and `edit`. Server-side authorization remains the
 * boundary — this axis only decides what Settings renders.
 */
export const SettingsPanelCapability = {
  Read: "read",
  Edit: "edit",
  Admin: "admin",
  Owner: "owner",
} as const;

export type SettingsPanelCapability =
  (typeof SettingsPanelCapability)[keyof typeof SettingsPanelCapability];

/**
 * A deep link's secondary target within a panel. Closed set, additive: a panel
 * that does not understand an intent renders as if `View` were asked for, so an
 * older build receiving a newer link degrades instead of failing.
 */
export const SettingsPanelIntent = {
  View: "view",
  Invite: "invite",
  SyncPolicy: "sync-policy",
} as const;

export type SettingsPanelIntent =
  (typeof SettingsPanelIntent)[keyof typeof SettingsPanelIntent];

export const DEFAULT_SETTINGS_PANEL_INTENT: SettingsPanelIntent =
  SettingsPanelIntent.View;

/**
 * Org-relative routes. Callers join the org slug at the surface seam
 * (`useOrgPath()` in React, `withOrgSlug` in a pure caller) so this contract
 * stays free of the web-only slug and desktop can reuse it.
 */
export const SETTINGS_ROUTE = "/settings";

/** Where Settings closes to when no in-app origin was supplied. */
export const SETTINGS_CLOSE_ROUTE = "/dashboard";

/**
 * `?panel=<SettingsPanelId>`. Deliberately NOT the legacy Settings page's
 * `?tab=`: while the program rollback window keeps both trees alive, a v2 link
 * arriving on legacy and a legacy link arriving on v2 must each land on their
 * own default rather than be misread as a panel the other tree also names.
 * Legacy-tab aliasing belongs to ISS-8380, which owns the legacy `SettingsTab`
 * SSOT in `apps/app`.
 */
export const SETTINGS_PANEL_PARAM = "panel";

export const SETTINGS_INTENT_PARAM = "intent";

/**
 * In-app path Settings returns to on close, overriding the dashboard default.
 * HOST-ABSOLUTE, unlike every other route in this file: the producing surface
 * puts its own router's path here and Settings navigates to it verbatim.
 */
export const SETTINGS_RETURN_TO_PARAM = "returnTo";

/**
 * Whether the actor's per-panel capability projection has been read at all.
 * `Pending` and `Error` are NOT authorization answers: neither may be folded
 * into a grant or a denial (PRD-692 — a failed read must not become an
 * authorized, empty, or completed state).
 */
export const SettingsActorCapabilityStatus = {
  Ready: "ready",
  Pending: "pending",
  Error: "error",
} as const;

export type SettingsActorCapabilityStatus =
  (typeof SettingsActorCapabilityStatus)[keyof typeof SettingsActorCapabilityStatus];

/**
 * The actor half of panel resolution, as ISS-8378's view model will project it.
 *
 * `grants` is only meaningful when `status` is `Ready`; an id absent from it
 * then means "no capability", which is a real answer. An id listed in
 * `unreadable` is the partial case: the aggregate read succeeded overall but
 * that panel's capability could not be determined, so it resolves to
 * capability-error rather than to a denial.
 */
export type SettingsActorCapabilities = {
  status: SettingsActorCapabilityStatus;
  grants?: Partial<Record<SettingsPanelId, readonly SettingsPanelCapability[]>>;
  unreadable?: readonly SettingsPanelId[];
};

/**
 * Outcome of resolving a requested panel against the registry, the host, and
 * the actor. Every value here is a state Settings renders DIFFERENTLY; folding
 * any two together is the defect this union exists to prevent.
 */
export const SettingsPanelResolutionStatus = {
  Ready: "ready",
  Pending: "pending",
  Unknown: "unknown",
  Unavailable: "unavailable",
  Forbidden: "forbidden",
  CapabilityError: "capability-error",
} as const;

export type SettingsPanelResolutionStatus =
  (typeof SettingsPanelResolutionStatus)[keyof typeof SettingsPanelResolutionStatus];

export function isSettingsPanelId(value: unknown): value is SettingsPanelId {
  return (
    typeof value === "string" &&
    (SETTINGS_PANEL_IDS as readonly string[]).includes(value)
  );
}

/**
 * Retired panel ids a deep link may still carry, keyed to the panel that now
 * owns their subject. Installed Desktops and old bookmarks keep emitting a
 * retired id, so every reader of `?panel=` resolves it through
 * {@link resolveRetiredSettingsPanelId} rather than rendering it as an unknown
 * panel. `local-compute-targets` resolves to Connected Devices (ISS-12784 R2).
 */
export const RETIRED_SETTINGS_PANEL_SUCCESSOR: Readonly<
  Record<string, SettingsPanelId>
> = Object.freeze(
  Object.assign(Object.create(null), {
    "local-compute-targets": SettingsPanelId.ConnectedDevices,
  })
);

/**
 * A `?panel=` value with a retired id replaced by its successor; any other
 * value is returned unchanged. The v2 route parser and the legacy-tree rollback
 * adapter both read the param through this, so they agree on a retired id.
 */
export function resolveRetiredSettingsPanelId(value: string): string {
  return RETIRED_SETTINGS_PANEL_SUCCESSOR[value] ?? value;
}
