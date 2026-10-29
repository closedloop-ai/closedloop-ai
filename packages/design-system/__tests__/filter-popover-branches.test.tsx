import {
  AssigneeFilterContent,
  DateFilterContent,
  FilterGroupContent,
  FilterPopover,
  TableDateFilterField,
  TableDatePreset,
  TagsFilterContent,
} from "@closedloop-ai/design-system/components/ui/filter-popover";
import {
  TABLE_DATE_PRESET_LABELS,
  type TableFiltersController,
  type TableFiltersViewModel,
} from "@closedloop-ai/design-system/components/ui/table-filters";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ALICE,
  ALICE_ROW,
  ASSIGNED_TO_ME,
  ASSIGNEE_TRIGGER,
  BOB,
  BOB_ROW,
  builtInViewModel,
  CREATED_TRIGGER,
  controllerWith,
  DATES_TRIGGER,
  DEFAULT_SEARCH_PLACEHOLDER,
  filterButton,
  HIDE_COMPLETED,
  hasCheck,
  leadingIcon,
  MY_FAVORITES,
  NOOP_CONTROLLER,
  openFacet,
  openFilterMenu,
  PRIORITY_TRIGGER,
  renderInMenu,
  STATUS_TRIGGER,
  TAG_A,
  TAGS_TRIGGER,
} from "./fixtures/filter-popover-fixtures";

/**
 * ISS-11299 branch coverage for the champion filter popover. Each case drives a
 * conditional in `filter-popover.tsx` and asserts what the user sees or
 * what the host callback receives.
 */

