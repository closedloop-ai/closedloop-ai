import { Priority } from "@repo/api/src/types/common";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { priorityLabel } from "@repo/design-system/lib/priority-order";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "../../../shared/test-fixtures/render-with-nav";
import { stubResponsiveNarrowViewport } from "../../../test/mocks/responsive-narrow-viewport";
import {
  ADA,
  GRACE,
  makeProjectSummaryRow,
} from "../../__tests__/project-summary-row-fixtures";
import { ProjectsTable } from "../projects-table";

const navigate = vi.fn();

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate }),
}));

const APOLLO = makeProjectSummaryRow({
  childTaskCount: 4,
  code: "PRO-1",
  completionPercentage: 50,
  dueDateLabel: "8/14/26",
  id: "1",
  name: "Apollo",
  owner: ADA,
  priority: Priority.High,
  updatedLabel: "4 days ago",
});
const BOREALIS = makeProjectSummaryRow({
  childTaskCount: 0,
  id: "2",
  name: "Borealis",
  owner: GRACE,
});
const ROWS = [APOLLO, BOREALIS];
const APOLLO_NAME = /Apollo/;
const GRID_TEMPLATE_SELECTOR = '[style*="grid-template-columns"]';

function dataRow(name: string): HTMLElement {
  const element = screen
    .getAllByRole("row")
    .find((candidate) => candidate.textContent?.includes(name));
  if (!element) {
    throw new Error(`no row ${name}`);
  }
  return element;
}

beforeEach(() => {
  navigate.mockReset();
});

describe("ProjectsTable read-only cells", () => {
  it("adopts the product pointer contract only when its rollout key is enabled", () => {
    const renderProductionCaller = (enabledFlags: string[]) =>
      render(
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({
            enabledFlags,
          })}
        >
          <ProjectsTable rows={ROWS} />
        </FeatureFlagAdapterProvider>
      );

    const disabled = renderProductionCaller([]);
    expect(
      disabled.container.querySelector(
        '[data-grid-interaction-contract="pointer-hover"]'
      )
    ).toBeNull();
    disabled.unmount();

    const enabled = renderProductionCaller([
      GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
    ]);
    expect(
      enabled.container.querySelector(
        '[data-grid-interaction-contract="pointer-hover"]'
      )
    ).not.toBeNull();
  });

  it("renders priority, owner, due date and updated values", () => {
    render(<ProjectsTable rows={ROWS} />);
    const apollo = dataRow("Apollo");
    expect(
      within(apollo).getByText(priorityLabel(Priority.High))
    ).toBeInTheDocument();
    expect(within(apollo).getByText(ADA.name)).toBeInTheDocument();
    expect(within(apollo).getByText("8/14/26")).toBeInTheDocument();
    expect(within(apollo).getByText("4 days ago")).toBeInTheDocument();
    expect(within(apollo).getByText("PRO-1")).toBeInTheDocument();

    const borealis = dataRow("Borealis");
    expect(within(borealis).getByText(priorityLabel(null))).toBeInTheDocument();
    expect(within(borealis).getByText("—")).toBeInTheDocument();
  });

  it("keeps Ctrl+A selection without a wide header checkbox", () => {
    const onSelectAllRows = vi.fn();
    render(
      <ProjectsTable
        rows={ROWS}
        selection={{
          onSelectAllRows,
        }}
      />
    );

    expect(screen.queryByRole("checkbox", { name: "Select all" })).toBeNull();
    const renderedCell = document.querySelector<HTMLElement>(
      '[data-grid-row-id="1"] [data-grid-cell]'
    );
    if (!renderedCell) {
      throw new Error("rendered Project cell not found");
    }
    fireEvent.keyDown(renderedCell, { ctrlKey: true, key: "a" });
    expect(onSelectAllRows).toHaveBeenCalledWith(ROWS);
  });

  it("names the completion ring by its value or its empty population", () => {
    render(<ProjectsTable rows={ROWS} />);
    expect(
      within(dataRow("Apollo")).getByRole("img", {
        name: "50% of child tasks are Done",
      })
    ).toBeInTheDocument();
    expect(
      within(dataRow("Borealis")).getByRole("img", {
        name: "No child tasks yet",
      })
    ).toBeInTheDocument();
  });

  it("draws each owner as one initial on the shared avatar colours", () => {
    render(<ProjectsTable rows={ROWS} />);
    // One initial on every avatar, on the shared avatar colours (Nerys,
    // 2026-10-22): ADA's stored "AL" draws "A"; GRACE's "GH" draws "G".
    // The letter sits in its own span; the colours are on the fallback.
    const ada = within(dataRow("Apollo"))
      .getByText("A")
      .closest('[data-slot="avatar-fallback"]');
    expect(ada).toHaveClass("bg-avatar-placeholder");
    expect(ada).not.toHaveClass("text-white");
    expect(ada?.getAttribute("style")).toBeNull();
    const plain = within(dataRow("Borealis"))
      .getByText("G")
      .closest('[data-slot="avatar-fallback"]');
    expect(plain).toHaveClass("bg-avatar-placeholder");
    expect(plain).not.toHaveClass("text-white");
    expect(plain?.getAttribute("style")).toBeNull();
  });

  it("renders the No owner placeholder for an unowned project", () => {
    render(
      <ProjectsTable
        rows={[makeProjectSummaryRow({ id: "9", name: "Drifter" })]}
      />
    );
    expect(
      within(dataRow("Drifter")).getByText("No owner")
    ).toBeInTheDocument();
  });
});

