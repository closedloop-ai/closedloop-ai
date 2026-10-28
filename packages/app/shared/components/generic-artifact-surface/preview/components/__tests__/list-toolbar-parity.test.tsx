// @vitest-environment jsdom
import { SessionsListToolbarV2 } from "@repo/app/agents/components/sessions/sessions-list-toolbar-v2";
import { branchesToolbarPropsFixture } from "@repo/app/branches/components/__tests__/branches-toolbar-props.fixtures";
import { BranchesListToolbarV2 } from "@repo/app/branches/components/branches-list-toolbar-v2";
import { ProjectList } from "@repo/app/projects/components/project-list";
import {
  LIST_TOOLBAR_FILTER_LABEL,
  LIST_TOOLBAR_SEARCH_LABEL,
  LIST_TOOLBAR_SEARCH_PLACEHOLDER,
} from "@repo/app/shared/components/list-toolbar-copy";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  buildFacetOnlyFiltersViewModel,
  NOOP_TABLE_FILTERS_CONTROLLER,
} from "@repo/app/shared/lib/facet-filter";
import {
  GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
  PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { TABLE_DATE_RANGE_OPTIONS } from "@repo/app/shared/lib/table-date-range-options";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactKind } from "../../fixtures";
import { ArtifactListSharedToolbar } from "../artifact-list-shared-toolbar";
import { useGenericArtifactListController } from "../artifact-list-shell-controller";
import { GenericArtifactListView } from "../artifact-shells";
import { listRow } from "./support/list-controller-harness";

vi.mock(
  "@repo/design-system/components/ui/active-filters-bar",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@repo/design-system/components/ui/active-filters-bar")
    >()),
    ActiveFiltersBar: () => <div data-testid="active-filters-bar" />,
  })
);
vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

/**
 * ISS-13007 parity: the Sessions, Branches, Documents, Issues and Projects
 * toolbars are one shared toolbar. Each page is mounted through its own adapter
 * with its own flag open (gridview-adoption, or projects-portable-surface for
 * Projects); what a page may differ in is which
 * controls its data supports, never their words, their order or their empty
 * state.
 */
const ACTIVE_FILTERS_ROW = "active-filters-bar";
const CANONICAL_ORDER = [
  "search",
  "range",
  "filters",
  "layout",
  "sort",
  "group",
  "options",
  "views",
  "addField",
] as const;
type Control = (typeof CANONICAL_ORDER)[number];

// Each page keeps its own group name ("Artifact layout", "Project layout").
const LAYOUT_GROUP_NAME = / layout$/;
const SORT_NAME = /^Sort/;
const GROUP_NAME = /^Group/;
const OPTIONS_NAME = /^Options$/;
const VIEWS_NAME = /^(Default view|Views)$/;
const ADD_FIELD_NAME = /^Add field$/;
const ACTIVE_FACET = buildFacetOnlyFiltersViewModel([
  {
    id: "model",
    label: "Model",
    onToggle: () => undefined,
    options: [{ id: "gpt", label: "GPT" }],
    selectedValues: ["gpt"],
  },
]);
const NO_FACETS = buildFacetOnlyFiltersViewModel(undefined);

afterEach(cleanup);

function withFlag(
  ui: ReactElement,
  flag: string = GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY
) {
  return (
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags: [flag] })}
    >
      {ui}
    </FeatureFlagAdapterProvider>
  );
}

function ArtifactPage({ kind }: { kind: ArtifactKind }) {
  const controller = useGenericArtifactListController({
    artifacts: [listRow("one", { kind })],
    controlledArtifacts: true,
    onOpenArtifact: vi.fn(),
    showAddFieldButton: true,
  });
  return (
    <GenericArtifactListView
      controller={controller}
      host={{
        renderSharedToolbar: (shell) => (
          <ArtifactListSharedToolbar controller={shell} />
        ),
        search: { onChange: vi.fn(), value: "" },
      }}
    />
  );
}

function SessionsPage({ active }: { active: boolean }) {
  return (
    <SessionsListToolbarV2
      activeFiltersViewModel={active ? ACTIVE_FACET : NO_FACETS}
      columns={[]}
      dateRange="7d"
      dateRangeOptions={TABLE_DATE_RANGE_OPTIONS}
      filterController={NOOP_TABLE_FILTERS_CONTROLLER}
      filterViewModel={active ? ACTIVE_FACET : NO_FACETS}
      hiddenSummaryCardIds={new Set()}
      onAddField={() => undefined}
      onApplySavedView={() => undefined}
      onClearFilters={() => undefined}
      onDateRangeChange={() => undefined}
      onSaveView={() => undefined}
      onToggleColumn={() => undefined}
      onToggleSummaryCard={() => undefined}
      savedViews={{ activeViewId: null, onSave: () => undefined, views: [] }}
      search={{ onChange: () => undefined, value: "" }}
      sortGrouping={{
        grouping: EMPTY_TABLE_GROUPING,
        groupOptions: [{ id: "status", label: "Status" }],
        onClearSort: () => undefined,
        onGroupingChange: () => undefined,
        onSort: () => undefined,
        sortBy: null,
        sortOptions: [{ id: "name", label: "Name" }],
      }}
      visibleColumnIds={new Set()}
    />
  );
}

