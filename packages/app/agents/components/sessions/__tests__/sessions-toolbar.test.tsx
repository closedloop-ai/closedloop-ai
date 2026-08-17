import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { GRID_TABLE_V2_FLAG_KEY } from "@repo/api/src/types/grid-table-v2-flag";
import { SESSIONS_BRANCHES_COLUMN_ID } from "@repo/app/agents/lib/sessions-table-columns";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SESSIONS_CHANGE_PR_FILTERS_FEATURE_FLAG_KEY } from "../../../../shared/lib/feature-flags";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import {
  SESSIONS_TOGGLEABLE_COLUMNS,
  type SessionColumnId,
} from "../../../hooks/use-sessions-view-state";
import {
  DEFAULT_SESSION_FACET_FILTERS,
  hasAnyActiveSessionFacet,
  type SessionFacetFilters,
} from "../../../lib/session-filter-adapter";
import { AgentSessionsListContent } from "../agent-sessions-list";
import {
  createAgentSessionUsageSummaryFixture,
  mixedAgentSessionListFixtures,
} from "../session-list-fixtures";
import { SessionsToolbar } from "../sessions-toolbar";

const CURRENT_HARNESS_OPTION_NAME = /codex-harness-current/;
const CURRENT_MODEL_OPTION_NAME = /model-current/;
const CURRENT_REPOSITORY_OPTION_NAME = /symphony-alpha-current/;
const NEXT_REPOSITORY_OPTION_NAME = /symphony-alpha-next/;
const CURRENT_OWNER_OPTION_NAME = /Ada Current/;

