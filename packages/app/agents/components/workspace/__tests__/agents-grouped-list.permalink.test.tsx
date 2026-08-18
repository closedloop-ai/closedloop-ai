import {
  type AgentComponent,
  AgentComponentKind,
  type AgentComponentListResponse,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ApiAdapterProvider } from "../../../../shared/api/provider";
import { AuthAdapterProvider } from "../../../../shared/auth/provider";
import { createStaticAuthAdapter } from "../../../../shared/auth/static-auth-adapter";
import { FeatureFlagAdapterProvider } from "../../../../shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../../../../shared/feature-flags/static-feature-flag-adapter";
import type { AgentComponentsDataSource } from "../../../data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "../../../data-source/provider";
import { AgentsGroupedList } from "../agents-grouped-list";

/**
 * FEA-3557: permalink adoption for the Agents workspace type-tab.
 *
 * The active type tab now lives in the `?kind=` URL param via `useTabParam`
 * (through the `packages/navigation` port, so it works on web AND desktop), not
 * in local filter state. These tests cover the three permalink invariants on
 * the priority screen:
 *   1. URL round-trip — clicking a tab writes `?kind=<kind>` and deep-links back.
 *   2. Default cleanup — selecting "All" removes the param (clean canonical URL).
 *   3. Invalid/hidden fallback — an unknown/flag-gated `?kind=` falls back to All.
 *
 * A local provider stack is used (instead of `AppCoreStoryProviders`) so the
 * test can seed an initial `?kind=` path and read the resulting href back.
 */

// Top-level regex constants (biome lint/performance/useTopLevelRegex). Exact
// matches against the ToggleGroup type-tab aria-labels.
const RE_ALL_TAB = /^All$/;
const RE_COMMANDS_TAB = /^Commands$/;
const RE_TOOLS_TAB = /^Tools$/;

