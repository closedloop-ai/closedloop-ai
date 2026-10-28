import { Priority } from "@repo/api/src/types/common";
import { priorityLabel } from "@repo/design-system/lib/priority-order";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "../../../shared/test-fixtures/render-with-nav";
import {
  ADA,
  GRACE,
  makeProjectSummaryRow,
} from "../../__tests__/project-summary-row-fixtures";
import {
  PROJECT_SAVED_VIEWS_KEY_PREFIX,
  type ProjectViewState,
} from "../../lib/project-saved-views";
import {
  PROJECT_SUMMARY_COLUMN_IDS,
  PROJECT_SUMMARY_LEADING_COLUMN_WIDTH_PX,
} from "../../lib/project-summary-columns";
import {
  INITIAL_PROJECT_FILTERS,
  UNOWNED_GROUP_KEY,
} from "../../lib/project-summary-view";
import { ProjectList } from "../project-list";

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

const VIEW_STATE_KEY = "test-projects";
const VIEW_NAME = "Restored";
// Each case drives Radix menus through a full ProjectList mount, which runs
// past the 5s default on a loaded box.
const UI_TEST_TIMEOUT_MS = 30_000;
const VIEWS_TRIGGER = /^Views$/;

const APOLLO = makeProjectSummaryRow({
  id: "1",
  name: "Apollo",
  owner: ADA,
  priority: Priority.High,
});
const BOREALIS = makeProjectSummaryRow({
  id: "2",
  name: "Borealis",
  owner: GRACE,
  priority: Priority.Low,
});
const ROWS = [APOLLO, BOREALIS];

const BASE_VIEW: ProjectViewState = {
  columnOrder: [...PROJECT_SUMMARY_COLUMN_IDS],
  columnWidths: {},
  filters: INITIAL_PROJECT_FILTERS,
  groupBy: "none",
  groupOrder: "custom",
  layout: "list",
  leadingColumnWidth: PROJECT_SUMMARY_LEADING_COLUMN_WIDTH_PX,
  secondaryGroupBy: "none",
  secondaryGroupOrder: "asc",
  showEmptyGroups: false,
  showEmptySubgroups: false,
  sortActive: false,
  sortBy: "name",
  sortDir: "asc",
  visibleColumnIds: [...PROJECT_SUMMARY_COLUMN_IDS],
};

async function renderWithView(
  overrides: Partial<ProjectViewState>,
  props: Partial<Parameters<typeof ProjectList>[0]> = {}
) {
  localStorage.setItem(
    `${PROJECT_SAVED_VIEWS_KEY_PREFIX}${VIEW_STATE_KEY}`,
    JSON.stringify({
      activeViewId: null,
      views: [
        {
          arrangement: { ...BASE_VIEW, ...overrides },
          id: "v1",
          name: VIEW_NAME,
        },
      ],
    })
  );
  render(<ProjectList rows={ROWS} viewStateKey={VIEW_STATE_KEY} {...props} />);
  const user = userEvent.setup();
  await user.click(screen.getAllByRole("button", { name: VIEWS_TRIGGER })[0]);
  await user.click(await screen.findByRole("menuitem", { name: VIEW_NAME }));
  return user;
}

function boardCells(): string[] {
  return [...document.querySelectorAll("[data-project-board-cell]")].map(
    (element) => element.getAttribute("data-project-board-cell") ?? ""
  );
}