describe("SessionsToolbar", () => {
  it("opens the filter menu and renders current facet options from usage", async () => {
    const user = userEvent.setup();
    const onFiltersChange = vi.fn();

    renderToolbar({ onFiltersChange });

    await user.click(screen.getByRole("button", { name: "Filter" }));

    for (const group of [
      "Status",
      "Owner",
      "Autonomy",
      "Harness",
      "Model",
      "Cost",
      "Changes",
      "Pull request",
      "Repository",
    ]) {
      expect(screen.getByRole("menuitem", { name: group })).toBeVisible();
    }

    await openFacet(user, "Harness");
    clickFacetOption(CURRENT_HARNESS_OPTION_NAME);
    expect(onFiltersChange).toHaveBeenCalledWith({
      ...DEFAULT_SESSION_FACET_FILTERS,
      harnesses: ["codex-harness-current"],
    });

    await openFacet(user, "Model");
    expect(
      screen.getByRole("menuitem", { name: CURRENT_MODEL_OPTION_NAME })
    ).toHaveTextContent("model-current");

    await openFacet(user, "Repository");
    expect(
      screen.getByRole("menuitem", { name: CURRENT_REPOSITORY_OPTION_NAME })
    ).toBeVisible();
  });

  it("renders the Owner facet from usage byUser and toggles userIds", async () => {
    const user = userEvent.setup();
    const onFiltersChange = vi.fn();

    renderToolbar({ onFiltersChange });

    await user.click(screen.getByRole("button", { name: "Filter" }));
    await openFacet(user, "Owner");
    clickFacetOption(CURRENT_OWNER_OPTION_NAME);

    expect(onFiltersChange).toHaveBeenCalledWith({
      ...DEFAULT_SESSION_FACET_FILTERS,
      userIds: ["user-current"],
    });
  });

  it("does not keep stale dynamic options when usage changes or empties", async () => {
    const user = userEvent.setup();
    const { rerender } = renderToolbar();

    await user.click(screen.getByRole("button", { name: "Filter" }));
    await openFacet(user, "Repository");
    expect(
      screen.getByRole("menuitem", { name: CURRENT_REPOSITORY_OPTION_NAME })
    ).toBeVisible();

    await user.keyboard("{Escape}");

    rerender(renderToolbarElement({ usageVariant: "next" }));
    await user.click(screen.getByRole("button", { name: "Filter" }));
    await openFacet(user, "Repository");

    expect(
      screen.queryByRole("menuitem", { name: CURRENT_REPOSITORY_OPTION_NAME })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: NEXT_REPOSITORY_OPTION_NAME })
    ).toBeVisible();

    await user.keyboard("{Escape}");

    rerender(renderToolbarElement({ usageVariant: "empty" }));
    await user.click(screen.getByRole("button", { name: "Filter" }));
    await openFacet(user, "Harness");

    expect(screen.getByPlaceholderText("Filter...")).toBeVisible();
    expect(within(getOpenFacetMenu()).queryAllByRole("menuitem")).toHaveLength(
      0
    );
    expect(
      screen.queryByRole("menuitem", { name: "codex-harness-current" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "codex-harness-next" })
    ).not.toBeInTheDocument();
  });

  it("opens the View menu and reflects current column visibility", async () => {
    const user = userEvent.setup();
    const onToggleColumn = vi.fn();
    const { rerender } = renderToolbar({
      onToggleColumn,
      visibleColumns: new Set(
        SESSIONS_TOGGLEABLE_COLUMNS.map((column) => column.id).filter(
          (id) => id !== SESSIONS_BRANCHES_COLUMN_ID
        )
      ),
    });

    await user.click(screen.getByRole("button", { name: "View" }));

    expect(screen.getByText("Show / Hide Columns")).toBeVisible();
    expect(screen.getByRole("switch", { name: "Status" })).toBeChecked();
    expect(
      screen.getByRole("switch", { name: "Linked branches" })
    ).not.toBeChecked();

    await user.click(screen.getByRole("switch", { name: "Linked branches" }));
    expect(onToggleColumn).toHaveBeenCalledWith(SESSIONS_BRANCHES_COLUMN_ID);

    rerender(
      renderToolbarElement({
        visibleColumns: new Set(
          SESSIONS_TOGGLEABLE_COLUMNS.map((column) => column.id)
        ),
        onToggleColumn,
      })
    );

    expect(
      screen.getByRole("switch", { name: "Linked branches" })
    ).toBeChecked();
  });

  it("renders the shared filtered-empty list body for harness-filtered items", async () => {
    render(
      <SessionsToolbarHarness
        initialFilters={{
          ...DEFAULT_SESSION_FACET_FILTERS,
          statuses: ["abandoned"],
        }}
      />
    );

    expect(await screen.findByText("No matching sessions")).toBeInTheDocument();
    expect(
      screen.getByText(
        "No sessions match the current filters. Try clearing or widening a filter."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText("Named Session")).not.toBeInTheDocument();
  });

  it("FEA-4194: does not render the removed Substantive | Idle | All quality segment", () => {
    renderToolbar();

    // The unapproved quality-segment control rendered its options as
    // role="radio" pills inside a group labeled "Filter sessions by quality".
    // After the FEA-4194 revert the toolbar must render neither.
    expect(
      screen.queryByRole("group", { name: "Filter sessions by quality" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: "Substantive" })
    ).not.toBeInTheDocument();
  });

  // ISS-5355: the Project facet is opt-in per surface, so both directions matter
  // — offering it where projects resolve, and NOT offering it where they cannot.
  it("offers the Project facet with counts when the surface opts in", async () => {
    const user = userEvent.setup();

    render(
      <AppCoreStoryProviders>
        <SessionsToolbar
          dateRange="7d"
          filters={DEFAULT_SESSION_FACET_FILTERS}
          includeProjectFilter={true}
          onDateRangeChange={vi.fn()}
          onFiltersChange={vi.fn()}
          onToggleColumn={vi.fn()}
          usage={usageWithProjects()}
          visibleColumns={
            new Set(SESSIONS_TOGGLEABLE_COLUMNS.map((column) => column.id))
          }
        />
      </AppCoreStoryProviders>
    );

    await user.click(screen.getByRole("button", { name: "Filter" }));

    expect(screen.getByRole("menuitem", { name: "Project" })).toBeVisible();

    await openFacet(user, "Project");
    // The option carries the project's NAME and its session count, so the facet
    // reads as a project list rather than a list of opaque ids.
    expect(
      screen.getByRole("menuitem", { name: PROJECT_OPTION_NAME })
    ).toHaveTextContent("9");
  });

  it("selecting a project threads it through the canonical projectIds filter", async () => {
    const user = userEvent.setup();
    const onFiltersChange = vi.fn();

    render(
      <AppCoreStoryProviders>
        <SessionsToolbar
          dateRange="7d"
          filters={DEFAULT_SESSION_FACET_FILTERS}
          includeProjectFilter={true}
          onDateRangeChange={vi.fn()}
          onFiltersChange={onFiltersChange}
          onToggleColumn={vi.fn()}
          usage={usageWithProjects()}
          visibleColumns={
            new Set(SESSIONS_TOGGLEABLE_COLUMNS.map((column) => column.id))
          }
        />
      </AppCoreStoryProviders>
    );

    await user.click(screen.getByRole("button", { name: "Filter" }));
    await openFacet(user, "Project");
    clickFacetOption(PROJECT_OPTION_NAME);

    expect(onFiltersChange).toHaveBeenCalledWith({
      ...DEFAULT_SESSION_FACET_FILTERS,
      projectIds: [PROJECT_ID],
    });
  });

  it("omits the Project facet entirely on a surface that cannot resolve projects", async () => {
    // The desktop local producer has no cloud project to resolve. Offering an
    // always-empty facet there would name a dimension it cannot filter on.
    const user = userEvent.setup();

    render(
      <AppCoreStoryProviders>
        <SessionsToolbar
          dateRange="7d"
          filters={DEFAULT_SESSION_FACET_FILTERS}
          onDateRangeChange={vi.fn()}
          onFiltersChange={vi.fn()}
          onToggleColumn={vi.fn()}
          usage={usageWithProjects()}
          visibleColumns={
            new Set(SESSIONS_TOGGLEABLE_COLUMNS.map((column) => column.id))
          }
        />
      </AppCoreStoryProviders>
    );

    await user.click(screen.getByRole("button", { name: "Filter" }));

    // Repository proves the popover opened, so the Project absence below is a
    // real omission and not an unopened menu.
    expect(screen.getByRole("menuitem", { name: "Repository" })).toBeVisible();
    expect(
      screen.queryByRole("menuitem", { name: "Project" })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(PROJECT_NAME)).not.toBeInTheDocument();
  });
});