describe("FilterPopover v1 trigger count", () => {
  it("counts a non-empty text search and shows the clear action", () => {
    const onClear = vi.fn();
    render(
      <FilterPopover
        controller={NOOP_CONTROLLER}
        onClear={onClear}
        textFilter={{ value: "abc", onChange: vi.fn() }}
        viewModel={builtInViewModel()}
      />
    );

    expect(filterButton().textContent).toBe("Filter1");
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("counts the search but omits the clear action without onClear", () => {
    render(
      <FilterPopover
        controller={NOOP_CONTROLLER}
        textFilter={{ value: "abc", onChange: vi.fn() }}
        viewModel={builtInViewModel()}
      />
    );

    expect(filterButton().textContent).toBe("Filter1");
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("does not count an empty text search", () => {
    render(
      <FilterPopover
        controller={NOOP_CONTROLLER}
        onClear={vi.fn()}
        textFilter={{ value: "", onChange: vi.fn() }}
        viewModel={builtInViewModel()}
      />
    );

    expect(filterButton().textContent).toBe("Filter");
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });
});

describe("FilterPopover v1 text search", () => {
  it("uses the host placeholder in the facet-group menu and clears on demand", () => {
    const onChange = vi.fn();
    render(
      <FilterPopover
        controller={NOOP_CONTROLLER}
        textFilter={{ value: "abc", onChange, placeholder: "Find rows" }}
        viewModel={builtInViewModel({ facetGroups: [] })}
      />
    );
    openFilterMenu();

    const input = screen.getByRole("textbox", { name: "Find rows" });
    expect(input).toHaveValue("abc");
    fireEvent.change(input, { target: { value: "abcd" } });
    expect(onChange).toHaveBeenLastCalledWith("abcd");
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("falls back to the label placeholder in the facet-group menu", () => {
    render(
      <FilterPopover
        controller={NOOP_CONTROLLER}
        textFilter={{ value: "", onChange: vi.fn() }}
        viewModel={builtInViewModel({ facetGroups: [] })}
      />
    );
    openFilterMenu();

    expect(
      screen.getByRole("textbox", { name: DEFAULT_SEARCH_PLACEHOLDER })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
  });

  it("uses the host placeholder in the built-in menu", () => {
    render(
      <FilterPopover
        controller={NOOP_CONTROLLER}
        textFilter={{ value: "", onChange: vi.fn(), placeholder: "Find rows" }}
        viewModel={builtInViewModel()}
      />
    );
    openFilterMenu();

    expect(
      screen.getByRole("textbox", { name: "Find rows" })
    ).toBeInTheDocument();
  });

  it("falls back to the label placeholder in the built-in menu", () => {
    render(
      <FilterPopover
        controller={NOOP_CONTROLLER}
        textFilter={{ value: "", onChange: vi.fn() }}
        viewModel={builtInViewModel()}
      />
    );
    openFilterMenu();

    expect(
      screen.getByRole("textbox", { name: DEFAULT_SEARCH_PLACEHOLDER })
    ).toBeInTheDocument();
  });

  it("names an unlabeled search field 'Search' when the placeholder is empty", () => {
    render(
      <FilterPopover
        controller={NOOP_CONTROLLER}
        textFilter={{ value: "", onChange: vi.fn(), placeholder: "" }}
        viewModel={builtInViewModel()}
      />
    );
    openFilterMenu();

    expect(screen.getByRole("textbox", { name: "Search" })).toHaveAttribute(
      "placeholder",
      ""
    );
  });
});

describe("FilterPopover v1 quick toggles", () => {
  function renderQuickToggles(
    filters: Partial<TableFiltersController["filters"]>,
    overrides: Partial<TableFiltersController> = {}
  ) {
    render(
      <FilterPopover
        controller={controllerWith(filters, overrides)}
        viewModel={builtInViewModel({
          hideQuickToggles: false,
          currentUser: { id: "me", name: "Ada Lovelace" },
        })}
      />
    );
    openFilterMenu();
  }

  it("marks every active quick toggle with a check", () => {
    renderQuickToggles({
      assignToMe: true,
      hideCompletedItems: true,
      favoritesOnly: true,
    });

    expect(
      hasCheck(screen.getByRole("menuitem", { name: ASSIGNED_TO_ME }))
    ).toBe(true);
    expect(
      hasCheck(screen.getByRole("menuitem", { name: HIDE_COMPLETED }))
    ).toBe(true);
    expect(hasCheck(screen.getByRole("menuitem", { name: MY_FAVORITES }))).toBe(
      true
    );
  });

  it("leaves inactive quick toggles unchecked and reports each toggle", () => {
    const toggleAssignToMe = vi.fn();
    const toggleHideCompletedItems = vi.fn();
    const toggleFavoritesOnly = vi.fn();
    renderQuickToggles(
      {},
      { toggleAssignToMe, toggleHideCompletedItems, toggleFavoritesOnly }
    );

    const assigned = screen.getByRole("menuitem", { name: ASSIGNED_TO_ME });
    const hide = screen.getByRole("menuitem", { name: HIDE_COMPLETED });
    const favorites = screen.getByRole("menuitem", { name: MY_FAVORITES });
    expect(hasCheck(assigned)).toBe(false);
    expect(hasCheck(hide)).toBe(false);
    expect(hasCheck(favorites)).toBe(false);
    expect(leadingIcon(hide)).toBeNull();
    expect(leadingIcon(favorites)).toBeNull();

    fireEvent.click(assigned);
    fireEvent.click(hide);
    fireEvent.click(favorites);
    expect(toggleAssignToMe).toHaveBeenCalledTimes(1);
    expect(toggleHideCompletedItems).toHaveBeenCalledTimes(1);
    expect(toggleFavoritesOnly).toHaveBeenCalledTimes(1);
  });
});

describe("FilterPopover v1 facet groups", () => {
  it("renders range and options groups without leading icons", () => {
    render(
      <FilterPopover
        controller={NOOP_CONTROLLER}
        viewModel={builtInViewModel({
          facetGroups: [
            {
              id: "cost",
              kind: "range",
              label: "Cost",
              onChange: vi.fn(),
            },
            {
              id: "owner",
              label: "Owner",
              options: [ALICE],
              selectedValues: [],
              onToggle: vi.fn(),
            },
          ],
        })}
      />
    );
    openFilterMenu();
    expect(
      leadingIcon(screen.getByRole("menuitem", { name: "Cost" }))
    ).toBeNull();
    expect(
      leadingIcon(screen.getByRole("menuitem", { name: "Owner" }))
    ).toBeNull();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Cost" }), {
      key: "ArrowRight",
    });
    expect(screen.getByLabelText("Min")).toBeInTheDocument();
  });

  it("counts an active range group on the trigger", () => {
    render(
      <FilterPopover
        controller={NOOP_CONTROLLER}
        viewModel={builtInViewModel({
          facetGroups: [
            {
              id: "cost",
              kind: "range",
              label: "Cost",
              min: 1,
              onChange: vi.fn(),
            },
          ],
        })}
      />
    );

    expect(filterButton().textContent).toBe("Filter1");
  });

  it("labels the first option of each new section only", () => {
    render(
      <FilterPopover
        controller={NOOP_CONTROLLER}
        viewModel={builtInViewModel({
          facetGroups: [
            {
              id: "owner",
              label: "Owner",
              options: [
                { id: "a", label: "Alpha", sectionLabel: "Team" },
                { id: "b", label: "Beta", sectionLabel: "Team" },
                { id: "c", label: "Gamma", sectionLabel: "Others" },
                { id: "d", label: "Delta" },
              ],
              selectedValues: [],
              onToggle: vi.fn(),
            },
          ],
        })}
      />
    );
    openFacet("Owner");

    expect(screen.getAllByText("Team")).toHaveLength(1);
    expect(screen.getAllByText("Others")).toHaveLength(1);
  });
});

describe("FilterPopover v1 built-in submenu counts", () => {
  it("shows the selected assignee, date and tag counts on their triggers", () => {
    render(
      <FilterPopover
        controller={controllerWith({
          assigneeIds: [ALICE.id, BOB.id],
          date: {
            field: TableDateFilterField.CreatedAt,
            preset: TableDatePreset.Last7d,
          },
          tagIds: [TAG_A.id],
        })}
        viewModel={builtInViewModel({
          teamMembers: [ALICE, BOB],
          tagOptions: [TAG_A],
        })}
      />
    );
    openFilterMenu();

    expect(
      screen.getByRole("menuitem", { name: ASSIGNEE_TRIGGER }).textContent
    ).toBe("Assignee2");
    expect(
      screen.getByRole("menuitem", { name: DATES_TRIGGER }).textContent
    ).toBe("Dates1");
    expect(
      screen.getByRole("menuitem", { name: TAGS_TRIGGER }).textContent
    ).toBe("Tags1");
    for (const name of [ASSIGNEE_TRIGGER, DATES_TRIGGER, TAGS_TRIGGER]) {
      expect(leadingIcon(screen.getByRole("menuitem", { name }))).toBeNull();
    }
  });

  it("draws no leading icon on the Status and Priority triggers", () => {
    render(
      <FilterPopover
        controller={NOOP_CONTROLLER}
        viewModel={builtInViewModel({
          priorityOptions: [{ id: "high", label: "High" }],
          statusOptions: [{ id: "open", label: "Open" }],
        })}
      />
    );
    openFilterMenu();

    for (const name of [STATUS_TRIGGER, PRIORITY_TRIGGER]) {
      expect(leadingIcon(screen.getByRole("menuitem", { name }))).toBeNull();
    }
  });

  it("omits the counts when nothing is selected", () => {
    render(
      <FilterPopover
        controller={NOOP_CONTROLLER}
        viewModel={builtInViewModel({ teamMembers: [ALICE], showTags: true })}
      />
    );
    openFilterMenu();

    expect(
      screen.getByRole("menuitem", { name: ASSIGNEE_TRIGGER }).textContent
    ).toBe("Assignee");
    expect(
      screen.getByRole("menuitem", { name: DATES_TRIGGER }).textContent
    ).toBe("Dates");
    expect(
      screen.getByRole("menuitem", { name: TAGS_TRIGGER }).textContent
    ).toBe("Tags");
  });

  it("hides the Tags submenu when showTags is unset and there are no tag options", () => {
    render(
      <FilterPopover
        controller={NOOP_CONTROLLER}
        viewModel={builtInViewModel({ tagOptions: [] })}
      />
    );
    openFilterMenu();

    expect(
      screen.getByRole("menuitem", { name: ASSIGNEE_TRIGGER })
    ).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: TAGS_TRIGGER })).toBeNull();
  });

  it("hides the Priority submenu only when the host opts out", () => {
    const { unmount } = render(
      <FilterPopover
        controller={NOOP_CONTROLLER}
        viewModel={builtInViewModel()}
      />
    );
    openFilterMenu();
    expect(
      screen.getByRole("menuitem", { name: PRIORITY_TRIGGER })
    ).toBeInTheDocument();
    unmount();

    render(
      <FilterPopover
        controller={NOOP_CONTROLLER}
        viewModel={builtInViewModel({ hidePriority: true })}
      />
    );
    openFilterMenu();
    expect(
      screen.getByRole("menuitem", { name: ASSIGNEE_TRIGGER })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: PRIORITY_TRIGGER })
    ).toBeNull();
  });

  it("selects a preset under a nested date field submenu", () => {
    const setDateFilter = vi.fn();
    render(
      <FilterPopover
        controller={controllerWith({}, { setDateFilter })}
        viewModel={builtInViewModel()}
      />
    );
    openFacet(DATES_TRIGGER);
    expect(
      leadingIcon(screen.getByRole("menuitem", { name: CREATED_TRIGGER }))
    ).toBeNull();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: CREATED_TRIGGER }), {
      key: "ArrowRight",
    });
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: TABLE_DATE_PRESET_LABELS[TableDatePreset.Last24h],
      })
    );

    expect(setDateFilter).toHaveBeenCalledWith({
      field: TableDateFilterField.CreatedAt,
      preset: TableDatePreset.Last24h,
    });
  });
});

