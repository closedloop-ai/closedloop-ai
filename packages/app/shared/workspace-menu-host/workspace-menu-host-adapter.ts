import type {
  WorkspaceMenuCapabilities,
  WorkspaceMenuHostId,
  WorkspaceMenuProjection,
  WorkspaceMenuWorkspaceSummary,
} from "@repo/api/src/types/workspace-menu";
import type { ReactNode } from "react";

/**
 * ISS-8363 (PRD-691) — the injected port through which the workspace/account
 * menu learns who is signed in, which workspaces they may reach, and how this
 * host performs the actions the menu offers.
 *
 * A port rather than a runtime check, per `packages/app/AGENTS.md`: shared code
 * never asks "am I in Electron?". It exists at all because this package may not
 * import `@clerk/*` or `@repo/auth/*`, and the general `AuthAdapter` carries
 * only `isLoaded` / `userId` / `orgId` / `getToken` — none of the identity or
 * actions this menu needs can cross that seam.
 *
 * WHY NOT A FATTER `AuthAdapter`: it is a general auth port, and menu actions
 * on it would make every unrelated consumer carry them. This mirrors
 * `SettingsHostAdapter` instead, which is the same shape for the same reason.
 *
 * NO `buildOrgPath` HERE. Joining an org-relative route to a host's URL shape is
 * already a solved, injected concern: `useOrgPath()` (`@repo/navigation`)
 * resolves to the web adapter's slug-prefixing builder and to desktop's
 * `identityOrgPath`. A second copy on this port was duplication of a canonical
 * one, so the menu calls `useOrgPath()` directly.
 *
 * THE READS ARE HOOKS, DELIBERATELY. Mounting the provider must cost nothing —
 * a projection eagerly resolved at provider level would run Clerk's membership
 * query on every authenticated page load, for a menu that is not open and, until
 * ISS-8370, not even mounted. As hook properties they run only when the menu
 * renders. `AuthAdapter.useAuthSnapshot` is the same pattern.
 */

export type WorkspaceMenuHostAdapter = {
  host: WorkspaceMenuHostId;
  /**
   * Identity and workspaces. Resolves to a settled projection on every path.
   *
   * `open` is the menu's disclosure state, and it gates the EXPENSIVE reads
   * only. The menu sits in the sidebar header, so it renders on every
   * authenticated page load; without this the Clerk membership pagination and
   * the Desktop-release lookup both fire for a dropdown nobody has opened
   * (`packages/app/AGENTS.md`: gate data that is only needed once a surface is
   * opened). The cheap identity reads always run — the trigger names the
   * workspace whether or not the menu is open.
   */
  useWorkspaceMenuProjection: (options: {
    open: boolean;
  }) => WorkspaceMenuProjection;
  /**
   * Which entries this host offers. Every id is present with a status; an entry
   * this host lacks is `Unavailable` with a reason, never a missing key, and an
   * entry whose own read is still in flight is `Pending` rather than absent.
   */
  useWorkspaceMenuCapabilities: (options: {
    open: boolean;
  }) => WorkspaceMenuCapabilities;
  /**
   * Where Diagnostics lives, on a host that has one. Both hosts have one since
   * ISS-10006; on web it is absent until the org slug resolves, and an absent
   * href and a broken one are different, so this stays optional rather than
   * becoming an empty string.
   */
  diagnosticsHref?: string;
  /**
   * Makes another workspace active. Absent on a single-org host: Desktop has no
   * organization-switching path at all, and its `switch-workspace` capability is
   * `Unavailable`, so the menu never reaches for this.
   *
   * Takes the whole summary rather than an id because activating a workspace and
   * navigating to it need DIFFERENT keys — Clerk activates by id, and the web
   * route is addressed by slug. Passing only the id forces the adapter to
   * navigate to `/<id>/…`, which is not a route.
   */
  switchWorkspace?: (workspace: WorkspaceMenuWorkspaceSummary) => Promise<void>;
  /**
   * The host's create-workspace UI, as a node rather than a callback: web's is
   * Clerk's `<CreateOrganization>` COMPONENT, which cannot be returned from a
   * function without dragging Clerk into this package. Same technique
   * `ShellSidebar` uses for its `workspaceHeader` slot.
   */
  createWorkspaceSlot?: ReactNode;
  /** The guest account-creation door. */
  requestAccount?: () => void;
  /** ISS-12475: sign in directly without resuming account-creation onboarding. */
  requestSignIn?: () => void;
  /**
   * Ends the session. Genuinely different machinery per host — Clerk's
   * `signOut()` on web, `desktopApi.signOutDesktop()` through the main process on
   * desktop — which is exactly what a port method is for.
   */
  signOut: () => Promise<void>;
};
