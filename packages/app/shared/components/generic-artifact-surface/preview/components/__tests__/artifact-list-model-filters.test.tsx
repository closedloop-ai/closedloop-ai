// @vitest-environment jsdom

import {
  ARTIFACT_STATUS_DETAIL,
  ARTIFACT_STATUS_ROOT,
  DISPLAYED_ARTIFACT_STATUS,
} from "@repo/api/src/types/artifact-status";
import {
  TableDateFilterField,
  TableDatePreset,
} from "@repo/design-system/components/ui/filter-popover";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ArtifactKind,
  ArtifactStatus,
  type GenericArtifact,
  genericArtifacts,
} from "../../fixtures";
import {
  type ArtifactFilters,
  buildFilterController,
  buildFilterViewModel,
  clearFilterCategory,
  datePresetLabel,
  initialArtifactFilters,
  updatedPresetMinutes,
} from "../artifact-list-model";
import { createStateSetter } from "./support/state-setter";

const template = genericArtifacts[0]!;

const busyFilters: ArtifactFilters = {
  favoritesOnly: true,
  kinds: [ArtifactKind.Issue, ArtifactKind.Branch],
  mineOnly: true,
  owners: ["Sam Chen"],
  statuses: [ARTIFACT_STATUS_ROOT.Done],
  tags: ["UX", "Design"],
  updatedPreset: TableDatePreset.Last7d,
};

describe("buildFilterController", () => {
  it("reports no chips and a null date for the initial filters", () => {
    const controller = buildFilterController(
      initialArtifactFilters,
      () => undefined
    );

    expect(controller.activeChips).toEqual([]);
    expect(controller.filters.date).toBeNull();
    expect(controller.filters.hideCompletedItems).toBe(false);
  });

  it("names the mine-only chip instead of the owner list when both are set", () => {
    const controller = buildFilterController(busyFilters, () => undefined);

    expect(controller.activeChips).toEqual([
      { category: "assignee", label: "Created by me" },
      { category: "favorites", label: "Favorites" },
      { category: "status", label: "Status: Done" },
      {
        category: "priority",
        label: `Type: ${ArtifactKind.Issue}, ${ArtifactKind.Branch}`,
      },
      { category: "date", label: "Updated: Last 7 days" },
      { category: "tags", label: "Tags: UX, Design" },
    ]);
    expect(controller.filters).toMatchObject({
      assignToMe: true,
      assigneeIds: ["Sam Chen"],
      date: {
        field: TableDateFilterField.UpdatedAt,
        preset: TableDatePreset.Last7d,
      },
      favoritesOnly: true,
      priorities: [ArtifactKind.Issue, ArtifactKind.Branch],
      statuses: [ARTIFACT_STATUS_ROOT.Done],
      tagIds: ["UX", "Design"],
    });
  });

  it("lists every chosen owner when mine-only is off", () => {
    const controller = buildFilterController(
      { ...initialArtifactFilters, owners: ["Sam Chen", "Pascoe Birchall"] },
      () => undefined
    );

    expect(controller.activeChips).toEqual([
      { category: "assignee", label: "Owner: Sam Chen, Pascoe Birchall" },
    ]);
  });

  it("labels each status by its canonical display copy", () => {
    const controller = buildFilterController(
      {
        ...initialArtifactFilters,
        statuses: [
          ARTIFACT_STATUS_ROOT.InReview,
          ARTIFACT_STATUS_DETAIL.IssueTriage,
        ],
      },
      () => undefined
    );

    expect(controller.activeChips).toEqual([
      { category: "status", label: "Status: In review, Triage" },
    ]);
  });

  it("clears the owner list when an owner is toggled or mine-only flips", () => {
    const state = createStateSetter<ArtifactFilters>({
      ...initialArtifactFilters,
      mineOnly: true,
      owners: ["Sam Chen"],
    });
    const controller = () => buildFilterController(state.current(), state.set);

    controller().toggleAssignee("Pascoe Birchall");
    expect(state.current()).toMatchObject({
      mineOnly: false,
      owners: ["Sam Chen", "Pascoe Birchall"],
    });

    controller().toggleAssignee("Sam Chen");
    expect(state.current().owners).toEqual(["Pascoe Birchall"]);

    controller().toggleAssignToMe();
    expect(state.current()).toMatchObject({ mineOnly: true, owners: [] });
    controller().toggleAssignToMe();
    expect(state.current().mineOnly).toBe(false);
  });

  it("toggles favorites, statuses, kinds, tags and the updated preset, and ignores hide-completed", () => {
    const state = createStateSetter<ArtifactFilters>(initialArtifactFilters);
    const controller = () => buildFilterController(state.current(), state.set);

    controller().toggleFavoritesOnly();
    controller().toggleStatus(ARTIFACT_STATUS_ROOT.Todo);
    controller().togglePriority(ArtifactKind.Branch);
    controller().toggleTag("Design");
    controller().setDateFilter({
      field: TableDateFilterField.UpdatedAt,
      preset: TableDatePreset.Last3m,
    });

    expect(state.current()).toEqual({
      ...initialArtifactFilters,
      favoritesOnly: true,
      kinds: [ArtifactKind.Branch],
      statuses: [ARTIFACT_STATUS_ROOT.Todo],
      tags: ["Design"],
      updatedPreset: TableDatePreset.Last3m,
    });

    controller().setDateFilter(null);
    const cleared = state.current();
    expect(cleared).toEqual({
      ...initialArtifactFilters,
      favoritesOnly: true,
      kinds: [ArtifactKind.Branch],
      statuses: [ARTIFACT_STATUS_ROOT.Todo],
      tags: ["Design"],
      updatedPreset: null,
    });

    controller().toggleHideCompletedItems();
    // Status is the only completed-work control on this surface, so the hide-completed toggle writes nothing.
    expect(state.current()).toBe(cleared);
  });

  it("clears one category or every filter", () => {
    const state = createStateSetter<ArtifactFilters>(busyFilters);
    const controller = () => buildFilterController(state.current(), state.set);

    controller().clearCategoryFilter("tags");
    expect(state.current()).toEqual({ ...busyFilters, tags: [] });

    controller().clearAllFilters();
    expect(state.current()).toEqual(initialArtifactFilters);
  });
});

