import {
  DropdownMenu,
  DropdownMenuContent,
} from "@closedloop-ai/design-system/components/ui/dropdown-menu";
import type {
  FilterMenuGroup,
  TableFilterOption,
  TableFiltersController,
  TableFiltersViewModel,
} from "@closedloop-ai/design-system/components/ui/table-filters";
import {
  fireEvent,
  type RenderResult,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";

/**
 * `FilterPopover` and its superseded v2 fork (ISS-9341) take the same controller and
 * view model, so every suite that drives one drives the other from the same
 * fixture. One definition, because a second copy of an 18-field controller is
 * the drift ISS-7651 exists to remove.
 */
export const NOOP_CONTROLLER: TableFiltersController = {
  filters: {
    assigneeIds: [],
    assignToMe: false,
    hideCompletedItems: false,
    favoritesOnly: false,
    statuses: [],
    priorities: [],
    date: null,
    tagIds: [],
  },
  toggleAssignee: () => undefined,
  toggleAssignToMe: () => undefined,
  toggleHideCompletedItems: () => undefined,
  toggleFavoritesOnly: () => undefined,
  toggleStatus: () => undefined,
  togglePriority: () => undefined,
  setDateFilter: () => undefined,
  toggleTag: () => undefined,
  clearCategoryFilter: () => undefined,
  clearAllFilters: () => undefined,
  activeChips: [],
};

export function repositoryFacet(
  options: TableFilterOption[],
  onToggle: (value: string) => void,
  emptyLabel?: string
): FilterMenuGroup {
  return {
    id: "repository",
    label: "Repository",
    options,
    selectedValues: [],
    onToggle,
    emptyLabel,
  };
}

/** A menu carrying nothing but the generic Repository facet submenu. */
export function facetViewModel(
  options: TableFilterOption[],
  onToggle: (value: string) => void,
  emptyLabel?: string
): TableFiltersViewModel {
  return {
    ...builtInViewModel(),
    facetGroups: [repositoryFacet(options, onToggle, emptyLabel)],
  };
}

/**
 * The built-in menu — no `facetGroups`, so the Assignee and Tags submenus
 * render instead of the generic facet list.
 */
export function builtInViewModel(
  overrides: Partial<TableFiltersViewModel> = {}
): TableFiltersViewModel {
  return {
    teamMembers: [],
    statusOptions: [],
    priorityOptions: [],
    hideQuickToggles: true,
    ...overrides,
  };
}

/** Open the Filter menu itself, without stepping into a submenu. */
export function openFilterMenu(): void {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: FILTER_BUTTON_NAME }),
    {
      button: 0,
      ctrlKey: false,
    }
  );
}

/** Open the Filter menu, then the named submenu inside it. */
export function openFacet(name: string | RegExp): void {
  openFilterMenu();
  fireEvent.keyDown(screen.getByRole("menuitem", { name }), {
    key: "ArrowRight",
  });
}

export const FILTER_BUTTON_NAME = "Filter";
export const DEFAULT_SEARCH_PLACEHOLDER = "Filter...";
export const ASSIGNED_TO_ME = /Assigned to me$/;
export const HIDE_COMPLETED = /^Hide completed items/;
export const MY_FAVORITES = /^My Favorites/;
export const ASSIGNEE_TRIGGER = /^Assignee/;
export const DATES_TRIGGER = /^Dates/;
export const TAGS_TRIGGER = /^Tags/;
export const PRIORITY_TRIGGER = /^Priority/;
export const STATUS_TRIGGER = /^Status/;
export const CREATED_TRIGGER = /^Date Created/;
export const ALICE_ROW = /^Alice/;
export const BOB_ROW = /^Bob/;

export const ALICE: TableFilterOption = {
  id: "u-alice",
  label: "Alice",
  count: 3,
};
export const BOB: TableFilterOption = { id: "u-bob", label: "Bob" };
export const TAG_A: TableFilterOption = {
  id: "tag-a",
  label: "tag-a",
  count: 2,
};

const CHECK_ICON_SELECTOR = ".lucide-check";
/**
 * Any glyph a filter menu item draws other than the submenu chevron and the
 * selected-state check (ISS-12919: filter menus carry no leading icons).
 */
const LEADING_ICON_SELECTOR =
  "svg:not(.lucide-chevron-right):not(.lucide-check)";

export function controllerWith(
  filters: Partial<TableFiltersController["filters"]> = {},
  overrides: Partial<TableFiltersController> = {}
): TableFiltersController {
  return {
    ...NOOP_CONTROLLER,
    ...overrides,
    filters: { ...NOOP_CONTROLLER.filters, ...filters },
  };
}

/** Mount a filter submenu body inside an already-open menu. */
export function renderInMenu(children: ReactNode): RenderResult {
  return render(
    <DropdownMenu open>
      <DropdownMenuContent>{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

export function filterButton(): HTMLElement {
  return screen.getByRole("button", { name: FILTER_BUTTON_NAME });
}

export function hasCheck(item: HTMLElement): boolean {
  return item.querySelector(CHECK_ICON_SELECTOR) !== null;
}

export function leadingIcon(item: HTMLElement): Element | null {
  return item.querySelector(LEADING_ICON_SELECTOR);
}
