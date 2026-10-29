// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  GenericArtifactKind,
  GenericArtifactStatus,
  genericArtifactCompatibleStatusOptions,
} from "../../../generic-artifact-status";
import { type GenericArtifact, genericArtifacts } from "../../fixtures";
import {
  ArtifactBulkActionBar,
  applyArtifactBulkMutation,
} from "../artifact-list-control-adapters";
import { INITIAL_TAG_DEFINITIONS } from "../artifact-list-model";
import { EDITABLE_OWNERS } from "../artifact-list-owners";

const NOUN = { plural: "artifacts", singular: "artifact" };
const NO_MATCHES = "No matches";
const CHANGE_STATUS = "Change status";
const MOVE_TO_PROJECT = "Move to project";
const CREATE_PREFIX = /^Create “/;
const STATUS_OPTIONS = genericArtifactCompatibleStatusOptions([
  { kind: GenericArtifactKind.Issue, status: GenericArtifactStatus.Todo },
]);

const ROW: GenericArtifact = {
  ...genericArtifacts[0],
  owner: "Ottilie Eastwick",
  ownerInitials: "AE",
  project: "Platform",
  tags: ["UX"],
};

describe("applyArtifactBulkMutation", () => {
  it("moves the row to a project, keeping the old one when no value is given", () => {
    expect(
      applyArtifactBulkMutation(ROW, "add-to-project", "Design system")
    ).toMatchObject({ project: "Design system" });
    expect(applyArtifactBulkMutation(ROW, "add-to-project")).toMatchObject({
      project: "Platform",
    });
  });

  it("assigns a known owner with initials and ignores an unknown one", () => {
    const [, owner] = EDITABLE_OWNERS;

    expect(
      applyArtifactBulkMutation(ROW, "assign-owner", owner.name)
    ).toMatchObject({ owner: owner.name, ownerInitials: owner.initials });
    expect(applyArtifactBulkMutation(ROW, "assign-owner", "Nobody")).toBe(ROW);
  });

  it("appends a new tag, and returns the same row for a repeat or a missing tag", () => {
    expect(applyArtifactBulkMutation(ROW, "add-tag", "Design").tags).toEqual([
      "UX",
      "Design",
    ]);
    expect(applyArtifactBulkMutation(ROW, "add-tag", "UX")).toBe(ROW);
    expect(applyArtifactBulkMutation(ROW, "add-tag")).toBe(ROW);
  });

  it("leaves the row untouched for favorite", () => {
    expect(applyArtifactBulkMutation(ROW, "favorite", "anything")).toBe(ROW);
  });
});

function renderBar(
  overrides: Partial<Parameters<typeof ArtifactBulkActionBar>[0]> = {}
) {
  const onAction = vi.fn();
  const onClear = vi.fn();
  render(
    <ArtifactBulkActionBar
      count={2}
      currentTags={INITIAL_TAG_DEFINITIONS.slice(0, 3)}
      noun={NOUN}
      onAction={onAction}
      onClear={onClear}
      {...overrides}
    />
  );
  return { onAction, onClear };
}

function firstButton(container: HTMLElement) {
  const [button] = within(container).getAllByRole("button");
  if (!button) {
    throw new Error("the picker renders no option");
  }
  return button;
}

function openPicker(label: string) {
  fireEvent.click(screen.getByRole("button", { name: label }));
  return screen.getByRole("dialog");
}

