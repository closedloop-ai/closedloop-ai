// @vitest-environment jsdom

import { ARTIFACT_STATUS_ROOT } from "@repo/api/src/types/artifact-status";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type { GridTableV2Group as GridTableGroup } from "@repo/design-system/components/ui/grid-table-v2";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { genericArtifactStatusLabel } from "../../../generic-artifact-status";
import {
  ArtifactKind,
  ArtifactStatus,
  type GenericArtifact,
  genericArtifacts,
} from "../../fixtures";
import { EDITABLE_OWNERS } from "../artifact-list-owners";
import { ArtifactStatusBoard } from "../artifact-status-board";

const TODO1_PATTERN = /^Todo1$/;

const N1_PATTERN = /^1$/;

const HIGHLIGHT_CLASS = "bg-primary/10";

const issue = {
  ...genericArtifacts.find((artifact) => artifact.kind === ArtifactKind.Issue)!,
  commentCount: 3,
  id: "issue-1",
  status: ArtifactStatus.Todo,
  title: "Issue card",
};
const branch = {
  ...genericArtifacts.find(
    (artifact) => artifact.kind === ArtifactKind.Branch
  )!,
  commentCount: 0,
  id: "branch-1",
  title: "Branch card",
};

type BoardProps = ComponentProps<typeof ArtifactStatusBoard>;

function renderBoard(overrides: Partial<BoardProps> = {}) {
  const props: BoardProps = {
    config: { editable: true },
    defaultKind: ArtifactKind.Issue,
    groupBy: "owner",
    groups: [{ items: [issue], key: issue.owner, label: issue.owner }],
    noun: { plural: "artifacts", singular: "artifact" },
    onGroupDrop: vi.fn(),
    onOpen: vi.fn(),
    onStatusChange: vi.fn(),
    secondaryGroupBy: "none",
    ...overrides,
  };
  const result = render(<ArtifactStatusBoard {...props} />);
  return { ...result, props };
}

function transfer() {
  const stored = new Map<string, string>();
  return {
    dropEffect: "none",
    effectAllowed: "none",
    getData: (type: string) => stored.get(type) ?? "",
    setData: (type: string, value: string) => stored.set(type, value),
  };
}

function card(title: string): HTMLElement {
  return screen.getByText(title).closest<HTMLElement>("[draggable]")!;
}