describe("ProjectsTable host hooks", () => {
  it("renders each supplied cell editor in place of the read-only value", () => {
    render(
      <ProjectsTable
        cellEditors={{
          dueDate: (project) => <span>{`due-editor-${project.id}`}</span>,
          owner: (project) => <span>{`owner-editor-${project.id}`}</span>,
          priority: (project) => <span>{`priority-editor-${project.id}`}</span>,
        }}
        rows={[APOLLO]}
      />
    );
    const apollo = dataRow("Apollo");
    expect(within(apollo).getByText("priority-editor-1")).toBeInTheDocument();
    expect(within(apollo).getByText("owner-editor-1")).toBeInTheDocument();
    expect(within(apollo).getByText("due-editor-1")).toBeInTheDocument();
    expect(within(apollo).queryByText(ADA.name)).toBeNull();
    expect(within(apollo).queryByText("8/14/26")).toBeNull();
  });

  it("adds a trailing actions column only when the host supplies row actions", () => {
    const { unmount } = render(
      <ProjectsTable
        rowActions={(project) => (
          <button type="button">{`actions-${project.id}`}</button>
        )}
        rows={ROWS}
      />
    );
    expect(
      within(dataRow("Borealis")).getByRole("button", { name: "actions-2" })
    ).toBeInTheDocument();
    expect(
      document.querySelector(GRID_TEMPLATE_SELECTOR)?.getAttribute("style")
    ).toContain("124px 164px 124px 124px 48px");
    unmount();

    render(<ProjectsTable rows={ROWS} />);
    expect(screen.queryByRole("button", { name: "actions-2" })).toBeNull();
    expect(
      document.querySelector(GRID_TEMPLATE_SELECTOR)?.getAttribute("style")
    ).toContain("minmax(420px, 1fr) 124px 164px 124px 124px;");
  });

  it("uses the host width for a column and the default for one it omits", () => {
    render(
      <ProjectsTable
        columnWidths={{ owner: 300 }}
        leadingColumnWidth={200}
        rows={ROWS}
      />
    );
    expect(
      document.querySelector(GRID_TEMPLATE_SELECTOR)?.getAttribute("style")
    ).toContain("minmax(200px, 1fr) 124px 300px 124px 124px;");
  });

  it("links the lead cell and navigates on a row click when the host gives hrefs", async () => {
    render(
      <ProjectsTable
        getRowHref={(project) => (project.id === "1" ? "/projects/1" : "")}
        rows={ROWS}
      />
    );
    expect(screen.getByRole("link", { name: APOLLO_NAME })).toHaveAttribute(
      "href",
      "/projects/1"
    );
    expect(within(dataRow("Borealis")).queryByRole("link")).toBeNull();

    const user = userEvent.setup();
    await user.click(within(dataRow("Apollo")).getByText("4 days ago"));
    expect(navigate).toHaveBeenCalledWith("/projects/1");

    navigate.mockClear();
    await user.click(within(dataRow("Borealis")).getByText("just now"));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("renders no links and ignores row clicks without hrefs", async () => {
    render(<ProjectsTable rows={ROWS} />);
    expect(screen.queryByRole("link")).toBeNull();
    await userEvent.click(within(dataRow("Apollo")).getByText("4 days ago"));
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("[DT-01][DT-02][DT-16] ProjectsTable narrow list", () => {
  let restoreContainerWidth: (() => void) | null = null;

  beforeEach(() => {
    restoreContainerWidth = stubResponsiveNarrowViewport(true).restore;
  });

  afterEach(() => {
    restoreContainerWidth?.();
    restoreContainerWidth = null;
  });

  it("keeps only the Name projection while preserving the production lead link", () => {
    const onSelectAllRows = vi.fn();
    render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
        })}
      >
        <ProjectsTable
          getRowHref={(project) => (project.id === "1" ? "/projects/1" : "")}
          rows={ROWS}
          selection={{
            onSelectAllRows,
          }}
        />
      </FeatureFlagAdapterProvider>
    );
    const apolloCard = screen.getByRole("link", { name: APOLLO_NAME });
    expect(apolloCard).toHaveAttribute("href", "/projects/1");
    expect(within(apolloCard).getByText("PRO-1")).toBeInTheDocument();
    expect(screen.getByRole("grid")).toHaveClass("min-w-0");
    expect(screen.getAllByRole("columnheader")).toHaveLength(1);
    expect(screen.getByRole("columnheader")).toHaveTextContent("Name");
    expect(screen.queryByRole("checkbox", { name: "Select all" })).toBeNull();
    const renderedCell = document.querySelector<HTMLElement>(
      '[data-grid-row-id="1"] [data-grid-cell]'
    );
    if (!renderedCell) {
      throw new Error("rendered Project cell not found");
    }
    fireEvent.keyDown(renderedCell, { ctrlKey: true, key: "a" });
    expect(onSelectAllRows).toHaveBeenCalledWith(ROWS);
    expect(screen.queryByText(ADA.name)).toBeNull();
    expect(screen.queryByText("8/14/26")).toBeNull();
    expect(document.querySelectorAll("dl")).toHaveLength(0);
  });

  it("keeps the captured-main Project cards at compact content width while the rollout flag is off", () => {
    const restoreWidth = stubContainerWidthPx(390);
    try {
      render(<ProjectsTable rows={ROWS} />);

      expect(screen.queryByRole("grid")).toBeNull();
      expect(document.querySelectorAll("[data-grid-card-id]")).toHaveLength(2);
      expect(screen.getByText(ADA.name)).toBeVisible();
    } finally {
      restoreWidth();
    }
  });
});
