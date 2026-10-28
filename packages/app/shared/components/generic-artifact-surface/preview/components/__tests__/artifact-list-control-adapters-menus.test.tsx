// @vitest-environment jsdom

import { buildSortOptions } from "@repo/app/shared/components/table-toolbar-controls";
import {
  type TableCustomFieldDefinition,
  TableCustomFieldType,
} from "@repo/design-system/components/ui/table-add-field-dialog";
import type { ColumnDefinition } from "@repo/design-system/lib/column-registry";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  ArtifactGroupMenu,
  ArtifactOptionsMenu,
  ArtifactSavedViewsMenu,
  ArtifactSortMenu,
  ArtifactViewMenu,
} from "../artifact-list-control-adapters";
import {
  genericArtifactColumns,
  genericSummaryMetricDefinitions,
  isCustomFieldGroupable,
  isCustomFieldSortable,
} from "../artifact-list-model";
import { openRadixMenu } from "./support/radix-menu";

const GROUP_BY_PATTERN = /Group by/;
const CLEAR_SORT = "Clear sort";
const CLEAR_GROUPS = "Clear groups";
const ADD_FIELD = "Add field";
const THEN_GROUP_BY_PATTERN = /Then group by/;

const LOCKED_COLUMN: ColumnDefinition = {
  ...genericArtifactColumns[1],
  hideable: false,
  id: "locked",
  label: "Locked",
};

const COLUMNS: readonly ColumnDefinition[] = [
  ...genericArtifactColumns,
  LOCKED_COLUMN,
];

const POINTS: TableCustomFieldDefinition = {
  id: "points",
  label: "Points",
  type: TableCustomFieldType.Number,
};
const STAGE: TableCustomFieldDefinition = {
  id: "stage",
  label: "Stage",
  options: ["One", "Two"],
  type: TableCustomFieldType.SingleSelect,
};
const LABELS: TableCustomFieldDefinition = {
  id: "labels",
  label: "Labels",
  type: TableCustomFieldType.MultiSelect,
};
const CUSTOM_FIELDS = [POINTS, STAGE, LABELS];

const ARTIFACT_CAPABILITIES = {
  groupable: isCustomFieldGroupable,
  sortable: isCustomFieldSortable,
};

const METRICS = genericSummaryMetricDefinitions.slice(0, 2);
const [firstMetric, secondMetric] = METRICS;

/** The most recently opened submenu. */
function openSubmenu() {
  const submenu = screen.getAllByRole("menu").at(-1);
  if (!submenu) {
    throw new Error("no submenu is open");
  }
  return submenu;
}

function switchChecked(label: string) {
  return within(screen.getByRole("menuitem", { name: label }))
    .getByRole("switch")
    .getAttribute("data-state");
}

describe("buildSortOptions", () => {
  it("leads with the host column, then sortable columns, then sortable custom fields", () => {
    expect(
      buildSortOptions(COLUMNS, CUSTOM_FIELDS, {
        customFieldCapabilities: ARTIFACT_CAPABILITIES,
      }).map(({ id, label }) => [id, label])
    ).toEqual([
      ["name", "Artifact"],
      ["owner", "Owner"],
      ["status", "Status"],
      ["comments", "Comments"],
      ["updated", "Updated"],
      ["currentVersion", "Current version"],
      ["points", "Points"],
      ["stage", "Stage"],
    ]);
  });

  it("does not attach glyphs to known or unmapped sort fields", () => {
    const unmapped: ColumnDefinition = {
      ...genericArtifactColumns[0],
      id: "estimate",
      label: "Estimate",
    };
    const options = buildSortOptions(
      [genericArtifactColumns[0], unmapped],
      [],
      {
        customFieldCapabilities: ARTIFACT_CAPABILITIES,
      }
    );
    expect(options).toHaveLength(3);
    expect(options.every((option) => !("icon" in option))).toBe(true);
  });

  it("names the leading column after the host", () => {
    expect(
      buildSortOptions([], [], {
        customFieldCapabilities: ARTIFACT_CAPABILITIES,
        leadingLabel: "Branch",
      })
    ).toEqual([expect.objectContaining({ id: "name", label: "Branch" })]);
  });
});