const PROJECT_ID = "019f8008-1969-74f9-b056-99c13cca9a07";
const PROJECT_NAME = "Symphony Alpha";
const PROJECT_OPTION_NAME = /Symphony Alpha/;

function usageWithProjects() {
  return createAgentSessionUsageSummaryFixture(AgentSessionViewerScope.Self, {
    byProject: [
      { projectId: PROJECT_ID, projectName: PROJECT_NAME, sessionCount: 9 },
    ],
  });
}

/**
 * ISS-5770 review: the View menu's linked-entity entries, driven through the
 * EXACT prop shape the web Sessions route passes
 * (`includeLinkedEntityColumns` bare ⇒ `true`) crossed with the shared
 * `grid-table-v2` gate.
 *
 * This path had no unit coverage at all, which is why "does the web host still
 * get these switches" was only answerable by a 26-minute e2e leg. Both halves
 * are asserted because the menu now takes them SEPARATELY — the flag is a
 * property of the build, the seam a property of the mount — and collapsing them
 * into one boolean is what let the menu re-decide gatedness from a hardcoded
 * column pair.
 */
describe("SessionsToolbar linked-entity View-menu entries (ISS-5770)", () => {
  const LINKED_ENTITY_LABELS = ["Owning project", "Linked issues"];

  async function openViewMenu(enabledFlags: string[], includeSeam: boolean) {
    const user = userEvent.setup();
    render(
      <AppCoreStoryProviders enabledFlags={enabledFlags}>
        <SessionsToolbar
          dateRange="7d"
          filters={DEFAULT_SESSION_FACET_FILTERS}
          {...(includeSeam ? { includeLinkedEntityColumns: true } : {})}
          onDateRangeChange={vi.fn()}
          onFiltersChange={vi.fn()}
          onToggleColumn={vi.fn()}
          usage={createUsage("current")}
          visibleColumns={
            new Set(SESSIONS_TOGGLEABLE_COLUMNS.map((column) => column.id))
          }
        />
      </AppCoreStoryProviders>
    );
    await user.click(screen.getByRole("button", { name: "View" }));
  }

  it("offers them for the web host's props when the gate is ON", async () => {
    await openViewMenu([GRID_TABLE_V2_FLAG_KEY], true);
    for (const label of LINKED_ENTITY_LABELS) {
      expect(screen.getByRole("switch", { name: label })).toBeVisible();
    }
  });

  it("offers no dead switch when the gate is OFF but the seam is wired", async () => {
    await openViewMenu([], true);
    // Positive first, so the absences below cannot pass on a menu that never
    // opened — the same anti-vacuity rule the e2e twins follow.
    expect(screen.getByRole("switch", { name: "Repository" })).toBeVisible();
    for (const label of LINKED_ENTITY_LABELS) {
      expect(screen.queryByRole("switch", { name: label })).toBeNull();
    }
  });

  it("offers no dead switch when the gate is ON but the surface wired no seam", async () => {
    await openViewMenu([GRID_TABLE_V2_FLAG_KEY], false);
    expect(screen.getByRole("switch", { name: "Repository" })).toBeVisible();
    for (const label of LINKED_ENTITY_LABELS) {
      expect(screen.queryByRole("switch", { name: label })).toBeNull();
    }
  });
});

function renderToolbar(props: RenderToolbarOptions = {}) {
  return render(renderToolbarElement(props));
}