function makeComponent(overrides: Partial<AgentComponent>): AgentComponent {
  return {
    id: overrides.id ?? "uuid-default",
    slug: overrides.slug ?? overrides.id ?? "subagent::uuid-default",
    name: overrides.name ?? "Default Component",
    kind: overrides.kind ?? AgentComponentKind.Subagent,
    sourceType: SourceType.Repo,
    source: "repo-a",
    harness: Harness.Claude,
    invocations: 10,
    sessions: 3,
    locPerDollar: 2.5,
    trend: [],
    collaborators: [],
    computeTargetIds: [],
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

const FIXTURE: AgentComponent[] = [
  makeComponent({
    id: "uuid-sub-1",
    name: "My Orchestrator Agent",
    kind: AgentComponentKind.Subagent,
  }),
  makeComponent({
    id: "uuid-cmd-1",
    name: "Code Review Command",
    kind: AgentComponentKind.Command,
  }),
  makeComponent({
    id: "uuid-tool-1",
    name: "Bash Tool",
    kind: AgentComponentKind.Tool,
  }),
  makeComponent({
    id: "uuid-orch-1",
    name: "ToolSearch Orchestration",
    kind: AgentComponentKind.Orchestration,
  }),
];

function testDataSource(items: AgentComponent[]): AgentComponentsDataSource {
  return {
    scope: "test",
    list: () =>
      Promise.resolve({
        items,
        total: items.length,
      } satisfies AgentComponentListResponse),
    detail: () => Promise.reject(new Error("detail unused")),
  };
}

function queryOf(href: string): URLSearchParams {
  const q = href.indexOf("?");
  return new URLSearchParams(q === -1 ? "" : href.slice(q + 1));
}

function renderWorkspace(options: {
  initialPath: string;
  enabledFlags?: readonly string[];
  items?: AgentComponent[];
}) {
  const nav = createMemoryNavigation({
    initialPath: options.initialPath,
    orgSlug: "org-test",
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const flags = createStaticFeatureFlagAdapter({
    enabledFlags: options.enabledFlags,
  });
  const apiAdapter = {
    resolveApiOrigin: () => "http://test.invalid",
    fetch: () => Promise.reject(new Error("no network in permalink tests")),
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <NavigationProvider adapter={nav.adapter}>
        <AuthAdapterProvider adapter={createStaticAuthAdapter()}>
          <FeatureFlagAdapterProvider adapter={flags}>
            <ApiAdapterProvider adapter={apiAdapter}>
              <AgentComponentsDataSourceProvider
                dataSource={testDataSource(options.items ?? FIXTURE)}
              >
                {children}
              </AgentComponentsDataSourceProvider>
            </ApiAdapterProvider>
          </FeatureFlagAdapterProvider>
        </AuthAdapterProvider>
      </NavigationProvider>
    </QueryClientProvider>
  );
  const view = render(<AgentsGroupedList />, { wrapper });
  return { nav, ...view };
}

describe("AgentsGroupedList type-tab permalink (FEA-3557)", () => {
  it("deep-links straight to the Commands tab from ?kind=command", async () => {
    renderWorkspace({ initialPath: "/agents?kind=command" });

    // Only command-kind rows are visible; other kinds are filtered out.
    await screen.findByText("Code Review Command");
    await waitFor(() => {
      expect(
        screen.queryByText("My Orchestrator Agent")
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByRole("radio", { name: RE_COMMANDS_TAB })
    ).toHaveAttribute("data-state", "on");
  });

  it("clicking a tab writes the ?kind= param (URL round-trip)", async () => {
    const user = userEvent.setup();
    const { nav } = renderWorkspace({ initialPath: "/agents" });

    await screen.findByText("My Orchestrator Agent");
    await user.click(screen.getByRole("radio", { name: RE_COMMANDS_TAB }));

    await waitFor(() => {
      expect(queryOf(nav.getCurrentHref()).get("kind")).toBe("command");
    });
    await waitFor(() => {
      expect(
        screen.queryByText("My Orchestrator Agent")
      ).not.toBeInTheDocument();
    });
  });

  it("selecting All removes the ?kind= param (default cleanup)", async () => {
    const user = userEvent.setup();
    const { nav } = renderWorkspace({ initialPath: "/agents?kind=command" });

    await screen.findByText("Code Review Command");
    await user.click(screen.getByRole("radio", { name: RE_ALL_TAB }));

    await waitFor(() => {
      expect(queryOf(nav.getCurrentHref()).get("kind")).toBeNull();
    });
    // All kinds visible again once the tab is cleared.
    await screen.findByText("My Orchestrator Agent");
  });

  it("deep-links to the Tools tab by default (FEA-4019, no flag)", async () => {
    // FEA-4019: Tools is a first-class tab by default (no opt-in), so a
    // ?kind=tool deep-link activates the Tools tab and filters to tool rows.
    renderWorkspace({ initialPath: "/agents?kind=tool" });

    await screen.findByText("Bash Tool");
    await waitFor(() => {
      expect(
        screen.queryByText("My Orchestrator Agent")
      ).not.toBeInTheDocument();
    });
    expect(screen.getByRole("radio", { name: RE_TOOLS_TAB })).toHaveAttribute(
      "data-state",
      "on"
    );
  });

  it("falls back to All for a scoped-out kind (?kind=orchestration, FEA-4019)", async () => {
    // FEA-4019 graduates ONLY Tools/MCPs/Hooks — Orchestration stays scoped out
    // (no tab), so a deep-linked `?kind=orchestration` is not a valid tab and
    // must fall back to All: the All tab is selected and NOTHING is narrowed
    // (both the agent and the tool row render, so it isn't an orchestration
    // filter). The invalid deep-link param is inert until the user interacts.
    renderWorkspace({ initialPath: "/agents?kind=orchestration" });

    await screen.findByText("My Orchestrator Agent");
    await screen.findByText("Bash Tool");
    expect(screen.getByRole("radio", { name: RE_ALL_TAB })).toHaveAttribute(
      "data-state",
      "on"
    );
  });

  it("falls back to All for an unknown kind (bogus ?kind=)", async () => {
    renderWorkspace({ initialPath: "/agents?kind=bogus-kind" });

    await screen.findByText("My Orchestrator Agent");
    await screen.findByText("Bash Tool");
    expect(screen.getByRole("radio", { name: RE_ALL_TAB })).toHaveAttribute(
      "data-state",
      "on"
    );
  });
});
