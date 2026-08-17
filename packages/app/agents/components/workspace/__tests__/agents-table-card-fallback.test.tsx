import {
  type AgentComponent,
  AgentComponentKind,
  AgentMetricMode,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { AGENT_COMPONENT_AUTHORS_LABEL } from "@repo/app/agents/lib/agent-component-authors";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { AgentsTable } from "../agents-table";

// FEA-3866: the GridTable card fallback on the Agents table. `mode` is forwarded
// to GridTable; `compact` forces the card list and `expanded` forces the grid,
// so the layout is deterministic in jsdom without a real container-width
// measurement. `auto` (the default) measures the container and picks a layout at
// runtime — covered by the 360px Playwright spec, not here.

// The sd3 Tooltip renders in a portal that never mounts in jsdom; mock it so the
// name-lead trigger stays inline for assertion, matching the sibling suite.
vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

function makeComponent(overrides: Partial<AgentComponent>): AgentComponent {
  return {
    id: overrides.id ?? "uuid-default",
    slug: overrides.slug ?? overrides.id ?? "mcp::uuid-default",
    name: overrides.name ?? "acme/refactor-agent",
    kind: overrides.kind ?? AgentComponentKind.Subagent,
    sourceType: SourceType.Repo,
    source: "repo-a",
    harness: Harness.Claude,
    invocations: 128,
    sessions: 12,
    locPerDollar: 2.5,
    trend: [],
    collaborators: ["alice"],
    computeTargetIds: [],
    firstSeenAt: "2020-01-01T00:00:00.000Z",
    lastSeenAt: "2020-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderTable(
  items: AgentComponent[],
  mode: "compact" | "expanded",
  alwaysShowActions?: boolean
): void {
  render(
    <AgentsTable
      alwaysShowActions={alwaysShowActions}
      items={items}
      metricMode={AgentMetricMode.LocPerDollar}
      mode={mode}
      onSort={() => {
        // sorting is not under test here
      }}
      sortBy="metric"
      sortDir="desc"
    />,
    { wrapper: AppCoreStoryProviders }
  );
}

describe("AgentsTable card fallback (FEA-3866)", () => {
  it("renders a card per row with the name + type in the header and the columns as a key/value body in compact mode", () => {
    renderTable(
      [
        makeComponent({
          kind: AgentComponentKind.Mcp,
          name: "acme/refactor-agent",
        }),
      ],
      "compact"
    );

    // The card header carries the component name lead (the no-href path renders
    // the name as the tooltip's native <button> trigger; the mocked tooltip also
    // mirrors it into always-present content, so match the interactive trigger).
    expect(
      screen.getByRole("button", { name: "acme/refactor-agent" })
    ).toBeInTheDocument();

    const typeLabel = screen.getByText("MCP tool");
    const typeWrapper = typeLabel.parentElement;
    expect(typeWrapper).toHaveClass(
      "gap-1.5",
      "font-medium",
      "text-muted-foreground",
      "text-xs"
    );
    expect(typeWrapper?.querySelector("svg")).toHaveClass(
      "size-3.5",
      "shrink-0"
    );

    // The body is a definition list: each remaining visible column is a `<dt>`
    // label + `<dd>` value. Type + metric lead the header, so they are not
    // repeated as body labels. The `<dt>`/`<dd>` pairing is what a screen reader
    // announces.
    const authorsLabel = screen.getByText(AGENT_COMPONENT_AUTHORS_LABEL);
    expect(authorsLabel.tagName).toBe("DT");
    const invocationsLabel = screen.getByText("Invocations");
    expect(invocationsLabel.tagName).toBe("DT");
    const invocationsValue = invocationsLabel.nextElementSibling as HTMLElement;
    expect(invocationsValue.tagName).toBe("DD");
    expect(within(invocationsValue).getByText("128")).toBeInTheDocument();

    // The row-actions affordance is reachable in the card header. FEA-3220
    // replaced the placeholder button with the real AgentRowActionsMenu kebab
    // trigger, which is labelled "Component actions".
    expect(
      screen.getByRole("button", { name: "Component actions" })
    ).toBeInTheDocument();
  });

  it("renders the grid, not cards, in expanded mode (desktop regression guard)", () => {
    renderTable([makeComponent({})], "expanded");

    // The grid renders its column header labels; the card body definition list
    // does not exist. FEA-4098 (Slice 3): Owner header is gone; the Authors
    // column header is the people column. FEA-4266: renamed Collaborators →
    // Authors.
    expect(screen.getByText(AGENT_COMPONENT_AUTHORS_LABEL)).toBeInTheDocument();
    expect(
      screen.queryByRole("term", { name: "Invocations" })
    ).not.toBeInTheDocument();
  });
});

describe("AgentsTable alwaysShowActions (FEA-3872)", () => {
  // The RN-parity seam: the grid's row-actions cell hover-reveals by default
  // (opacity-0 + touch:/group-hover: overrides). With `alwaysShowActions`, the
  // reveal classes are dropped so the affordance is always painted — this is
  // what a hover-less surface (React Native) needs. Assert on the rendered
  // class state on the action button's wrapper.
  function actionsWrapper(): HTMLElement {
    const button = screen.getByRole("button", { name: "Component actions" });
    // The wrapper is the button's parent <div> carrying the visibility classes.
    return button.parentElement as HTMLElement;
  }

  it("hover-reveals the grid row-actions by default (opacity-0 base)", () => {
    renderTable([makeComponent({})], "expanded");
    expect(actionsWrapper().className).toContain("opacity-0");
  });

  it("always paints the grid row-actions when alwaysShowActions is set (no opacity-0 base)", () => {
    renderTable([makeComponent({})], "expanded", true);
    expect(actionsWrapper().className).not.toContain("opacity-0");
  });
});
