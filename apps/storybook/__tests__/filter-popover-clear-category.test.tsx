/**
 * Behavior tests for the Filter Popover demo's `clearCategoryFilter` switch.
 *
 * The classic `FilterPopover` never calls `clearCategoryFilter` itself (only
 * `ActiveFiltersBar` does), so the controller the demo hands the popover is
 * captured through a pass-through mock and each category is cleared directly.
 * Every case starts from a state where all seven categories are applied and
 * asserts that exactly one category went away, so a case falling through to
 * another arm fails.
 */
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus } from "@repo/api/src/types/document";
import type {
  DocumentTableFiltersController,
  DocumentTableFiltersState,
} from "@repo/app/documents/components/table/document-table-filters";
import {
  TableDateFilterField,
  TableDatePreset,
  type TableFilterCategory,
} from "@repo/design-system/components/ui/table-filters";
import { composeStory } from "@storybook/react";
import { act, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import filterPopoverMeta, {
  Default as defaultStory,
} from "../stories/filter-popover.stories";

const captured: { controller: DocumentTableFiltersController | null } = {
  controller: null,
};

vi.mock("@repo/design-system/components/ui/filter-popover", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/design-system/components/ui/filter-popover")
  >("@repo/design-system/components/ui/filter-popover");
  function CapturingFilterPopover(
    props: ComponentProps<typeof actual.FilterPopover>
  ) {
    captured.controller = props.controller as DocumentTableFiltersController;
    return <actual.FilterPopover {...props} />;
  }
  return { ...actual, FilterPopover: CapturingFilterPopover };
});

const Default = composeStory(
  { ...defaultStory, play: undefined },
  filterPopoverMeta
);

const FULL_STATE: DocumentTableFiltersState = {
  assigneeIds: ["user_2"],
  assignToMe: true,
  hideCompletedItems: true,
  favoritesOnly: true,
  statuses: [DocumentStatus.Draft],
  priorities: [Priority.High],
  date: {
    field: TableDateFilterField.CreatedAt,
    preset: TableDatePreset.Last7d,
  },
  tagIds: ["tag_quality"],
};

const ALL_CATEGORIES: TableFilterCategory[] = [
  "hideCompleted",
  "favorites",
  "assignee",
  "status",
  "priority",
  "date",
  "tags",
];

function controller(): DocumentTableFiltersController {
  if (!captured.controller) {
    throw new Error("FilterPopover never rendered");
  }
  return captured.controller;
}

function chipCategories(): string[] {
  return controller().activeChips.map((chip) => chip.category);
}

function renderFull() {
  render(<Default initialState={FULL_STATE} />);
}

function clear(category: TableFilterCategory) {
  act(() => controller().clearCategoryFilter(category));
}

afterEach(() => {
  captured.controller = null;
});

describe("FilterPopover demo clearCategoryFilter", () => {
  it("starts from a state with every category applied", () => {
    renderFull();
    expect(chipCategories()).toEqual(ALL_CATEGORIES);
  });

  it("clears assignee ids and assign-to-me together", () => {
    renderFull();
    clear("assignee");
    expect(controller().filters.assigneeIds).toEqual([]);
    expect(controller().filters.assignToMe).toBe(false);
    expect(chipCategories()).toEqual(
      ALL_CATEGORIES.filter((c) => c !== "assignee")
    );
  });

  it("clears statuses only", () => {
    renderFull();
    clear("status");
    expect(controller().filters.statuses).toEqual([]);
    expect(controller().filters.assigneeIds).toEqual(["user_2"]);
    expect(chipCategories()).toEqual(
      ALL_CATEGORIES.filter((c) => c !== "status")
    );
  });

  it("clears priorities only", () => {
    renderFull();
    clear("priority");
    expect(controller().filters.priorities).toEqual([]);
    expect(chipCategories()).toEqual(
      ALL_CATEGORIES.filter((c) => c !== "priority")
    );
  });

  it("clears the date filter only", () => {
    renderFull();
    clear("date");
    expect(controller().filters.date).toBeNull();
    expect(chipCategories()).toEqual(
      ALL_CATEGORIES.filter((c) => c !== "date")
    );
  });

  it("clears hide-completed only", () => {
    renderFull();
    clear("hideCompleted");
    expect(controller().filters.hideCompletedItems).toBe(false);
    expect(controller().filters.favoritesOnly).toBe(true);
    expect(chipCategories()).toEqual(
      ALL_CATEGORIES.filter((c) => c !== "hideCompleted")
    );
  });

  it("clears favorites only", () => {
    renderFull();
    clear("favorites");
    expect(controller().filters.favoritesOnly).toBe(false);
    expect(controller().filters.hideCompletedItems).toBe(true);
    expect(chipCategories()).toEqual(
      ALL_CATEGORIES.filter((c) => c !== "favorites")
    );
  });

  it("clears tags only", () => {
    renderFull();
    clear("tags");
    expect(controller().filters.tagIds).toEqual([]);
    expect(chipCategories()).toEqual(
      ALL_CATEGORIES.filter((c) => c !== "tags")
    );
  });
});
