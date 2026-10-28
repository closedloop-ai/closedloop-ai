import { Priority } from "@repo/api/src/types/common";
import { createEvent, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { render } from "../../../shared/test-fixtures/render-with-nav";
import {
  ADA,
  makeProjectSummaryRow,
} from "../../__tests__/project-summary-row-fixtures";
import type { ProjectSummaryRow } from "../../lib/project-summary-row";
import {
  buildProjectGroups,
  type ProjectSummaryGroup,
} from "../../lib/project-summary-view";
import { PROJECT_DRAG_MIME, ProjectBoard } from "../project-board";

const APOLLO = makeProjectSummaryRow({
  childTaskCount: 4,
  code: "PRO-1",
  completionPercentage: 49.6,
  id: "1",
  name: "Apollo",
  owner: ADA,
  priority: Priority.High,
});
const BOREALIS = makeProjectSummaryRow({
  id: "2",
  name: "Borealis",
  priority: Priority.Low,
});
const PRIORITY_ICON_SELECTOR = '[data-slot="priority-icon"]';

function cell(key: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-project-board-cell="${key}"]`
  );
  if (!element) {
    throw new Error(`no board cell ${key}`);
  }
  return element;
}

function card(name: string): HTMLElement {
  const element = screen.getByText(name).closest<HTMLElement>("[draggable]");
  if (!element) {
    throw new Error(`no card ${name}`);
  }
  return element;
}

function dataTransfer(projectId = "") {
  return {
    dropEffect: "none",
    effectAllowed: "all",
    getData: vi.fn(() => projectId),
    setData: vi.fn(),
  };
}

function dragLeaveTo(relatedTarget: Element): Event {
  const event = createEvent.dragLeave(document.body);
  Object.defineProperty(event, "relatedTarget", { value: relatedTarget });
  return event;
}

function ungrouped(items: ProjectSummaryRow[]): ProjectSummaryGroup[] {
  return [{ items, key: "all", label: "All projects" }];
}

describe("ProjectBoard cards", () => {
  it("shows code, rounded completion, owner and priority when neither is grouped", () => {
    render(
      <ProjectBoard
        groupBy="none"
        groups={ungrouped([APOLLO, BOREALIS])}
        onGroupDrop={vi.fn()}
        secondaryGroupBy="none"
      />
    );
    const apollo = card("Apollo");
    expect(within(apollo).getByText("PRO-1")).toBeInTheDocument();
    expect(within(apollo).getByText("50%")).toBeInTheDocument();
    expect(within(apollo).getByText(ADA.name)).toBeInTheDocument();
    // One initial on every avatar (Nerys, 2026-10-22): the stored "AL" draws
    // "A".
    expect(within(apollo).getByText("A")).toBeInTheDocument();
    expect(apollo.querySelectorAll(PRIORITY_ICON_SELECTOR)).toHaveLength(1);

    const borealis = card("Borealis");
    expect(within(borealis).getByText("Project")).toBeInTheDocument();
    expect(within(borealis).getByText("—")).toBeInTheDocument();
    expect(within(borealis).getByText("No owner")).toBeInTheDocument();
  });

  it("still draws a priority glyph for a project with no priority", () => {
    render(
      <ProjectBoard
        groupBy="none"
        groups={ungrouped([
          makeProjectSummaryRow({ id: "3", name: "Cassini" }),
        ])}
        onGroupDrop={vi.fn()}
        secondaryGroupBy="none"
      />
    );
    expect(
      card("Cassini").querySelectorAll(PRIORITY_ICON_SELECTOR)
    ).toHaveLength(1);
  });

  it("omits the owner when owner is a grouping dimension and priority when priority is", () => {
    render(
      <ProjectBoard
        groupBy="owner"
        groups={ungrouped([APOLLO])}
        onGroupDrop={vi.fn()}
        secondaryGroupBy="priority"
      />
    );
    const apollo = card("Apollo");
    expect(within(apollo).queryByText(ADA.name)).toBeNull();
    expect(apollo.querySelectorAll(PRIORITY_ICON_SELECTOR)).toHaveLength(0);
  });

  it("omits the owner when owner is the SECONDARY dimension and priority when it is primary", () => {
    render(
      <ProjectBoard
        groupBy="priority"
        groups={ungrouped([APOLLO])}
        onGroupDrop={vi.fn()}
        secondaryGroupBy="owner"
      />
    );
    const apollo = card("Apollo");
    expect(within(apollo).queryByText(ADA.name)).toBeNull();
    expect(apollo.querySelectorAll(PRIORITY_ICON_SELECTOR)).toHaveLength(0);
  });

  it("links a card to the host href", () => {
    render(
      <ProjectBoard
        getRowHref={(project) => `/projects/${project.id}`}
        groupBy="none"
        groups={ungrouped([APOLLO])}
        onGroupDrop={vi.fn()}
        secondaryGroupBy="none"
      />
    );
    expect(screen.getByRole("link")).toHaveAttribute("href", "/projects/1");
  });

  it("keeps host actions outside the navigation link and drag target", () => {
    const onAction = vi.fn();
    render(
      <ProjectBoard
        getRowHref={(project) => `/projects/${project.id}`}
        groupBy="none"
        groups={ungrouped([APOLLO])}
        onGroupDrop={vi.fn()}
        rowActions={(project) => (
          <button onClick={() => onAction(project.id)} type="button">
            Open menu
          </button>
        )}
        secondaryGroupBy="none"
      />
    );
    const action = screen.getByRole("button", { name: "Open menu" });
    expect(action.closest("a")).toBeNull();
    expect(action.closest("[draggable]")).toBeNull();
    fireEvent.click(action);
    expect(onAction).toHaveBeenCalledWith(APOLLO.id);
  });

  it("renders no link when the host gives no href", () => {
    render(
      <ProjectBoard
        groupBy="none"
        groups={ungrouped([APOLLO])}
        onGroupDrop={vi.fn()}
        secondaryGroupBy="none"
      />
    );
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("ProjectBoard layout", () => {
  it("renders a header per band with its count and a row per subgroup with its summed count", () => {
    const groups = buildProjectGroups({
      groupBy: "priority",
      groupOrder: "custom",
      rows: [APOLLO, BOREALIS],
      secondaryGroupBy: "owner",
      secondaryGroupOrder: "asc",
      showEmptyGroups: false,
      showEmptySubgroups: true,
    });
    render(
      <ProjectBoard
        groupBy="priority"
        groups={groups ?? []}
        onGroupDrop={vi.fn()}
        secondaryGroupBy="owner"
      />
    );
    expect(
      [...document.querySelectorAll("[data-project-board-cell]")].map(
        (element) => element.getAttribute("data-project-board-cell")
      )
    ).toEqual([
      `${Priority.High}/${ADA.id}`,
      `${Priority.Low}/${ADA.id}`,
      `${Priority.High}/Unowned`,
      `${Priority.Low}/Unowned`,
    ]);
    expect(
      within(cell(`${Priority.High}/${ADA.id}`)).getByText("Apollo")
    ).toBeInTheDocument();
    expect(cell(`${Priority.Low}/${ADA.id}`).textContent).toBe("");
    const adaRow = screen.getByText(ADA.name).parentElement;
    expect(adaRow?.textContent).toBe(`${ADA.name}1`);
  });

  it("counts zero for a subgroup a band does not carry, and treats a band without subgroups as empty in that row", () => {
    const groups: ProjectSummaryGroup[] = [
      {
        items: [APOLLO],
        key: "a",
        label: "Band A",
        subgroups: [{ items: [APOLLO], key: "s1", label: "Sub one" }],
      },
      {
        items: [BOREALIS],
        key: "b",
        label: "Band B",
        subgroups: [{ items: [BOREALIS], key: "s2", label: "Sub two" }],
      },
      { items: [], key: "c", label: "Band C" },
    ];
    render(
      <ProjectBoard
        groupBy="priority"
        groups={groups}
        onGroupDrop={vi.fn()}
        secondaryGroupBy="owner"
      />
    );
    expect(screen.getByText("Sub one").parentElement?.textContent).toBe(
      "Sub one1"
    );
    expect(screen.getByText("Sub two").parentElement?.textContent).toBe(
      "Sub two1"
    );
    expect(cell("b/s1").textContent).toBe("");
    expect(cell("c/s1").textContent).toBe("");
    expect(within(cell("b/s2")).getByText("Borealis")).toBeInTheDocument();
    expect(screen.getByText("Band C").parentElement?.textContent).toBe(
      "Band C0"
    );
  });
});

describe("ProjectBoard drag and drop", () => {
  const GROUPS: ProjectSummaryGroup[] = [
    { items: [APOLLO], key: "a", label: "Band A" },
    { items: [BOREALIS], key: "b", label: "Band B" },
  ];

  it("writes the project id on drag start and hands the dropped project to the host", () => {
    const onGroupDrop = vi.fn();
    render(
      <ProjectBoard
        groupBy="owner"
        groups={GROUPS}
        onGroupDrop={onGroupDrop}
        secondaryGroupBy="none"
      />
    );
    const start = dataTransfer();
    fireEvent.dragStart(card("Apollo"), { dataTransfer: start });
    expect(start.setData).toHaveBeenCalledWith(PROJECT_DRAG_MIME, "1");
    expect(start.effectAllowed).toBe("move");

    const over = dataTransfer();
    expect(fireEvent.dragOver(cell("b/all"), { dataTransfer: over })).toBe(
      false
    );
    expect(over.dropEffect).toBe("move");

    const drop = dataTransfer("1");
    fireEvent.drop(cell("b/all"), { dataTransfer: drop });
    expect(drop.getData).toHaveBeenCalledWith(PROJECT_DRAG_MIME);
    expect(onGroupDrop).toHaveBeenCalledWith(APOLLO, GROUPS[1], undefined);
  });

  it("passes the subgroup the card landed in", () => {
    const onGroupDrop = vi.fn();
    const sub: ProjectSummaryGroup = { items: [], key: "s", label: "Sub" };
    const groups: ProjectSummaryGroup[] = [
      { items: [APOLLO], key: "a", label: "Band A", subgroups: [sub] },
    ];
    render(
      <ProjectBoard
        groupBy="owner"
        groups={groups}
        onGroupDrop={onGroupDrop}
        secondaryGroupBy="priority"
      />
    );
    fireEvent.drop(cell("a/s"), { dataTransfer: dataTransfer("1") });
    expect(onGroupDrop).toHaveBeenCalledWith(APOLLO, groups[0], sub);
  });

  it("ignores a drop carrying an id that is not on the board", () => {
    const onGroupDrop = vi.fn();
    render(
      <ProjectBoard
        groupBy="owner"
        groups={GROUPS}
        onGroupDrop={onGroupDrop}
        secondaryGroupBy="none"
      />
    );
    fireEvent.drop(cell("a/all"), { dataTransfer: dataTransfer("missing") });
    expect(onGroupDrop).not.toHaveBeenCalled();
  });

  it("highlights the entered cell and clears it only when the pointer leaves the cell", () => {
    render(
      <ProjectBoard
        groupBy="owner"
        groups={GROUPS}
        onGroupDrop={vi.fn()}
        secondaryGroupBy="none"
      />
    );
    const target = cell("a/all");
    fireEvent.dragEnter(target);
    expect(target).toHaveClass("ring-2");
    fireEvent(target, dragLeaveTo(card("Apollo")));
    expect(target).toHaveClass("ring-2");
    fireEvent(target, dragLeaveTo(document.body));
    expect(target).not.toHaveClass("ring-2");

    fireEvent.dragEnter(target);
    fireEvent.drop(target, { dataTransfer: dataTransfer("") });
    expect(target).not.toHaveClass("ring-2");
  });

  it("offers no drag or drop when disabled", () => {
    const onGroupDrop = vi.fn();
    render(
      <ProjectBoard
        dragDisabled
        groupBy="owner"
        groups={GROUPS}
        onGroupDrop={onGroupDrop}
        secondaryGroupBy="none"
      />
    );
    expect(card("Apollo")).toHaveAttribute("draggable", "false");
    const start = dataTransfer();
    fireEvent.dragStart(card("Apollo"), { dataTransfer: start });
    expect(start.setData).not.toHaveBeenCalled();
    const target = cell("b/all");
    fireEvent.dragEnter(target);
    expect(target).not.toHaveClass("ring-2");
    expect(fireEvent.dragOver(target, { dataTransfer: dataTransfer() })).toBe(
      true
    );
    fireEvent.drop(target, { dataTransfer: dataTransfer("1") });
    expect(onGroupDrop).not.toHaveBeenCalled();
  });

  it("makes cards draggable by default", () => {
    render(
      <ProjectBoard
        groupBy="owner"
        groups={GROUPS}
        onGroupDrop={vi.fn()}
        secondaryGroupBy="none"
      />
    );
    expect(card("Apollo")).toHaveAttribute("draggable", "true");
  });
});
