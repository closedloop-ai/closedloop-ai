import { Priority } from "@repo/api/src/types/common";
import { TableBulkActionUndo } from "@repo/design-system/components/ui/table-bulk-actions";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ProjectSummaryRow } from "../../lib/project-summary-row";
import { ProjectList } from "../project-list";

const SORT_BUTTON = /sort/i;

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

function row(
  overrides: Partial<ProjectSummaryRow> & Pick<ProjectSummaryRow, "id" | "name">
): ProjectSummaryRow {
  return {
    childTaskCount: null,
    code: null,
    completionPercentage: null,
    dueDateLabel: null,
    dueDateMs: null,
    owner: null,
    priority: null,
    updatedAtMs: 0,
    updatedLabel: "just now",
    ...overrides,
  };
}

const ROWS: ProjectSummaryRow[] = [
  row({ id: "1", name: "Apollo", priority: Priority.High }),
  row({ id: "2", name: "Borealis", priority: Priority.Low }),
];

describe("ProjectList empty state reaches every layout", () => {
  it("offers the host's Create action on the BOARD, not a blank grid", async () => {
    render(
      <ProjectList
        emptyStateAction={<button type="button">Create Project</button>}
        rows={[]}
      />
    );
    // The toolbar renders a desktop and a mobile copy; either reaches the
    // same layout state, so drive the first.
    await userEvent.click(
      screen.getAllByRole("radio", { name: "Board view" })[0]
    );
    expect(screen.getByText("No projects yet")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create Project" })
    ).toBeInTheDocument();
  });

  it("offers the host's Create action on the list too", () => {
    render(
      <ProjectList
        emptyStateAction={<button type="button">Create Project</button>}
        rows={[]}
      />
    );
    expect(screen.getByText("No projects yet")).toBeInTheDocument();
  });
});

describe("ProjectList header sort state", () => {
  function projectHeader() {
    return screen
      .getAllByRole("columnheader")
      .find((header) => header.textContent?.includes("Project"));
  }

  it("starts with no column claiming a sort", () => {
    render(<ProjectList rows={ROWS} />);
    expect(projectHeader()).not.toHaveAttribute("aria-sort", "ascending");
  });

  it("stops claiming Project is ascending after Clear sort", async () => {
    render(<ProjectList rows={ROWS} />);
    const user = userEvent.setup();
    const openSortMenu = async () => {
      await user.click(screen.getAllByRole("button", { name: SORT_BUTTON })[0]);
    };
    await openSortMenu();
    await user.click(await screen.findByRole("menuitem", { name: "Project" }));
    expect(projectHeader()).toHaveAttribute("aria-sort", "ascending");

    await user.click(screen.getAllByRole("button", { name: "Clear sort" })[0]);
    expect(projectHeader()).not.toHaveAttribute("aria-sort", "ascending");
  });
});

describe("ProjectList complete result set", () => {
  it("keeps projects beyond a typical page boundary reachable in list and board", async () => {
    const rows = Array.from({ length: 61 }, (_, index) =>
      row({ id: `project-${index}`, name: `Project ${index + 1}` })
    );
    render(<ProjectList rows={rows} />);
    expect(screen.getByText("Project 61")).toBeInTheDocument();
    await userEvent.click(
      screen.getAllByRole("radio", { name: "Board view" })[0]
    );
    expect(screen.getByText("Project 61")).toBeInTheDocument();
  });
});

describe("ProjectList shared bulk action host", () => {
  it("keeps the registry action band across list and board layouts", async () => {
    render(
      <ProjectList
        bulkSelection={{
          actions: [
            {
              icon: null,
              id: "favorite",
              kind: "command",
              label: "Favorite",
              onSelect: vi.fn(),
              undo: TableBulkActionUndo.NotImplemented,
            },
          ],
          enabled: true,
          onChange: vi.fn(),
          selectedIds: new Set(ROWS.map((project) => project.id)),
        }}
        rows={ROWS}
      />
    );

    expect(screen.getByRole("button", { name: "Favorite" })).toBeVisible();
    await userEvent.click(
      screen.getAllByRole("radio", { name: "Board view" })[0]
    );
    expect(screen.getByRole("button", { name: "Favorite" })).toBeVisible();
  });
});

const SELECT_ALL_NAME = /select all/i;

describe("ProjectList header select-all (ISS-13007)", () => {
  it("renders no header select-all checkbox while row selection and the rail keep working", () => {
    render(
      <ProjectList
        bulkSelection={{
          actions: [],
          enabled: true,
          onChange: vi.fn(),
          selectedIds: new Set(["1"]),
        }}
        rows={ROWS}
      />
    );
    expect(screen.getByText("Apollo")).toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: SELECT_ALL_NAME })
    ).toBeNull();
  });
});