describe("AssigneeFilterContent v1", () => {
  it("shows the loading label instead of members", () => {
    renderInMenu(
      <AssigneeFilterContent
        controller={NOOP_CONTROLLER}
        viewModel={builtInViewModel({
          teamMembers: [ALICE],
          teamMembersLoading: true,
        })}
      />
    );

    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: ALICE_ROW })).toBeNull();
  });

  it("shows the load-error label instead of members", () => {
    renderInMenu(
      <AssigneeFilterContent
        controller={NOOP_CONTROLLER}
        viewModel={builtInViewModel({
          teamMembers: [ALICE],
          teamMembersError: "boom",
        })}
      />
    );

    expect(screen.getByText("Could not load members")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: ALICE_ROW })).toBeNull();
  });

  it("checks the selected member only and toggles by id", () => {
    const toggleAssignee = vi.fn();
    renderInMenu(
      <AssigneeFilterContent
        controller={controllerWith(
          { assigneeIds: [ALICE.id] },
          { toggleAssignee }
        )}
        viewModel={builtInViewModel({ teamMembers: [ALICE, BOB] })}
      />
    );

    const alice = screen.getByRole("menuitem", { name: ALICE_ROW });
    const bob = screen.getByRole("menuitem", { name: BOB_ROW });
    expect(within(alice).getByRole("checkbox")).toBeChecked();
    expect(within(bob).getByRole("checkbox")).not.toBeChecked();
    fireEvent.click(bob);
    expect(toggleAssignee).toHaveBeenCalledWith(BOB.id);
  });

  it("names the member search 'Search' when the placeholder label is empty", () => {
    renderInMenu(
      <AssigneeFilterContent
        controller={NOOP_CONTROLLER}
        viewModel={builtInViewModel({
          teamMembers: [ALICE],
          labels: { filterSearchPlaceholder: "" },
        })}
      />
    );

    expect(screen.getByRole("textbox", { name: "Search" })).toBeInTheDocument();
  });
});