function renderToolbarElement({
  filters = DEFAULT_SESSION_FACET_FILTERS,
  onFiltersChange = vi.fn(),
  visibleColumns = new Set(
    SESSIONS_TOGGLEABLE_COLUMNS.map((column) => column.id)
  ),
  onToggleColumn = vi.fn(),
  usageVariant = "current",
}: RenderToolbarOptions = {}) {
  return (
    <AppCoreStoryProviders
      enabledFlags={[SESSIONS_CHANGE_PR_FILTERS_FEATURE_FLAG_KEY]}
    >
      <SessionsToolbar
        dateRange="7d"
        filters={filters}
        onDateRangeChange={vi.fn()}
        onFiltersChange={onFiltersChange}
        onToggleColumn={onToggleColumn}
        usage={createUsage(usageVariant)}
        visibleColumns={visibleColumns}
      />
    </AppCoreStoryProviders>
  );
}

function SessionsToolbarHarness({
  initialFilters = DEFAULT_SESSION_FACET_FILTERS,
}: {
  initialFilters?: SessionFacetFilters;
}) {
  const [filters, setFilters] = useSessionFacetFilters(initialFilters);
  const visibleColumns = new Set(
    SESSIONS_TOGGLEABLE_COLUMNS.map((column) => column.id)
  );
  const filteredItems = filters.statuses.includes("abandoned")
    ? []
    : mixedAgentSessionListFixtures;

  return (
    <AppCoreStoryProviders>
      <SessionsToolbar
        dateRange="7d"
        filters={filters}
        onDateRangeChange={vi.fn()}
        onFiltersChange={setFilters}
        onToggleColumn={vi.fn()}
        usage={createUsage("current")}
        visibleColumns={visibleColumns}
      />
      <AgentSessionsListContent
        emptySignals={{
          isUnavailable: false,
          hasActiveFilters: hasAnyActiveSessionFacet(filters),
        }}
        getSessionHref={(item) => `/sessions/${item.id}`}
        isLoading={false}
        items={filteredItems}
      />
    </AppCoreStoryProviders>
  );
}

async function openFacet(
  user: ReturnType<typeof userEvent.setup>,
  label: string
) {
  const trigger = screen.getByRole("menuitem", { name: label });
  await user.hover(trigger);
  await waitFor(() => {
    expect(screen.getByPlaceholderText("Filter...")).toBeVisible();
  });
}

function clickFacetOption(label: TextMatch) {
  const option = screen.getByRole("menuitem", { name: label });
  fireEvent.click(option);
}

function getOpenFacetMenu(): HTMLElement {
  const menu = screen
    .getByPlaceholderText("Filter...")
    .closest('[role="menu"]');
  if (!(menu instanceof HTMLElement)) {
    throw new Error("Could not find the open facet menu");
  }
  return menu;
}

function createUsage(variant: UsageVariant) {
  if (variant === "empty") {
    return createAgentSessionUsageSummaryFixture(AgentSessionViewerScope.Self);
  }

  const suffix = variant === "current" ? "current" : "next";

  return createAgentSessionUsageSummaryFixture(AgentSessionViewerScope.Self, {
    byHarness: [
      {
        harness: `codex-harness-${suffix}`,
        sessionCount: 5,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 0,
      },
    ],
    byModel: [
      {
        model: `model-${suffix}`,
        sessionCount: 4,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 0,
      },
    ],
    // FEA-4303: the Model facet options come from modelFilterOptions (primary
    // model), not byModel (which spans secondary/subagent models).
    modelFilterOptions: [
      {
        model: `model-${suffix}`,
        sessionCount: 4,
      },
    ],
    byRepository: [
      {
        repositoryFullName: `closedloop-ai/symphony-alpha-${suffix}`,
        sessionCount: 7,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCost: 0,
        errorCount: 0,
      },
    ],
    byUser: [
      {
        userId: `user-${suffix}`,
        userName: suffix === "current" ? "Ada Current" : "Bob Next",
        userEmail: `${suffix}@closedloop.ai`,
        userAvatarUrl: null,
        sessionCount: 3,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 0,
      },
    ],
  });
}

function useSessionFacetFilters(initialFilters: SessionFacetFilters) {
  return useState<SessionFacetFilters>(initialFilters);
}

type RenderToolbarOptions = {
  filters?: SessionFacetFilters;
  onFiltersChange?: (next: SessionFacetFilters) => void;
  visibleColumns?: Set<string>;
  onToggleColumn?: (id: SessionColumnId) => void;
  usageVariant?: UsageVariant;
};

type UsageVariant = "current" | "next" | "empty";

type TextMatch = string | RegExp;