describe("ArtifactSortMenu", () => {
  function renderSort(active: boolean, leadingLabel?: string) {
    const onClear = vi.fn();
    const onSort = vi.fn();
    render(
      <ArtifactSortMenu
        active={active}
        columns={COLUMNS}
        customFields={CUSTOM_FIELDS}
        leadingLabel={leadingLabel}
        onClear={onClear}
        onSort={onSort}
        sortBy="status"
      />
    );
    return { onClear, onSort };
  }

  it("reads as unsorted while inactive and sorts ascending by the chosen field", () => {
    const { onSort } = renderSort(false);

    expect(screen.queryByRole("button", { name: CLEAR_SORT })).toBeNull();
    const trigger = screen.getByRole("button", { name: "Sort" });
    expect(trigger.querySelector("svg")).not.toBeNull();
    openRadixMenu(trigger);
    expect(
      screen
        .getAllByRole("menuitem")
        .every((item) => item.querySelector("svg") === null)
    ).toBe(true);
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent)
    ).toEqual([
      "Artifact",
      "Owner",
      "Status",
      "Comments",
      "Updated",
      "Current version",
      "Points",
      "Stage",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Points" }));

    expect(onSort).toHaveBeenCalledWith("points", "asc");
  });

  it("names the active sort and clears it", () => {
    const { onClear } = renderSort(true, "Branch");

    expect(
      screen.getByRole("button", { name: "Sorted by Status" })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: CLEAR_SORT }));

    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("offers the host's leading label", () => {
    renderSort(false, "Branch");
    openRadixMenu(screen.getByRole("button", { name: "Sort" }));

    expect(screen.getByRole("menuitem", { name: "Branch" })).toBeVisible();
  });
});

describe("ArtifactGroupMenu", () => {
  function renderGroup(
    overrides: Partial<Parameters<typeof ArtifactGroupMenu>[0]> = {}
  ) {
    const setters = {
      setGroupBy: vi.fn(),
      setGroupOrder: vi.fn(),
      setSecondaryGroupBy: vi.fn(),
      setSecondaryGroupOrder: vi.fn(),
      setShowEmptyGroups: vi.fn(),
      setShowEmptySubgroups: vi.fn(),
    };
    render(
      <ArtifactGroupMenu
        columns={COLUMNS}
        customFields={CUSTOM_FIELDS}
        groupBy="status"
        groupOrder="desc"
        secondaryGroupBy="none"
        secondaryGroupOrder="custom"
        showEmptyGroups={false}
        showEmptySubgroups
        {...setters}
        {...overrides}
      />
    );
    return setters;
  }

  function lastGrouping(setters: ReturnType<typeof renderGroup>) {
    return {
      groupBy: setters.setGroupBy.mock.lastCall?.[0],
      groupOrder: setters.setGroupOrder.mock.lastCall?.[0],
      secondaryGroupBy: setters.setSecondaryGroupBy.mock.lastCall?.[0],
      secondaryGroupOrder: setters.setSecondaryGroupOrder.mock.lastCall?.[0],
      showEmptyGroups: setters.setShowEmptyGroups.mock.lastCall?.[0],
      showEmptySubgroups: setters.setShowEmptySubgroups.mock.lastCall?.[0],
    };
  }

  it("reads an ungrouped view as Group with nothing to clear", () => {
    renderGroup({ groupBy: "none" });

    expect(screen.getByRole("button", { name: "Group" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: CLEAR_GROUPS })).toBeNull();
  });

  it("clears both levels back to the empty grouping", () => {
    const setters = renderGroup({ secondaryGroupBy: "owner" });

    expect(
      screen.getByRole("button", { name: "Groups: 2" })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: CLEAR_GROUPS }));

    expect(lastGrouping(setters)).toEqual({
      groupBy: "none",
      groupOrder: "custom",
      secondaryGroupBy: "none",
      secondaryGroupOrder: "asc",
      showEmptyGroups: false,
      showEmptySubgroups: false,
    });
  });

  it("writes every level back when one level's empty-group flag flips", () => {
    const setters = renderGroup({ secondaryGroupBy: "owner" });
    fireEvent.click(screen.getByRole("button", { name: "Groups: 2" }));

    openRadixMenu(
      screen.getByRole("button", { name: "Primary group options" })
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Show empty groups" })
    );

    expect(lastGrouping(setters)).toEqual({
      groupBy: "status",
      groupOrder: "desc",
      secondaryGroupBy: "owner",
      secondaryGroupOrder: "custom",
      showEmptyGroups: true,
      showEmptySubgroups: true,
    });
  });

  it("removes the secondary level to none", () => {
    const setters = renderGroup({ secondaryGroupBy: "owner" });
    fireEvent.click(screen.getByRole("button", { name: "Groups: 2" }));

    fireEvent.click(
      screen.getByRole("button", { name: "Remove secondary group" })
    );

    expect(setters.setGroupBy).toHaveBeenLastCalledWith("status");
    expect(setters.setSecondaryGroupBy).toHaveBeenLastCalledWith("none");
  });

  it("offers only groupable fields other than the primary as a subgroup", () => {
    const setters = renderGroup();
    fireEvent.click(screen.getByRole("button", { name: "Groups: 1" }));

    openRadixMenu(screen.getByRole("button", { name: "Add subgroup" }));
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent)
    ).toEqual(["Owner", "Stage"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Stage" }));

    expect(setters.setSecondaryGroupBy).toHaveBeenLastCalledWith("stage");
  });
});

