/**
 * ISS-8361 — the desktop half of the v2 shell route matrix, as DATA.
 *
 * Kept out of the spec for one reason: an Electron spec cannot import the
 * navigation contract (an extension-less `@repo/*` subpath aborts the whole
 * suite at load, `apps/desktop/test/AGENTS.md`), so the destinations have to be
 * written out — and a written-out list is a list that silently misses the next
 * destination the contract gains. `test/shell-route-matrix-coverage.test.ts`
 * imports THIS module into the node lane, where the contract IS importable, and
 * holds it to the destinations the v2 desktop tree actually offers, in both
 * directions. So every literal below is pinned to the contract by that suite
 * rather than trusted.
 *
 * Each landmark is something ONLY the loaded destination emits inside its own
 * nav panel. The Topbar breadcrumb and every Labs page's `<h1>` are also painted
 * by `PageFallback`, `LabsPageHold` and `LabsPageUnavailable`, so neither is
 * used; where a view has no test id, the landmark is its own control or copy,
 * asserted PRESENT.
 */

import type { Locator } from "@playwright/test";
import { DATE_RANGE_FILTER_ARIA_LABEL } from "@repo/app/shared/components/date-range-filter-labels.ts";

/**
 * Every gate the contract declares for desktop — what a fully-gated account's
 * assignment opens besides the rollout key. The coverage suite checks it
 * against `shellNavigationGateKeys(Desktop)`.
 */
export const DESKTOP_OPEN_NAV_GATES: readonly string[] = [
  "labsNav",
  "agentsNav",
  "docsHelp",
  "issues-nav",
  "documents-nav",
];

/** The PostHog flag key, as PostHog spells it — a name this repo does not own. */
export const SHELL_SIDEBAR_V2_WIRE_KEY = "shell-sidebar-v2";

export type DesktopMatrixDestination = {
  /** The contract's `ShellNavigationItemId`. */
  readonly id: string;
  /** The sidebar row's accessible name. */
  readonly label: string;
  /** The hash route segment and `data-nav-panel` id. */
  readonly navId: string;
  /** Resolved inside the destination's ACTIVE nav panel. */
  readonly landmark: (panel: Locator) => Locator;
};

/** In hierarchy order: each section's own rows, then its nested sections. */
export const DESKTOP_ROUTE_MATRIX: readonly DesktopMatrixDestination[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    navId: "dashboard",
    // ISS-10929 retired the tour control this used to resolve. The range
    // filter is the header's remaining control and, like the control before
    // it, mounts only with the loaded page — `DashboardFallback` renders the
    // same h1 and description and no actions at all, so the h1 would resolve
    // against the fallback and prove nothing about reaching the destination.
    //
    // Located by the control's own accessible name. The bare
    // `[data-slot="toggle-group"]` marker this used to carry stopped being
    // unique the moment ISS-10929's scope toggle was restored beside it — two
    // radiogroups in the header, so the locator resolved to 2 and strict mode
    // failed the step. The name constant now lives in a JSX-free module, which
    // is what lets the NODE lane's coverage suite import it.
    landmark: (panel) =>
      panel.getByRole("radiogroup", { name: DATE_RANGE_FILTER_ARIA_LABEL }),
  },
  {
    id: "documents",
    label: "Documents",
    navId: "documents",
    landmark: (panel) => panel.getByRole("textbox", { name: "Filter items" }),
  },
  {
    id: "issues",
    label: "Issues",
    navId: "issues",
    landmark: (panel) =>
      panel.getByRole("button", { exact: true, name: "Add issue" }),
  },
  {
    id: "sessions",
    label: "Sessions",
    navId: "sessions",
    landmark: (panel) => panel.getByTestId("sessions-history-list"),
  },
  {
    id: "branches",
    label: "Branches",
    navId: "branches",
    landmark: (panel) => panel.getByTestId("branches-history-list"),
  },
  {
    id: "insights",
    label: "Insights",
    navId: "insights",
    landmark: (panel) =>
      panel.getByText(
        "Aggregated agent-session activity across your synced compute targets.",
        { exact: true }
      ),
  },
  {
    id: "approvals",
    label: "Approvals",
    navId: "approvals",
    landmark: (panel) =>
      panel.getByRole("heading", {
        exact: true,
        level: 2,
        name: "Always Allow Rules",
      }),
  },
  {
    id: "requests",
    label: "Requests",
    navId: "requests",
    landmark: (panel) =>
      panel.getByRole("button", { exact: true, name: "Clear Request Log" }),
  },
  {
    id: "packs",
    label: "Packs",
    navId: "packs",
    landmark: (panel) =>
      panel.getByRole("region", { exact: true, name: "Your packs" }),
  },
  {
    id: "plans",
    label: "Plans",
    navId: "plans",
    landmark: (panel) =>
      panel.getByText(
        "Plans extracted from agent sessions — review, confirm, or reject",
        { exact: true }
      ),
  },
  {
    id: "help",
    label: "Help",
    navId: "help",
    landmark: (panel) =>
      panel.getByRole("searchbox", { name: "Search documentation" }),
  },
  {
    id: "agents",
    label: "Agents",
    navId: "agents",
    landmark: (panel) =>
      panel.getByRole("searchbox", { name: "Search components" }),
  },
];
