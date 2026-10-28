// Side-effect only, and load-bearing. The real toolbar's three Radix layers call
// pointer-capture APIs jsdom omits, and `apps/app`'s own `vitest.setup.ts` shims
// only `scrollIntoView` + `matchMedia`. Importing the shared mount harness is
// what brings `packages/typescript-config/vitest-jsdom-setup` in, exactly as
// `toolbar-options-menu-mounted.test.tsx` does.
import "@repo/app/agents/components/sessions/__tests__/sessions-toolbar-mount-harness";
import { SESSIONS_EXPORT_CSV_LABEL } from "@repo/app/agents/components/sessions/sessions-options-menu";
import { fireEvent, screen, within } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";

/**
 * ISS-10301 — driving the REAL v2 listing toolbar from an `apps/app` page suite.
 *
 * Until this ticket these suites mounted a `vi.mock` stand-in for the v1
 * `SessionsToolbar` and asserted its prop markers (`toolbar-export-row`,
 * `toolbar-usage-harnesses`, a "Filter owner Ada" button). The v1 toolbar is
 * gone, the page mounts the shipped v2 surface, and its facets route through
 * `filterController`/`filterViewModel` — so the same page-level contracts are
 * observed here through the controls a reader actually operates.
 *
 * Shared rather than inlined because four suites need the same three gestures,
 * and a second copy is how two of them come to disagree about what "the Status
 * facet" means.
 *
 * These are NOT a new stand-in: every function below locates a control the
 * production toolbar renders and dispatches a real event at it.
 */

/** The toolbar's own controls, as independent literals. */
export const SESSIONS_FILTER_BUTTON = "Filter";
export const SESSIONS_OPTIONS_BUTTON = "Options";

type User = ReturnType<typeof userEvent.setup>;

/** Filter popover → facet submenu → (at most) a nested range/search layer. */
const MAX_MENU_LAYERS = 4;

/** Radix's own slot for a submenu's content, as `DropdownMenuSubContent` renders it. */
const RADIX_SUB_CONTENT_SLOT = "dropdown-menu-sub-content";

/**
 * A facet row's accessible name. The row carries the selected COUNT once
 * anything is on ("Owner1"), so the bare word only matches an untouched facet.
 */
function facetRowName(group: string): RegExp {
  return new RegExp(`^${group}\\d*$`);
}

/** Opens the Filter popover, leaving it open for the caller. */
export async function openSessionsFilterPopover(user: User): Promise<void> {
  await user.click(
    screen.getByRole("button", { name: SESSIONS_FILTER_BUTTON })
  );
}

/**
 * Closes every open Radix menu layer.
 *
 * Load-bearing between two gestures in one test: an open dismissable layer marks
 * the rest of the tree `aria-hidden`, so the toolbar's own buttons stop resolving
 * by role until it is dismissed. One `Escape` closes one layer (a submenu leaves
 * its parent popover open), hence the bounded loop.
 */
export async function closeSessionsMenus(user: User): Promise<void> {
  for (let layer = 0; layer < MAX_MENU_LAYERS; layer++) {
    if (screen.queryAllByRole("menu").length === 0) {
      return;
    }
    await user.keyboard("{Escape}");
  }
}

/**
 * Opens one facet's submenu inside the REAL Filter popover and returns it.
 *
 * `ArrowRight` rather than a hover: Radix opens a submenu on keyboard focus
 * traversal deterministically, while the pointer path depends on layout jsdom
 * does not compute.
 */
export async function openSessionsFacetSubmenu(
  user: User,
  group: string
): Promise<HTMLElement> {
  await openSessionsFilterPopover(user);
  const row = screen.getByRole("menuitem", { name: facetRowName(group) });
  fireEvent.keyDown(row, { key: "ArrowRight" });
  // Matched by Radix's SUB-content slot, not by "the last `menu` in the DOM".
  // The popover this just opened is itself a `menu`, so `findAllByRole("menu")
  // .at(-1)` returns an HTMLElement whether or not the submenu opened — the
  // parent — and an `instanceof` guard on that can never fire. A caller would
  // then read the FACET ROWS as though they were the facet's options, which is
  // a green reading of the wrong list.
  const submenu = (await screen.findAllByRole("menu")).find((menu) =>
    menu.matches(`[data-slot="${RADIX_SUB_CONTENT_SLOT}"]`)
  );
  if (submenu === undefined) {
    throw new Error(`the ${group} facet submenu did not open`);
  }
  return submenu;
}