describe("ArtifactStatusBoard card interactions", () => {
  it("opens a card on click, Enter, and Space but not other keys", () => {
    const { props } = renderBoard();
    const target = card(issue.title);

    fireEvent.click(target);
    fireEvent.keyDown(target, { key: "Enter" });
    fireEvent.keyDown(target, { key: " " });
    fireEvent.keyDown(target, { key: "a" });

    expect(props.onOpen).toHaveBeenCalledTimes(3);
    expect(props.onOpen).toHaveBeenLastCalledWith(issue);
  });

  it("renders the title as a link when an href is resolved without opening the card", () => {
    const { props } = renderBoard({
      onOpenHref: (artifact) =>
        artifact.id === issue.id ? `/artifacts/${artifact.id}` : undefined,
    });
    const link = screen.getByRole("link", { name: issue.title });

    expect(link).toHaveAttribute("href", "/artifacts/issue-1");
    fireEvent.click(link);
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it("leaves Enter and Space on the title controls to those controls", () => {
    const { props } = renderBoard({
      onOpenHref: (artifact) => `/artifacts/${artifact.id}`,
      onSelect: vi.fn(),
      renderTitle: (artifact) => <input aria-label={artifact.title} />,
    });
    const editor = screen.getByRole("textbox", { name: issue.title });

    expect(fireEvent.keyDown(editor, { key: " " })).toBe(true);
    expect(fireEvent.keyDown(editor, { key: "Enter" })).toBe(true);
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it("does not select the card for Enter on its title link", () => {
    const { props } = renderBoard({
      onOpenHref: (artifact) => `/artifacts/${artifact.id}`,
      onSelect: vi.fn(),
    });

    fireEvent.keyDown(screen.getByRole("link", { name: issue.title }), {
      key: "Enter",
    });
    expect(props.onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(card(issue.title), { key: "Enter" });
    expect(props.onSelect).toHaveBeenCalledTimes(1);
  });

  it("renders selected state and only visible, non-grouped host fields", () => {
    const { container } = renderBoard({
      renderField: (field) => <span>{field} value</span>,
      selectedArtifactIds: new Set([issue.id]),
      visibleColumnIds: new Set(["owner", "comments"]),
    });

    expect(container.querySelector(".ring-primary\\/20")).toBeTruthy();
    expect(screen.queryByText("owner value")).toBeNull();
    expect(screen.getByText("comments value")).toBeInTheDocument();
  });

  it("shows the comment count only when there are comments", () => {
    renderBoard({
      groups: [
        { items: [issue, branch], key: issue.owner, label: issue.owner },
      ],
    });

    expect(card(issue.title)).toHaveTextContent(`${issue.owner}3`);
    expect(card(branch.title)).toHaveTextContent(
      `${branch.owner}${branch.updated}`
    );
  });

  it("offers every kind option and moves to the selected one", async () => {
    const user = userEvent.setup();
    const { props } = renderBoard();

    await user.click(
      screen.getByRole("button", { name: `Actions for ${issue.title}` })
    );
    const current = screen.getByRole("menuitem", {
      name: `Move to ${genericArtifactStatusLabel(issue)}`,
    });
    expect(current).toHaveAttribute("aria-disabled", "true");
    await user.click(
      screen.getByRole("menuitem", {
        name: `Move to ${genericArtifactStatusLabel({ kind: ArtifactKind.Issue, status: ArtifactStatus.Done })}`,
      })
    );

    expect(props.onStatusChange).toHaveBeenCalledWith(
      issue.id,
      ArtifactStatus.Done,
      ArtifactStatusEditSurface.Board
    );
  });

  it("explains a surface-level read-only board with its source label or the default", async () => {
    const user = userEvent.setup();
    const { unmount } = renderBoard({
      config: { editable: false, sourceLabel: "Managed in Linear" },
    });
    await user.click(
      screen.getByRole("button", { name: `Actions for ${issue.title}` })
    );
    expect(screen.getByRole("menuitem")).toHaveTextContent("Managed in Linear");
    unmount();

    renderBoard({ config: { editable: false } });
    await user.click(
      screen.getByRole("button", { name: `Actions for ${issue.title}` })
    );
    expect(screen.getByRole("menuitem")).toHaveTextContent(
      "Status is source-managed"
    );
  });

  it("lets any row drag when status grouping is inactive", () => {
    renderBoard({
      config: { editable: false },
      groups: [
        { items: [issue, branch], key: issue.owner, label: issue.owner },
      ],
    });

    expect(card(issue.title)).toHaveAttribute("draggable", "true");
    expect(card(branch.title)).toHaveAttribute("draggable", "true");
  });
});

describe("ArtifactStatusBoard lanes and bands", () => {
  it("renders nothing for a status lane key with no facet but keeps its count", () => {
    const { container } = renderBoard({
      groupBy: "status",
      groups: [{ items: [issue], key: "not-a-root", label: "Mystery" }],
    });

    expect(screen.queryByText("Mystery")).toBeNull();
    expect(container.querySelector(".sticky")).toHaveTextContent(N1_PATTERN);
  });

  it("derives owner bands with initials, counts, and empty cells", () => {
    const [ottilie, pascoe] = EDITABLE_OWNERS;
    const groups: GridTableGroup<GenericArtifact>[] = [
      {
        items: [issue],
        key: ARTIFACT_STATUS_ROOT.Todo,
        label: "Todo",
        subgroups: [
          { items: [issue], key: ottilie.name, label: ottilie.name },
          { items: [], key: "No value", label: "Unassigned" },
        ],
      },
      {
        items: [],
        key: ARTIFACT_STATUS_ROOT.Done,
        label: "Done",
      },
      {
        items: [],
        key: ARTIFACT_STATUS_ROOT.InReview,
        label: "In review",
        subgroups: [{ items: [], key: pascoe.name, label: pascoe.name }],
      },
    ];
    const { container } = renderBoard({
      groupBy: "status",
      groups,
      secondaryGroupBy: "owner",
    });

    const rowHeaders = [
      ...container.querySelectorAll<HTMLElement>(".col-span-full"),
    ].map((row) => row.textContent);
    // One initial on every avatar (Nerys, 2026-10-22).
    expect(rowHeaders).toEqual([
      `O${ottilie.name}1`,
      "—Unassigned0",
      `P${pascoe.name}0`,
    ]);
    const emptyCell = container.querySelector(
      `[data-status-board-cell="${ARTIFACT_STATUS_ROOT.Done}/${ottilie.name}"]`
    );
    expect(emptyCell?.querySelector("[draggable]")).toBeNull();
    expect(
      container.querySelectorAll(
        `[data-status-board-cell="${ARTIFACT_STATUS_ROOT.Todo}/${ottilie.name}"] [draggable]`
      )
    ).toHaveLength(1);
  });

  it("uses status subgroups as bands without owner avatars", () => {
    const { container } = renderBoard({
      groupBy: "owner",
      groups: [
        {
          items: [issue],
          key: issue.owner,
          label: issue.owner,
          subgroups: [
            { items: [issue], key: ARTIFACT_STATUS_ROOT.Todo, label: "Todo" },
          ],
        },
        { items: [], key: "Pascoe Birchall", label: "Pascoe Birchall" },
      ],
      secondaryGroupBy: "status",
    });

    expect(container.querySelector(".col-span-full")).toHaveTextContent(
      TODO1_PATTERN
    );
    expect(card(issue.title)).toBeInTheDocument();
  });

  it("highlights a droppable cell on drag enter and clears it on leave and drag end", () => {
    const dataTransfer = transfer();
    const { container } = renderBoard({
      groupBy: "status",
      groups: [
        { items: [issue], key: ARTIFACT_STATUS_ROOT.Todo, label: "Todo" },
        { items: [], key: ARTIFACT_STATUS_ROOT.Done, label: "Done" },
      ],
    });
    const doneCell = container.querySelector<HTMLElement>(
      `[data-status-board-cell="${ARTIFACT_STATUS_ROOT.Done}/"]`
    )!;

    fireEvent.dragEnter(doneCell, { dataTransfer });
    expect(doneCell).not.toHaveClass(HIGHLIGHT_CLASS);

    fireEvent.dragStart(card(issue.title), { dataTransfer });
    fireEvent.dragEnter(doneCell, { dataTransfer });
    expect(doneCell).toHaveClass(HIGHLIGHT_CLASS);

    fireEvent.dragLeave(doneCell);
    expect(doneCell).not.toHaveClass(HIGHLIGHT_CLASS);

    fireEvent.dragEnter(doneCell, { dataTransfer });
    fireEvent.dragEnd(card(issue.title));
    expect(doneCell).not.toHaveClass(HIGHLIGHT_CLASS);
    expect(fireEvent.dragOver(doneCell, { dataTransfer })).toBe(true);
  });

  it("does not highlight a lane for a read-only dragged row", () => {
    const dataTransfer = transfer();
    const { container } = renderBoard({
      groupBy: "status",
      groups: [
        { items: [branch], key: ARTIFACT_STATUS_ROOT.Todo, label: "Todo" },
        { items: [], key: ARTIFACT_STATUS_ROOT.Done, label: "Done" },
      ],
    });
    const doneCell = container.querySelector<HTMLElement>(
      `[data-status-board-cell="${ARTIFACT_STATUS_ROOT.Done}/"]`
    )!;

    fireEvent.dragStart(card(branch.title), { dataTransfer });
    fireEvent.dragEnter(doneCell, { dataTransfer });

    expect(doneCell).not.toHaveClass(HIGHLIGHT_CLASS);
  });

  it("passes the secondary axis through a two-axis drop", () => {
    const dataTransfer = transfer();
    const [ottilie, pascoe] = EDITABLE_OWNERS;
    const { container, props } = renderBoard({
      groupBy: "status",
      groups: [
        {
          items: [issue],
          key: ARTIFACT_STATUS_ROOT.Todo,
          label: "Todo",
          subgroups: [
            { items: [issue], key: ottilie.name, label: ottilie.name },
          ],
        },
        {
          items: [],
          key: ARTIFACT_STATUS_ROOT.Done,
          label: "Done",
          subgroups: [{ items: [], key: pascoe.name, label: pascoe.name }],
        },
      ],
      secondaryGroupBy: "owner",
    });
    const cell = container.querySelector<HTMLElement>(
      `[data-status-board-cell="${ARTIFACT_STATUS_ROOT.Done}/${pascoe.name}"]`
    )!;

    fireEvent.dragStart(card(issue.title), { dataTransfer });
    fireEvent.drop(cell, { dataTransfer });

    expect(props.onGroupDrop).toHaveBeenCalledWith(
      issue.id,
      "status",
      ARTIFACT_STATUS_ROOT.Done,
      "owner",
      pascoe.name
    );
  });
});