describe("clearFilterCategory", () => {
  it.each([
    ["assignee", { mineOnly: false, owners: [] }],
    ["favorites", { favoritesOnly: false }],
    ["status", { statuses: [] }],
    ["priority", { kinds: [] }],
    ["date", { updatedPreset: null }],
    ["tags", { tags: [] }],
  ] as const)("resets only the %s filter", (category, reset) => {
    expect(clearFilterCategory(busyFilters, category)).toEqual({
      ...busyFilters,
      ...reset,
    });
  });

  it("returns the filters unchanged for a category the surface has no state for", () => {
    expect(clearFilterCategory(busyFilters, "hideCompleted")).toBe(busyFilters);
  });
});

describe("buildFilterViewModel", () => {
  it("counts each represented status key and offers one option per owner and tag", () => {
    const model = buildFilterViewModel(genericArtifacts);
    const byId = new Map(
      model.statusOptions.map((option) => [option.id, option])
    );

    expect(byId.get(ARTIFACT_STATUS_DETAIL.IssueTriage)).toMatchObject({
      count: 1,
      label: "Triage",
      searchText: "Triage",
    });
    expect(byId.get(ARTIFACT_STATUS_ROOT.InReview)?.count).toBe(1);
    expect(byId.get(ARTIFACT_STATUS_ROOT.Todo)?.count).toBe(0);
    expect(byId.has(ARTIFACT_STATUS_DETAIL.SessionRunning)).toBe(true);
    expect(model.teamMembers.map((member) => member.id)).toEqual([
      ...new Set(genericArtifacts.map((artifact) => artifact.owner)),
    ]);
    expect(model.tagOptions?.map((tag) => tag.id)).toContain("Governance");
    expect(model.priorityOptions.map((option) => option.id)).toEqual([
      ArtifactKind.Branch,
      ArtifactKind.Document,
      ArtifactKind.Issue,
      ArtifactKind.Session,
    ]);
    expect(model.hideCompletedToggle).toBe(true);
  });

  it("offers only the kinds the rows carry, in the canonical kind order", () => {
    const sessionThenIssue = [
      { ...template, id: "artifact-session", kind: ArtifactKind.Session },
      { ...template, id: "artifact-issue", kind: ArtifactKind.Issue },
    ];

    expect(
      buildFilterViewModel(sessionThenIssue).priorityOptions.map(
        (option) => option.id
      )
    ).toEqual(
      Object.values(ArtifactKind).filter(
        (kind) => kind === ArtifactKind.Issue || kind === ArtifactKind.Session
      )
    );
  });

  it("offers only the status keys of the kinds present", () => {
    const issueOnly = genericArtifacts.filter(
      (artifact) => artifact.kind === ArtifactKind.Issue
    );
    const ids = buildFilterViewModel(issueOnly).statusOptions.map(
      (option) => option.id
    );

    expect(ids).toContain(ARTIFACT_STATUS_DETAIL.IssueTriage);
    expect(ids).not.toContain(ARTIFACT_STATUS_DETAIL.SessionRunning);
    expect(ids).not.toContain(ARTIFACT_STATUS_DETAIL.DocumentApproved);
  });

  it("renders a root option and an indented detail option", () => {
    const model = buildFilterViewModel(genericArtifacts);
    const content = (id: string) => {
      const option = model.statusOptions.find(
        (candidate) => candidate.id === id
      );
      const { container } = render(<div>{option?.content}</div>);
      return container.firstElementChild?.firstElementChild;
    };

    expect(content(ARTIFACT_STATUS_ROOT.Todo)?.getAttribute("class")).toBe(
      null
    );
    expect(
      content(ARTIFACT_STATUS_DETAIL.IssueTriage)?.getAttribute("class")
    ).toContain("border-l");
  });

  it("names the current user and the facet labels, with no icon on any type option", () => {
    const model = buildFilterViewModel(genericArtifacts);

    expect(model.currentUser).toEqual({
      id: "Ottilie Eastwick",
      name: "Ottilie Eastwick",
    });
    expect(model.labels).toEqual({
      assignToMe: "Created by me",
      assignee: "Owner",
      favoritesOnly: "Favorites",
      filterButton: "Filters",
      priority: "Type",
      updatedDate: "Updated",
    });
    expect(model.priorityOptions.length).toBeGreaterThan(0);
    expect(model.priorityOptions.every((option) => !("icon" in option))).toBe(
      true
    );
  });

  it("appends an unknown status option when any row's status is unrecognized", () => {
    const unknown: GenericArtifact = {
      ...template,
      id: "artifact-unknown",
      status: ArtifactStatus.Active,
      statusRaw: "not-a-status",
    };
    const model = buildFilterViewModel([template, unknown]);

    const unknownOption = model.statusOptions.at(-1);

    expect(unknownOption?.id).toBe(DISPLAYED_ARTIFACT_STATUS.Unknown);
    expect(unknownOption?.count).toBe(1);
    expect(
      buildFilterViewModel([template]).statusOptions.map((option) => option.id)
    ).not.toContain(DISPLAYED_ARTIFACT_STATUS.Unknown);
  });
});

describe("date presets", () => {
  it.each([
    [TableDatePreset.Last24h, "Last 24 hours", 1440],
    [TableDatePreset.Last7d, "Last 7 days", 10_080],
    [TableDatePreset.Last30d, "Last 30 days", 43_200],
    [TableDatePreset.Last3m, "Last 3 months", 129_600],
  ])("labels %s and bounds it in minutes", (preset, label, minutes) => {
    expect(datePresetLabel(preset)).toBe(label);
    expect(updatedPresetMinutes(preset)).toBe(minutes);
  });

  it("calls a custom preset a custom range with no minute bound", () => {
    expect(datePresetLabel(TableDatePreset.Custom)).toBe("Custom range");
    expect(updatedPresetMinutes(TableDatePreset.Custom)).toBeNull();
    expect(updatedPresetMinutes(null)).toBeNull();
  });
});
