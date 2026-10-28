/**
 * The menu's group-by labels are deliberately not its values: "Authors" carries
 * the `collaborators` enum member and wire value, and the same split repeats on
 * the `collaborators` column id, which is a persisted `hiddenColumns` key.
 *
 * The menu is bound to the real `useAgentComponentsViewState` and rendered
 * beside the real `AgentsTable`, so assertions read the resulting view rather
 * than a spy.
 */

import { AgentComponentGroupBy } from "@repo/api/src/types/agent-component";
import { AGENT_COMPONENT_AUTHORS_LABEL } from "@repo/app/agents/lib/agent-component-authors";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_COMPONENT_TOGGLEABLE_COLUMNS,
  useAgentComponentsViewState,
} from "../../../hooks/use-agent-components-view-state";
import { makeComponent } from "../agent-component-fixtures";
import { AgentsTable } from "../agents-table";
import { AgentsViewMenu } from "../agents-view-menu";

describe("AgentsViewMenu — group by", () => {
  it("keeps the Authors label distinct from the collaborators value", () => {
    // Made equal, selecting by label and by value become indistinguishable and
    // the case below stops being able to catch the rename.
    expect(AGENT_COMPONENT_AUTHORS_LABEL).not.toBe(
      AgentComponentGroupBy.Collaborators
    );
  });

  it("applies each option's enum value, not its label", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    // Sequential so every step transitions off a different prior value;
    // selecting the dimension already applied would assert nothing.
    expect(screen.getByTestId(GROUP_BY_TEST_ID)).toHaveTextContent(
      AgentComponentGroupBy.None
    );
    await openMenu(user);

    for (const [label, value] of GROUP_BY_CASES) {
      await user.click(await screen.findByRole("radio", { name: label }));
      expect(screen.getByTestId(GROUP_BY_TEST_ID)).toHaveTextContent(value);
    }
  });
});

describe("AgentsViewMenu — column visibility", () => {
  it("derives each column's switch from the visible set, both on and off", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await openMenu(user);

    for (const column of AGENT_COMPONENT_TOGGLEABLE_COLUMNS) {
      expect(
        await screen.findByRole("switch", { name: column.label })
      ).toBeChecked();
    }

    // A hardcoded `visible: true` satisfies the loop above but not this.
    await user.click(
      screen.getByRole("switch", { name: HARNESS_COLUMN_LABEL })
    );

    expect(
      screen.getByRole("switch", { name: HARNESS_COLUMN_LABEL })
    ).not.toBeChecked();
    expect(
      screen.getByRole("switch", { name: TYPE_COLUMN_LABEL })
    ).toBeChecked();
  });

  it("removes the toggled column from the grid, and Reset brings it back", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    expect(grid().getByText(HARNESS_COLUMN_LABEL)).toBeInTheDocument();

    await openMenu(user);
    await user.click(
      await screen.findByRole("switch", { name: HARNESS_COLUMN_LABEL })
    );

    expect(grid().queryByText(HARNESS_COLUMN_LABEL)).not.toBeInTheDocument();
    // Paired with a column that must survive, so a table that failed to render
    // cannot satisfy the absence.
    expect(grid().getByText(TYPE_COLUMN_LABEL)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: RESET_VIEW_NAME }));

    expect(grid().getByText(HARNESS_COLUMN_LABEL)).toBeInTheDocument();
  });
});

const VIEW_MENU_TRIGGER_NAME = /^view$/i;
const RESET_VIEW_NAME = /reset view/i;
const HARNESS_COLUMN_LABEL = "Harness";
const TYPE_COLUMN_LABEL = "Type";
const GRID_TEST_ID = "agents-grid";
const GROUP_BY_TEST_ID = "applied-group-by";

function WiredWorkspace() {
  const {
    groupBy,
    metricMode,
    setGroupBy,
    sortDir,
    sortKey,
    toggleColumn,
    visibleColumns,
    resetColumns,
  } = useAgentComponentsViewState();

  return (
    <>
      <span data-testid={GROUP_BY_TEST_ID}>{groupBy}</span>
      <AgentsViewMenu
        groupBy={groupBy}
        onGroupByChange={setGroupBy}
        onReset={resetColumns}
        onToggleColumn={toggleColumn}
        visibleColumns={visibleColumns}
      />
      <div data-testid={GRID_TEST_ID}>
        <AgentsTable
          items={[
            makeComponent({ id: "a", name: "Component a" }),
            makeComponent({ id: "b", name: "Component b" }),
          ]}
          metricMode={metricMode}
          mode="expanded"
          onSort={vi.fn()}
          sortBy={sortKey}
          sortDir={sortDir}
          visibleColumns={new Set(visibleColumns)}
        />
      </div>
    </>
  );
}

function renderWorkspace() {
  return render(
    <AppCoreStoryProviders enabledFlags={[]}>
      <WiredWorkspace />
    </AppCoreStoryProviders>
  );
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("button", { name: VIEW_MENU_TRIGGER_NAME })
  );
}

function grid() {
  return within(screen.getByTestId(GRID_TEST_ID));
}

/** Each dimension paired with the value the grouper must actually receive. */
const GROUP_BY_CASES = [
  ["Type", AgentComponentGroupBy.Type],
  [AGENT_COMPONENT_AUTHORS_LABEL, AgentComponentGroupBy.Collaborators],
  ["Harness", AgentComponentGroupBy.Harness],
  ["None", AgentComponentGroupBy.None],
] as const;