/**
 * Every option the named facet currently OFFERS, in render order.
 *
 * `queryAllByRole`, not `getAllByRole`: a facet whose usage breakdown is empty
 * renders its submenu with a search box and no rows, and "offers nothing" is an
 * answer callers assert rather than an error. That the submenu OPENED at all is
 * already proven — {@link openSessionsFacetSubmenu} throws otherwise.
 */
export async function sessionsFacetOptionNames(
  user: User,
  group: string
): Promise<string[]> {
  const submenu = await openSessionsFacetSubmenu(user, group);
  const names = within(submenu)
    .queryAllByRole("menuitem")
    .map((option) => option.textContent?.trim() ?? "");
  // A pure read leaves the surface as it found it, so a caller can take a second
  // reading (or click something else) without the popover swallowing the page.
  await closeSessionsMenus(user);
  return names;
}

/** One option row of an already-open facet submenu. */
export function sessionsFacetOptionRow(
  submenu: HTMLElement,
  optionName: string | RegExp
): HTMLElement {
  return within(submenu).getByRole("menuitem", { name: optionName });
}

/** Toggles one option of the named facet through the real submenu. */
export async function toggleSessionsFacetOption(
  user: User,
  group: string,
  optionName: string | RegExp
): Promise<void> {
  const submenu = await openSessionsFacetSubmenu(user, group);
  await user.click(within(submenu).getByRole("menuitem", { name: optionName }));
  // Multi-select facet rows keep their menu open, which would hide the rest of
  // the page from every assertion that follows.
  await closeSessionsMenus(user);
}

/** Opens the Options menu and returns it. */
export async function openSessionsOptionsMenu(
  user: User
): Promise<HTMLElement> {
  await closeSessionsMenus(user);
  await user.click(
    screen.getByRole("button", { name: SESSIONS_OPTIONS_BUTTON })
  );
  return screen.getByRole("menu");
}

/** The CSV export row of an open Options menu, or `null` when it is withheld. */
export function sessionsExportRow(menu: HTMLElement): HTMLElement | null {
  return within(menu).queryByRole("menuitem", {
    name: SESSIONS_EXPORT_CSV_LABEL,
  });
}

/**
 * Sorts one grid column ASCENDING through its real per-column options menu.
 *
 * The v2 grid has no header button named after the bare column word — that was
 * the v1 `SortableColumnHeader`. Its header exposes `"<Column> column options"`,
 * whose menu carries "Sort ascending" / "Sort descending".
 */
export async function sortSessionsColumn(
  user: User,
  column: string
): Promise<void> {
  await closeSessionsMenus(user);
  await user.click(
    screen.getByRole("button", { name: `${column} column options` })
  );
  await user.click(
    screen.getByRole("menuitem", { name: SESSIONS_SORT_ASCENDING_ITEM })
  );
  await closeSessionsMenus(user);
}

/** The column menu's ascending-sort row, as `TableGridColumnMenu` spells it. */
export const SESSIONS_SORT_ASCENDING_ITEM = "Sort ascending";

/**
 * The chip row's remove control for one active narrower.
 *
 * `FilterChip` names it `Remove <facet>: <value> filter`, so the caller states
 * the chip it means and this composes the accessible name once.
 */
export function sessionsChipRemoveName(chipLabel: string): string {
  return `Remove ${chipLabel} filter`;
}

/**
 * The Owner facet's one option, and the `usage.byUser` row it is built from.
 *
 * Shared because two suites narrow by the same owner through the real submenu:
 * the retired v1 toolbar stand-in rendered a "Filter owner Ada" button that
 * called `onFiltersChange` directly and needed no usage row at all, so when both
 * were re-pointed they each grew a copy of this fixture. One home, so the id and
 * the option's accessible name cannot drift apart between them.
 */
export const SESSIONS_OWNER_FACET_USER_ID = "user-e2e";
const SESSIONS_OWNER_FACET_USER_NAME = "Ada Lovelace";
const SESSIONS_OWNER_FACET_SESSION_COUNT = 3;
/** The option row's accessible name: the label plus its count badge. */
export const SESSIONS_OWNER_FACET_OPTION_NAME = `${SESSIONS_OWNER_FACET_USER_NAME}${SESSIONS_OWNER_FACET_SESSION_COUNT}`;

/** The `byUser` row the Owner facet builds {@link SESSIONS_OWNER_FACET_OPTION_NAME} from. */
export function sessionsOwnerFacetUsageEntry() {
  return {
    userId: SESSIONS_OWNER_FACET_USER_ID,
    userName: SESSIONS_OWNER_FACET_USER_NAME,
    userEmail: "ada@example.com",
    sessionCount: SESSIONS_OWNER_FACET_SESSION_COUNT,
  };
}