function BranchesPage() {
  return (
    <BranchesListToolbarV2
      {...branchesToolbarPropsFixture({
        rows: [],
        visibleColumns: new Set(["owner"]),
      })}
      columnControls={{
        grouping: EMPTY_TABLE_GROUPING,
        onGroupingChange: () => undefined,
        onResetSort: () => undefined,
        onSortChange: () => undefined,
        sortDir: "asc",
        sortKey: "lastActivity",
      }}
      customFieldColumns={{
        onAddField: () => undefined,
        toggleColumn: () => undefined,
        toggleOptions: [],
        visibleColumnIds: new Set(["owner"]),
      }}
    />
  );
}

const PAGES: ReadonlyArray<{
  name: string;
  expected: readonly Control[];
  render: () => ReactElement;
}> = [
  {
    expected: CANONICAL_ORDER,
    name: "Documents",
    render: () => <ArtifactPage kind={ArtifactKind.Document} />,
  },
  {
    expected: CANONICAL_ORDER,
    name: "Issues",
    render: () => <ArtifactPage kind={ArtifactKind.Issue} />,
  },
  {
    expected: CANONICAL_ORDER.filter((control) => control !== "layout"),
    name: "Sessions",
    render: () => <SessionsPage active={false} />,
  },
  {
    expected: CANONICAL_ORDER.filter(
      (control) => control !== "layout" && control !== "views"
    ),
    name: "Branches",
    render: () => <BranchesPage />,
  },
];

function observedControls(container: HTMLElement): Control[] {
  const wide = Array.from(
    container.querySelectorAll<HTMLElement>(
      "input, [role='radiogroup'], button"
    )
  ).filter((element) => !element.closest("[data-slot$='compact']"));
  const found: Control[] = [];
  for (const element of wide) {
    const control = classify(element);
    if (control && found.at(-1) !== control && !found.includes(control)) {
      found.push(control);
    }
  }
  return found;
}

function classify(element: HTMLElement): Control | undefined {
  const label = element.getAttribute("aria-label") ?? "";
  const text = element.textContent ?? "";
  if (element instanceof HTMLInputElement) {
    return label === LIST_TOOLBAR_SEARCH_LABEL ? "search" : undefined;
  }
  if (element.getAttribute("role") === "radiogroup") {
    return LAYOUT_GROUP_NAME.test(label) ? "layout" : "range";
  }
  if (text.startsWith(LIST_TOOLBAR_FILTER_LABEL)) {
    return "filters";
  }
  const patterns: ReadonlyArray<readonly [Control, RegExp]> = [
    ["sort", SORT_NAME],
    ["group", GROUP_NAME],
    ["options", OPTIONS_NAME],
    ["views", VIEWS_NAME],
    ["addField", ADD_FIELD_NAME],
  ];
  return patterns.find(([, pattern]) => pattern.test(text.trim()))?.[0];
}

describe("ISS-13007 list toolbar parity", () => {
  it.each(PAGES)(
    "$name renders the shared controls in the shared order with the shared words",
    ({ expected, render: build }) => {
      const { container } = render(withFlag(build()));
      expect(observedControls(container)).toEqual(expected);
      const search = container.querySelector("input");
      expect(search?.getAttribute("placeholder")).toBe(
        LIST_TOOLBAR_SEARCH_PLACEHOLDER
      );
      const filters = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.startsWith(LIST_TOOLBAR_FILTER_LABEL)
      );
      expect(filters?.textContent?.trim()).toBe(LIST_TOOLBAR_FILTER_LABEL);
    }
  );

  it.each(PAGES)(
    "$name renders no active-filters row while nothing is filtered",
    ({ render: build }) => {
      const { container, queryByTestId } = render(withFlag(build()));
      expect(container.querySelector("input")).not.toBeNull();
      expect(queryByTestId(ACTIVE_FILTERS_ROW)).toBeNull();
    }
  );

  it("Sessions shows the active-filters row once a facet is applied", () => {
    const { queryByTestId } = render(withFlag(<SessionsPage active />));
    expect(queryByTestId(ACTIVE_FILTERS_ROW)).not.toBeNull();
  });

  it("Projects renders the shared toolbar with the shared words and no active-filters row", () => {
    const { container, queryByTestId } = render(
      withFlag(
        <ProjectList rows={[]} />,
        PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY
      )
    );
    expect(observedControls(container)).toEqual(
      CANONICAL_ORDER.filter(
        (control) => control !== "range" && control !== "addField"
      )
    );
    expect(queryByTestId(ACTIVE_FILTERS_ROW)).toBeNull();
  });
});
