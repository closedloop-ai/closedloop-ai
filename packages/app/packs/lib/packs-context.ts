/**
 * Capability context for the unified Packs / Plugin Catalog UX.
 *
 * The same shared components render across three surfaces; the differences are
 * expressed as capability flags rather than forked components. A surface picks a
 * `mode` (which seeds sensible defaults) and may override individual flags — e.g.
 * a desktop build enables `showTeamUsage` only once the multiplayer overlay is
 * available.
 */

export const PacksMode = {
  /** Single-player desktop: my installed plugins + local install/uninstall. */
  DesktopSolo: "desktop-solo",
  /** Desktop with the cloud multiplayer overlay (team usage / activity / perf). */
  DesktopTeam: "desktop-team",
  /** Admin org-wide web: catalog management + distribution (auto-install / opt-in). */
  WebAdmin: "web-admin",
  /**
   * Member org-wide web: browse the org catalog + the canonical usage/performance
   * overlay, with none of the admin authoring/distribution affordances. Backs the
   * self-service Plugins tab in the web Agents workspace so a regular member sees
   * the same prototype-styled workspace as the admin page (read-only).
   */
  WebMember: "web-member",
} as const;
export type PacksMode = (typeof PacksMode)[keyof typeof PacksMode];

export type PacksCapabilities = {
  /** Install/uninstall/update a pack on the local machine (desktop only). */
  installLocally: boolean;
  /** Create/edit org-wide distributions (auto-install / opt-in) — admin only. */
  manageDistribution: boolean;
  /** Create / upload / archive catalog items — admin only. */
  manageCatalog: boolean;
  /** Show the Team-usage tab, installer stacks, and the Recommended/Activity rail. */
  showTeamUsage: boolean;
  /** Show the team Activity feed in the rail. */
  showActivity: boolean;
  /** Show the Performance tab. */
  showPerformance: boolean;
  /**
   * Show the member per-machine install-state block on pack detail (FEA-4077):
   * one honest `PackInstallState` row per (compute target × harness) the member
   * has, rendered from the FEA-4072a `installMatrix`. On DESKTOP this reflects
   * local install state (this machine, via `desktopApi.db.catalog*`); on the web
   * MEMBER surface it reflects the member's registered nodes (a READ; the
   * ACT/dispatch path is the separate self-service-install slice). Off for the
   * admin surface, which manages roll-out through the org-wide Distribution tab
   * instead.
   */
  showMemberTargets: boolean;
};

export type PacksContext = {
  mode: PacksMode;
  capabilities: PacksCapabilities;
};

const CAPABILITY_DEFAULTS: Record<PacksMode, PacksCapabilities> = {
  [PacksMode.DesktopSolo]: {
    installLocally: true,
    manageDistribution: false,
    manageCatalog: false,
    showTeamUsage: false,
    showActivity: false,
    showPerformance: false,
    // Desktop reflects local install state on "this machine".
    showMemberTargets: true,
  },
  [PacksMode.DesktopTeam]: {
    installLocally: true,
    manageDistribution: false,
    manageCatalog: false,
    showTeamUsage: true,
    showActivity: true,
    showPerformance: true,
    showMemberTargets: true,
  },
  [PacksMode.WebAdmin]: {
    installLocally: false,
    manageDistribution: true,
    manageCatalog: true,
    showTeamUsage: true,
    showActivity: true,
    showPerformance: true,
    // Admin manages roll-out through the org-wide Distribution tab, not a
    // personal per-machine block.
    showMemberTargets: false,
  },
  [PacksMode.WebMember]: {
    // Read-only browse: web has no local FS to install to, and members cannot
    // author catalog items or manage org distributions. Self-service install to
    // a member's own Electron nodes is a follow-up (needs a member-scoped
    // distribution/dispatch path); the usage/performance overlay is member-safe
    // (the analytics reads are `read`-scoped, no admin gate).
    installLocally: false,
    manageDistribution: false,
    manageCatalog: false,
    showTeamUsage: true,
    showActivity: false,
    showPerformance: true,
    // Reflects the member's own registered nodes (READ). Self-service install to
    // those nodes is the deferred dispatch slice.
    showMemberTargets: true,
  },
};

/**
 * Build a `PacksContext` for a surface, starting from the mode's defaults and
 * applying any explicit capability overrides (e.g. turning on the multiplayer
 * overlay on desktop).
 */
export function createPacksContext(
  mode: PacksMode,
  overrides?: Partial<PacksCapabilities>
): PacksContext {
  return {
    mode,
    capabilities: { ...CAPABILITY_DEFAULTS[mode], ...overrides },
  };
}