describe("DateFilterContent v1", () => {
  it("defaults to the created-at field and the default presets", () => {
    const setDateFilter = vi.fn();
    renderInMenu(
      <DateFilterContent controller={controllerWith({}, { setDateFilter })} />
    );

    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(
      [
        TableDatePreset.Last24h,
        TableDatePreset.Last7d,
        TableDatePreset.Last30d,
        TableDatePreset.Last3m,
      ].map((preset) => TABLE_DATE_PRESET_LABELS[preset])
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: TABLE_DATE_PRESET_LABELS[TableDatePreset.Last30d],
      })
    );
    expect(setDateFilter).toHaveBeenCalledWith({
      field: TableDateFilterField.CreatedAt,
      preset: TableDatePreset.Last30d,
    });
  });

  it("checks the active preset and clears it when selected again", () => {
    const setDateFilter = vi.fn();
    renderInMenu(
      <DateFilterContent
        controller={controllerWith(
          {
            date: {
              field: TableDateFilterField.UpdatedAt,
              preset: TableDatePreset.Last7d,
            },
          },
          { setDateFilter }
        )}
        datePresetOptions={[
          { value: TableDatePreset.Last7d, label: "Week" },
          { value: TableDatePreset.Last3m, label: "Quarter" },
        ]}
        field={TableDateFilterField.UpdatedAt}
      />
    );

    const week = screen.getByRole("menuitem", { name: "Week" });
    expect(hasCheck(week)).toBe(true);
    expect(hasCheck(screen.getByRole("menuitem", { name: "Quarter" }))).toBe(
      false
    );
    fireEvent.click(week);
    expect(setDateFilter).toHaveBeenCalledWith(null);
  });

  it("ignores a preset set on a different field", () => {
    renderInMenu(
      <DateFilterContent
        controller={controllerWith({
          date: {
            field: TableDateFilterField.UpdatedAt,
            preset: TableDatePreset.Last7d,
          },
        })}
      />
    );

    expect(
      hasCheck(
        screen.getByRole("menuitem", {
          name: TABLE_DATE_PRESET_LABELS[TableDatePreset.Last7d],
        })
      )
    ).toBe(false);
  });
});

