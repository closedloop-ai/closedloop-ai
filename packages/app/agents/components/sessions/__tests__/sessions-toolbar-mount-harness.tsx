// Side-effect only. The toolbar's three Radix layers throw in jsdom without the
// pointer-capture shims, and neither adapter suite loads them: `apps/app`
// hand-rolls scrollIntoView + matchMedia only, `apps/desktop` declares no
// `setupFiles`. Imported here rather than added to either global setup so the
// shims reach these specs without changing what passing suites already measure.
import "../../../../../typescript-config/vitest-jsdom-setup";
import { GRID_TABLE_TOOLBAR_EXPANDED_SLOT } from "@repo/design-system/components/ui/grid-table-toolbar";
import { within } from "@testing-library/react";
import type { ReactNode } from "react";
// Cross-slice by design: `shared/storybook` owns the provider stack both shells
// inject, and a feature slice is allowed to depend on `shared/*`.
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";

/**
 * ISS-7725 — the provider scaffold a Sessions spec needs to mount the REAL
 * listing toolbar instead of a `vi.mock` stand-in. ISS-10301 retired the v1
 * `SessionsToolbar` this was written for; the scaffold is unchanged and now
 * serves the v2 listing its hosts mount.
 *
 * Shared rather than inlined into one spec because the requirement is
 * per-SURFACE: a web-only harness proves nothing about the Electron renderer,
 * and a second copy is how the two surfaces' provider sets drift.
 *
 * Which ports are load-bearing, and why a spec must NOT mock around them:
 *
 *  - **Feature flags.** `useFeatureFlagEnabled` resolves through
 *    `FeatureFlagAdapterProvider`, so `enabledFlags` drives the toolbar's REAL
 *    Grid Parity read. An adapter spec therefore does not mock
 *    `use-feature-flag-enabled`; it names the flag here.
 *  - **API + auth.** The export row (`SessionsCsvExportMenuItem`) calls
 *    `useApiClient()` and throws without them — the hazard both stand-ins were
 *    written to dodge, and why neither surface could assert the row itself.
 *  - **Query client.** The Owner/Project name resolvers behind the Filter
 *    popover issue a gated roster read.
 */
export function SessionsToolbarMountHarness({
  children,
  enabledFlags = [],
}: {
  children: ReactNode;
  /**
   * Flag keys reported enabled; everything else resolves to its closed default.
   *
   * Read ONCE at mount — `AppCoreStoryProviders` builds the static adapter in a
   * `useState` initializer, so mutating this list on a mounted tree changes
   * nothing. A test comparing gate-on against gate-off must unmount and render
   * again.
   */
  enabledFlags?: readonly string[];
}) {
  return (
    <AppCoreStoryProviders enabledFlags={enabledFlags}>
      {children}
    </AppCoreStoryProviders>
  );
}

/**
 * Controls only the REAL toolbar renders, used to prove it actually mounted
 * before any assertion about the Options menu is believed. A `vi.mock`
 * stand-in fails these: it renders prop markers, not controls.
 *
 * Independent literals, deliberately not derived from the toolbar's own
 * composition: reading them off the component under test would keep a spec
 * green after that component stopped rendering the control.
 */
export const SESSIONS_TOOLBAR_FILTER_BUTTON = "Filter";
export const SESSIONS_TOOLBAR_VIEW_BUTTON = "View";
export const SESSIONS_TOOLBAR_OPTIONS_BUTTON = "Options";

/**
 * Facet rows the real `FilterPopover` opens to. A stand-in that rendered a
 * `Filter` button would still not produce these, so asserting one is what
 * separates "the toolbar mounted" from "something named Filter exists".
 */
export const SESSIONS_TOOLBAR_FACET_GROUPS = [
  "Status",
  "Owner",
  "Autonomy",
  "Harness",
  "Model",
  "Cost",
  "Repository",
] as const;

/**
 * A column the Options menu offers on either read of the Grid Parity key —
 * ISS-10361 retired the toolbar's fork on it, so this label is no longer the
 * gate-on spelling of a control the gate-off shape held somewhere else.
 */
export const SESSIONS_TOOLBAR_COLUMN_LABEL = "Repository";

/**
 * The five summary-card rows, in strip order.
 *
 * Pinned as independent literals rather than read from
 * `SESSIONS_SUMMARY_CARD_LABELS`: this list POLICES the set, so building it
 * from the map the menu is built from would stay green if a card lost its row.
 */
export const SESSIONS_TOOLBAR_SUMMARY_CARD_LABELS = [
  "Sessions",
  "Total Tokens",
  "Total estimated cost",
  "PRs Shipped",
  "LOC / $",
] as const;

/**
 * One Options-menu switch row, addressed by the ROW rather than the Switch:
 * `TableOptionsSwitchRow` puts the handler on the `menuitem`'s `onSelect` and
 * marks the Switch beside it `pointer-events-none`. (The View menu differs — it
 * pairs a `<label>` with its Switch, so there the switch IS name-addressable.)
 */
export function sessionsToolbarOptionsRow(
  menu: HTMLElement,
  label: string
): HTMLElement {
  return within(menu).getByRole("menuitem", { name: label });
}

/**
 * The toolbar's WIDE cluster, scoped.
 *
 * ISS-10361: `GridTableToolbar` keeps both width slots in the DOM and hides one
 * with CSS, and a surface that wires no sort/group cluster gets an Options menu
 * in BOTH — so a bare `getByRole("button", { name: "Options" })` resolves two
 * and throws. Menu CONTENTS still come from `screen`, because Radix portals
 * them to `document.body`, outside this slot.
 */
export function expandedToolbar() {
  const slot = document.querySelector(
    `[data-slot="${GRID_TABLE_TOOLBAR_EXPANDED_SLOT}"]`
  );
  if (!(slot instanceof HTMLElement)) {
    throw new Error("the expanded toolbar slot did not render");
  }
  return within(slot);
}