function OptionsHarness() {
  const [columnIds, setColumnIds] = useState(new Set(["owner", "points"]));
  const [metricKeys, setMetricKeys] = useState(
    new Set<string>([firstMetric.key])
  );
  return (
    <ArtifactOptionsMenu
      columnIds={columnIds}
      columns={COLUMNS}
      customFields={CUSTOM_FIELDS}
      metricDefinitions={METRICS}
      metricKeys={metricKeys}
      setColumnIds={setColumnIds}
      setMetricKeys={setMetricKeys}
    />
  );
}

describe("ArtifactOptionsMenu", () => {
  it("lists hideable columns with custom fields ahead of Tags, and no locked column", () => {
    render(<OptionsHarness />);
    openRadixMenu(screen.getByRole("button", { name: "Options" }));

    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent)
    ).toEqual([
      firstMetric.label,
      secondMetric.label,
      "Owner",
      "Collaborators",
      "Status",
      "Comments",
      "Updated",
      "Current version",
      "Points",
      "Stage",
      "Labels",
      "Tags",
    ]);
  });

  it("toggles a column and a metric in both directions", () => {
    render(<OptionsHarness />);
    openRadixMenu(screen.getByRole("button", { name: "Options" }));

    fireEvent.click(screen.getByRole("menuitem", { name: "Owner" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Tags" }));
    fireEvent.click(screen.getByRole("menuitem", { name: firstMetric.label }));
    fireEvent.click(screen.getByRole("menuitem", { name: secondMetric.label }));

    expect(switchChecked("Owner")).toBe("unchecked");
    expect(switchChecked("Tags")).toBe("checked");
    expect(switchChecked("Points")).toBe("checked");
    expect(switchChecked(firstMetric.label)).toBe("unchecked");
    expect(switchChecked(secondMetric.label)).toBe("checked");
  });
});

function ViewHarness({
  groupBy = "none",
  secondaryGroupBy = "none",
  showAddFieldButton = true,
  sortBy = "none",
  spies,
}: {
  groupBy?: string;
  secondaryGroupBy?: string;
  showAddFieldButton?: boolean;
  sortBy?: string;
  spies: {
    onAddField: () => void;
    onClearSort: () => void;
    onSort: (column: string) => void;
    setGroupBy: (groupBy: string) => void;
    setSecondaryGroupBy: (groupBy: string) => void;
  };
}) {
  const [columnIds, setColumnIds] = useState(new Set(["owner"]));
  const [metricKeys, setMetricKeys] = useState(new Set<string>());
  return (
    <ArtifactViewMenu
      columnIds={columnIds}
      columns={COLUMNS}
      customFields={CUSTOM_FIELDS}
      groupBy={groupBy}
      leadingLabel="Branch"
      metricDefinitions={METRICS}
      metricKeys={metricKeys}
      onAddField={spies.onAddField}
      onClearSort={spies.onClearSort}
      onSort={spies.onSort}
      secondaryGroupBy={secondaryGroupBy}
      setColumnIds={setColumnIds}
      setGroupBy={spies.setGroupBy}
      setMetricKeys={setMetricKeys}
      setSecondaryGroupBy={spies.setSecondaryGroupBy}
      showAddFieldButton={showAddFieldButton}
      sortBy={sortBy}
    />
  );
}

describe("ArtifactViewMenu", () => {
  function renderView(
    props: Omit<Parameters<typeof ViewHarness>[0], "spies"> = {}
  ) {
    const spies = {
      onAddField: vi.fn(),
      onClearSort: vi.fn(),
      onSort: vi.fn(),
      setGroupBy: vi.fn(),
      setSecondaryGroupBy: vi.fn(),
    };
    render(<ViewHarness {...props} spies={spies} />);
    openRadixMenu(screen.getByRole("button", { name: "View" }));
    return spies;
  }

  it("checks None for an unsorted view and sorts by a chosen field", () => {
    const spies = renderView();

    expect(screen.getByRole("menuitemradio", { name: "None" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    expect(
      screen.getByRole("menuitemradio", { name: "Branch" })
    ).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Status" }));

    expect(spies.onSort).toHaveBeenCalledWith("status");
  });

  it("checks the sorted field and clears through None", () => {
    const spies = renderView({ sortBy: "owner" });

    expect(
      screen.getByRole("menuitemradio", { name: "Owner" })
    ).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "None" }));

    expect(spies.onClearSort).toHaveBeenCalledTimes(1);
  });

  it("offers Add field only when the host asks for it", () => {
    const spies = renderView();
    fireEvent.click(screen.getByRole("menuitem", { name: ADD_FIELD }));
    expect(spies.onAddField).toHaveBeenCalledTimes(1);
  });

  it("hides Add field when the host declines it", () => {
    renderView({ showAddFieldButton: false });

    expect(screen.getByRole("menuitem", { name: "Owner" })).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: ADD_FIELD })).toBeNull();
  });

  it("groups by a chosen field and leaves the second level at none", () => {
    const spies = renderView();

    fireEvent.keyDown(
      screen.getByRole("menuitem", { name: GROUP_BY_PATTERN }),
      { key: "ArrowRight" }
    );
    fireEvent.click(
      within(openSubmenu()).getByRole("menuitemradio", { name: "Stage" })
    );

    expect(spies.setGroupBy).toHaveBeenCalledWith("stage");
    expect(spies.setSecondaryGroupBy).toHaveBeenCalledWith("none");
  });

  it("keeps the primary level while the second level is cleared", () => {
    const spies = renderView({ groupBy: "status", secondaryGroupBy: "owner" });

    fireEvent.keyDown(
      screen.getByRole("menuitem", { name: THEN_GROUP_BY_PATTERN }),
      { key: "ArrowRight" }
    );
    fireEvent.click(
      within(openSubmenu()).getByRole("menuitemradio", { name: "None" })
    );

    expect(spies.setGroupBy).toHaveBeenCalledWith("status");
    expect(spies.setSecondaryGroupBy).toHaveBeenCalledWith("none");
  });

  it("writes none for a cleared primary level", () => {
    const spies = renderView({ groupBy: "status" });

    fireEvent.keyDown(
      screen.getByRole("menuitem", { name: GROUP_BY_PATTERN }),
      { key: "ArrowRight" }
    );
    fireEvent.click(
      within(openSubmenu()).getByRole("menuitemradio", { name: "None" })
    );

    expect(spies.setGroupBy).toHaveBeenCalledWith("none");
  });

  it("writes the chosen second level", () => {
    const spies = renderView({ groupBy: "status" });

    fireEvent.keyDown(
      screen.getByRole("menuitem", { name: THEN_GROUP_BY_PATTERN }),
      { key: "ArrowRight" }
    );
    fireEvent.click(
      within(openSubmenu()).getByRole("menuitemradio", { name: "Owner" })
    );

    expect(spies.setSecondaryGroupBy).toHaveBeenCalledWith("owner");
  });

  it("toggles columns and metrics from the compact menu", () => {
    renderView();

    fireEvent.click(screen.getByRole("menuitem", { name: "Owner" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Points" }));
    fireEvent.click(screen.getByRole("menuitem", { name: secondMetric.label }));

    expect(switchChecked("Owner")).toBe("unchecked");
    expect(switchChecked("Points")).toBe("checked");
    expect(switchChecked(secondMetric.label)).toBe("checked");
  });
});

describe("ArtifactSavedViewsMenu", () => {
  it("names the active view and applies a chosen one", () => {
    const onApply = vi.fn();
    render(
      <ArtifactSavedViewsMenu
        activeViewId="mine"
        onApply={onApply}
        onSave={vi.fn()}
        views={[
          { id: "mine", name: "Mine", scope: "personal" },
          { id: "team", name: "Team board", scope: "team" },
        ]}
      />
    );

    openRadixMenu(screen.getByRole("button", { name: "Mine" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Team board" }));

    expect(onApply).toHaveBeenCalledWith("team");
  });
});