function boardCell(key: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-project-board-cell="${key}"]`
  );
  if (!element) {
    throw new Error(`no board cell ${key}`);
  }
  return element;
}

function dropProject(projectId: string, cellKey: string) {
  fireEvent.drop(boardCell(cellKey), {
    dataTransfer: { getData: () => projectId },
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("ProjectList board from a restored view", {
  timeout: UI_TEST_TIMEOUT_MS,
}, () => {
  it("rewrites both grouped fields when a card is dropped into another cell", async () => {
    const onProjectGroupChange = vi.fn();
    await renderWithView(
      { groupBy: "owner", layout: "board", secondaryGroupBy: "priority" },
      { onProjectGroupChange }
    );
    expect(boardCells()).toEqual([
      `${ADA.id}/${Priority.High}`,
      `${GRACE.id}/${Priority.High}`,
      `${ADA.id}/${Priority.Low}`,
      `${GRACE.id}/${Priority.Low}`,
    ]);

    dropProject("1", `${GRACE.id}/${Priority.Low}`);
    expect(onProjectGroupChange).toHaveBeenCalledWith(
      { ...APOLLO, owner: GRACE, priority: Priority.Low },
      APOLLO
    );
  });

  it("disables drag when the host cannot persist a move", async () => {
    await renderWithView({ groupBy: "owner", layout: "board" });
    expect(screen.getByText("Apollo").closest("[draggable]")).toHaveAttribute(
      "draggable",
      "false"
    );
  });

  it("falls back to one undraggable All projects lane when the view has no grouping", async () => {
    const onProjectGroupChange = vi.fn();
    await renderWithView({ layout: "board" }, { onProjectGroupChange });
    expect(boardCells()).toEqual(["all/all"]);
    expect(screen.getByText("All projects")).toBeInTheDocument();
    expect(screen.getByText("Apollo").closest("[draggable]")).toHaveAttribute(
      "draggable",
      "false"
    );
  });

  it("drops a secondary grouping that repeats the primary one", async () => {
    await renderWithView({
      groupBy: "owner",
      layout: "board",
      secondaryGroupBy: "owner",
    });
    expect(boardCells()).toEqual([`${ADA.id}/all`, `${GRACE.id}/all`]);
  });
});

describe("ProjectList filters from a restored view", {
  timeout: UI_TEST_TIMEOUT_MS,
}, () => {
  it("shows the active filter chip and only the matching rows", async () => {
    await renderWithView({
      filters: { ...INITIAL_PROJECT_FILTERS, priorities: [Priority.High] },
    });
    expect(
      screen.getByText(`Priority: ${priorityLabel(Priority.High)}`)
    ).toBeInTheDocument();
    expect(screen.getByText("Apollo")).toBeInTheDocument();
    expect(screen.queryByText(BOREALIS.name)).toBeNull();
  });

  it("says the filters matched nothing rather than that the team has no projects", async () => {
    await renderWithView({
      filters: { ...INITIAL_PROJECT_FILTERS, assigneeIds: ["u-nobody"] },
    });
    expect(
      screen.getByText("No projects match these filters")
    ).toBeInTheDocument();
  });
});

describe("ProjectList column header menu", {
  timeout: UI_TEST_TIMEOUT_MS,
}, () => {
  function headerOrder(): string[] {
    return screen
      .getAllByRole("columnheader")
      .map((header) => header.textContent ?? "")
      .filter((text) => text.length > 0);
  }

  async function moveOwner(
    user: ReturnType<typeof userEvent.setup>,
    item: string
  ) {
    await user.click(
      screen.getByRole("button", { name: "Owner column options" })
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Move column" })
    );
    await user.click(await screen.findByRole("menuitem", { name: item }));
  }

  it("starts from the declared column order", () => {
    render(<ProjectList rows={ROWS} />);
    expect(headerOrder().slice(1)).toEqual([
      "Priority",
      "Owner",
      "Due Date",
      "Updated",
    ]);
  });

  it.each([
    ["Move left", ["Owner", "Priority", "Due Date", "Updated"]],
    ["Move right", ["Priority", "Due Date", "Owner", "Updated"]],
    ["Move to start", ["Owner", "Priority", "Due Date", "Updated"]],
    ["Move to end", ["Priority", "Due Date", "Updated", "Owner"]],
  ])("reorders the Owner column with %s", async (item, expected) => {
    render(<ProjectList rows={ROWS} />);
    await moveOwner(userEvent.setup(), item);
    expect(headerOrder().slice(1)).toEqual(expected);
  });

  it("opens the toolbar filter popover from a filterable column's Filter item", async () => {
    render(<ProjectList rows={ROWS} />);
    const user = userEvent.setup();
    const filtersButton = screen.getByRole("button", { name: "Filters" });
    expect(filtersButton).toHaveAttribute("aria-expanded", "false");
    await user.click(
      screen.getByRole("button", { name: "Owner column options" })
    );
    await user.click(await screen.findByRole("menuitem", { name: "Filter" }));
    expect(filtersButton).toHaveAttribute("aria-expanded", "true");
  });

  it("groups the list by the column the header menu names", async () => {
    render(
      <ProjectList
        rows={[...ROWS, makeProjectSummaryRow({ id: "3", name: "Cassini" })]}
      />
    );
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Owner column options" })
    );
    await user.click(await screen.findByRole("menuitem", { name: "Group" }));
    const bandLabels = screen
      .getAllByRole("button")
      .map((button) => button.textContent ?? "");
    expect(bandLabels).toEqual(
      expect.arrayContaining([
        `${ADA.name}1`,
        `${GRACE.name}1`,
        `${UNOWNED_GROUP_KEY}1`,
      ])
    );
  });
});