describe("TagsFilterContent v1", () => {
  it("shows the no-tags row when the view model has no tag options", () => {
    const viewModel: TableFiltersViewModel = builtInViewModel();
    renderInMenu(
      <TagsFilterContent controller={NOOP_CONTROLLER} viewModel={viewModel} />
    );

    const empty = screen.getByRole("menuitem", { name: "No tags created yet" });
    expect(empty).toHaveAttribute("aria-disabled", "true");
  });

  it("checks selected tags and toggles by id", () => {
    const toggleTag = vi.fn();
    renderInMenu(
      <TagsFilterContent
        controller={controllerWith({ tagIds: [TAG_A.id] }, { toggleTag })}
        viewModel={builtInViewModel({ tagOptions: [TAG_A] })}
      />
    );

    const row = screen.getByRole("menuitem", { name: `${TAG_A.label}2` });
    expect(within(row).getByRole("checkbox")).toBeChecked();
    fireEvent.click(row);
    expect(toggleTag).toHaveBeenCalledWith(TAG_A.id);
  });
});

describe("FilterGroupContent v1", () => {
  it("uses the default search placeholder for an options group", () => {
    renderInMenu(
      <FilterGroupContent
        group={{
          id: "owner",
          label: "Owner",
          options: [ALICE],
          selectedValues: [],
          onToggle: vi.fn(),
        }}
      />
    );

    expect(
      screen.getByRole("textbox", { name: DEFAULT_SEARCH_PLACEHOLDER })
    ).toBeInTheDocument();
  });

  it("uses the default clear label for a range group", () => {
    const onChange = vi.fn();
    renderInMenu(
      <FilterGroupContent
        group={{
          id: "cost",
          kind: "range",
          label: "Cost",
          min: 3,
          onChange,
        }}
      />
    );

    fireEvent.click(screen.getByText("Clear"));
    expect(onChange).toHaveBeenCalledWith({});
  });
});

describe("FilterPopover v1-only branches", () => {
  const ACTIVE_TINT_CLASS = "bg-primary/10";

  it("tints the active trigger only when the host supplies onClear", () => {
    const textFilter = { value: "abc", onChange: vi.fn() };
    const { unmount } = render(
      <FilterPopover
        controller={NOOP_CONTROLLER}
        textFilter={textFilter}
        viewModel={builtInViewModel()}
      />
    );
    expect(filterButton().textContent).toBe("Filter1");
    expect(filterButton()).not.toHaveClass(ACTIVE_TINT_CLASS);
    unmount();

    render(
      <FilterPopover
        controller={NOOP_CONTROLLER}
        onClear={vi.fn()}
        textFilter={textFilter}
        viewModel={builtInViewModel()}
      />
    );
    expect(filterButton()).toHaveClass(ACTIVE_TINT_CLASS);
  });

  it("drops only the favorites toggle when hideFavoritesToggle is set", () => {
    render(
      <FilterPopover
        controller={NOOP_CONTROLLER}
        viewModel={builtInViewModel({
          hideQuickToggles: false,
          hideFavoritesToggle: true,
        })}
      />
    );
    openFilterMenu();

    expect(screen.queryByRole("menuitem", { name: MY_FAVORITES })).toBeNull();
    expect(
      screen.getByRole("menuitem", { name: HIDE_COMPLETED })
    ).toBeInTheDocument();
  });

  it("hands additional range groups to the host's range renderer", () => {
    const renderRangeSubmenu = vi.fn(
      (group: { label: string }, clearLabel: string) => (
        <span>{`${group.label} via host (${clearLabel})`}</span>
      )
    );
    render(
      <FilterPopover
        controller={NOOP_CONTROLLER}
        renderRangeSubmenu={renderRangeSubmenu}
        viewModel={builtInViewModel({
          additionalFacetGroups: [
            {
              id: "cost",
              kind: "range",
              label: "Cost",
              min: 2,
              onChange: vi.fn(),
            },
          ],
        })}
      />
    );

    expect(filterButton().textContent).toBe("Filter1");
    openFilterMenu();
    expect(screen.getByText("Cost via host (Clear)")).toBeInTheDocument();
  });
});