describe("ArtifactBulkActionBar toolbar", () => {
  it("counts the selection with the plural or singular noun", () => {
    renderBar();
    renderBar({ count: 1 });

    expect(
      screen.getByRole("toolbar", { name: "2 artifacts selected" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("toolbar", { name: "1 artifact selected" })
    ).toBeInTheDocument();
  });

  it("clears the selection", () => {
    const { onClear } = renderBar();

    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));

    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("omits status and move pickers without both a handler and options", () => {
    renderBar({
      onProjectMove: vi.fn(),
      onStatusChange: vi.fn(),
      projectMoveDestinations: [],
      statusOptions: [],
    });
    renderBar({
      projectMoveDestinations: [{ id: "p", label: "Platform" }],
      statusOptions: STATUS_OPTIONS,
    });

    expect(
      screen.getAllByRole("button", { name: "Add to project" })
    ).toHaveLength(2);
    expect(screen.queryByRole("button", { name: CHANGE_STATUS })).toBeNull();
    expect(screen.queryByRole("button", { name: MOVE_TO_PROJECT })).toBeNull();
  });

  it("offers status and move pickers when each has a handler and options", () => {
    const onProjectMove = vi.fn();
    renderBar({
      onProjectMove,
      onStatusChange: vi.fn(),
      projectMoveDestinations: [{ id: "p", label: "Platform" }],
      statusOptions: STATUS_OPTIONS,
    });

    expect(
      screen.getByRole("button", { name: CHANGE_STATUS })
    ).toBeInTheDocument();
    const picker = openPicker(MOVE_TO_PROJECT);
    fireEvent.click(within(picker).getByRole("button", { name: "Platform" }));

    expect(onProjectMove).toHaveBeenCalledWith("Platform");
  });

  it("omits status and move pickers when a handler comes with no option list", () => {
    renderBar({ onProjectMove: vi.fn(), onStatusChange: vi.fn() });

    expect(
      screen.getByRole("button", { name: "Add to project" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: CHANGE_STATUS })).toBeNull();
    expect(screen.queryByRole("button", { name: MOVE_TO_PROJECT })).toBeNull();
  });

  it("closes the status picker after a pick", () => {
    const onStatusChange = vi.fn();
    renderBar({ onStatusChange, statusOptions: STATUS_OPTIONS });

    const picker = openPicker(CHANGE_STATUS);
    fireEvent.click(firstButton(picker));

    expect(onStatusChange).toHaveBeenCalledWith(STATUS_OPTIONS[0]?.key);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("ArtifactBulkActionBar pickers", () => {
  it("assigns an owner from the full owner list", () => {
    const { onAction } = renderBar();

    const picker = openPicker("Assign owner");
    expect(
      within(picker)
        .getAllByRole("button")
        .map((button) => button.textContent)
    ).toEqual(EDITABLE_OWNERS.map((owner) => owner.name));
    fireEvent.click(within(picker).getByRole("button", { name: "Sam Chen" }));

    expect(onAction).toHaveBeenCalledWith("assign-owner", "Sam Chen");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("filters projects case-insensitively and reports no matches without Create", () => {
    const { onAction } = renderBar();
    const picker = openPicker("Add to project");
    const search = within(picker).getByRole("textbox", {
      name: "Search add to project",
    });

    expect(
      within(picker)
        .getAllByRole("button")
        .map((button) => button.textContent)
    ).toEqual([
      "Ottilie August Strategic Projects",
      "Artifact foundations",
      "Design system",
      "Platform",
    ]);
    expect(within(picker).queryByText(NO_MATCHES)).toBeNull();

    fireEvent.change(search, { target: { value: " DESIGN " } });
    expect(
      within(picker)
        .getAllByRole("button")
        .map((button) => button.textContent)
    ).toEqual(["Design system"]);

    fireEvent.change(search, { target: { value: "zzz" } });
    expect(within(picker).getByText(NO_MATCHES)).toBeInTheDocument();
    expect(
      within(picker).queryByRole("button", { name: CREATE_PREFIX })
    ).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("creates a trimmed tag that no option names", () => {
    const { onAction } = renderBar();
    const picker = openPicker("Add tag");

    fireEvent.change(
      within(picker).getByRole("textbox", { name: "Search add tag" }),
      { target: { value: "  Novel  " } }
    );
    expect(within(picker).queryByText(NO_MATCHES)).toBeNull();
    const create = within(picker).getByRole("button", { name: CREATE_PREFIX });
    expect(create).toHaveAccessibleName("Create “Novel”");
    fireEvent.click(create);

    expect(onAction).toHaveBeenCalledWith("add-tag", "Novel");
  });

  it("offers no Create for an exact existing tag, case-insensitively", () => {
    renderBar();
    const picker = openPicker("Add tag");
    const [firstTag] = INITIAL_TAG_DEFINITIONS;

    fireEvent.change(
      within(picker).getByRole("textbox", { name: "Search add tag" }),
      { target: { value: firstTag.label.toUpperCase() } }
    );

    expect(
      within(picker).getByRole("button", { name: firstTag.label })
    ).toBeInTheDocument();
    expect(
      within(picker).queryByRole("button", { name: CREATE_PREFIX })
    ).toBeNull();
  });

  it("offers no Create for a blank query", () => {
    renderBar({ currentTags: [] });
    const picker = openPicker("Add tag");

    fireEvent.change(
      within(picker).getByRole("textbox", { name: "Search add tag" }),
      { target: { value: "   " } }
    );

    expect(within(picker).getByText(NO_MATCHES)).toBeInTheDocument();
  });

  it("forgets the query when the picker closes", () => {
    renderBar();
    let picker = openPicker("Add to project");
    const search = within(picker).getByRole("textbox", {
      name: "Search add to project",
    });
    fireEvent.change(search, { target: { value: "plat" } });

    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    picker = openPicker("Add to project");
    expect(
      within(picker).getByRole("textbox", { name: "Search add to project" })
    ).toHaveValue("");
    expect(within(picker).getAllByRole("button")).toHaveLength(4);
  });

  it("clears the query after a pick", () => {
    const { onAction } = renderBar();
    let picker = openPicker("Add to project");
    fireEvent.change(
      within(picker).getByRole("textbox", { name: "Search add to project" }),
      { target: { value: "plat" } }
    );
    fireEvent.click(within(picker).getByRole("button", { name: "Platform" }));
    expect(onAction).toHaveBeenCalledWith("add-to-project", "Platform");

    picker = openPicker("Add to project");
    expect(
      within(picker).getByRole("textbox", { name: "Search add to project" })
    ).toHaveValue("");
  });
});
