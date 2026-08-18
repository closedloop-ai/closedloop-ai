import {
  type AgentComponent,
  AgentComponentKind,
  type AgentComponentListResponse,
  type AgentComponentQueryFilters,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { AgentComponentsDataSource } from "../../../data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "../../../data-source/provider";
import { AgentsGroupedList } from "../agents-grouped-list";

// ---------------------------------------------------------------------------
// FEA-4086: honest installed-plugins inventory — component-level integration.
//
// These render <AgentsGroupedList> and drive the tab / time-window controls, so
// they exercise the full wiring the pure copy helpers cannot (tab click →
// honest copy + Packs pointer; a windowed empty Plugins tab wording usage, not
// "installed"). They live in this sibling file (NOT the grandfathered
// agents-grouped-list.test.tsx) so that file keeps shrinking; the pure
// copy/scoping helpers are covered in agents-grouped-list-empty-state.test.ts.
// ---------------------------------------------------------------------------

const RE_NO_PLUGINS_INSTALLED = /no plugins installed\./i;
const RE_ADD_PLUGINS_FROM_PACKS = /add plugins from packs/i;
const RE_NO_PLUGINS_USED_60 = /no plugins used in the last 60 days\./i;
const RE_NO_MATCH = /no components match/i;
const RE_PLUGINS_TAB = /plugins/i;
const RE_LAST_60_DAYS = /last 60 days/i;

function makeComponent(overrides: Partial<AgentComponent>): AgentComponent {
  return {
    id: overrides.id ?? "uuid-default",
    slug: overrides.slug ?? overrides.id ?? "subagent::uuid-default",
    name: overrides.name ?? "Default Component",
    kind: overrides.kind ?? AgentComponentKind.Subagent,
    sourceType: SourceType.Repo,
    source: "repo-a",
    harness: overrides.harness ?? Harness.Claude,
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

function testDataSource(
  items: AgentComponent[],
  onList?: (filters: AgentComponentQueryFilters) => void
): AgentComponentsDataSource {
  return {
    scope: "test",
    list: (filters) => {
      onList?.(filters);
      return Promise.resolve({
        items,
        total: items.length,
      } satisfies AgentComponentListResponse);
    },
    detail: () => Promise.reject(new Error("detail unused in list tests")),
  };
}

function Wrapper({
  children,
  dataSource,
}: {
  children: ReactNode;
  dataSource: AgentComponentsDataSource;
}) {
  return (
    <AppCoreStoryProviders>
      <AgentComponentsDataSourceProvider dataSource={dataSource}>
        {children}
      </AgentComponentsDataSourceProvider>
    </AppCoreStoryProviders>
  );
}

describe("AgentsGroupedList — honest Plugins empty state (FEA-4086)", () => {
  it("says 'No plugins installed' + points to Packs on an empty all-time Plugins tab", async () => {
    const user = userEvent.setup();

    // Inventory with no plugin rows (only a Subagent). Default window is "All".
    render(
      <Wrapper
        dataSource={testDataSource([
          makeComponent({
            id: "uuid-sub-1",
            name: "My Agent",
            kind: AgentComponentKind.Subagent,
          }),
        ])}
      >
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText("My Agent");
    await user.click(screen.getByRole("radio", { name: RE_PLUGINS_TAB }));

    await waitFor(() => {
      expect(screen.getByText(RE_NO_PLUGINS_INSTALLED)).toBeInTheDocument();
    });
    // The plain-text pointer to the Packs page rides alongside the honest copy.
    expect(screen.getByText(RE_ADD_PLUGINS_FROM_PACKS)).toBeInTheDocument();
    // It must NOT fall back to the filter copy — no filter was set.
    expect(screen.queryByText(RE_NO_MATCH)).not.toBeInTheDocument();
  });

  it("words a WINDOWED empty Plugins tab as usage, not 'installed' (window emptied it)", async () => {
    // FEA-4086: the API's `dropZeroWindowUsage` drops plugins with zero in-window
    // usage, so an empty windowed Plugins tab means "none USED in this window",
    // NOT "none installed". Model a source that returns a plugin at all-time but
    // nothing once a `startDate` window is present, then narrow to 60 days.
    const user = userEvent.setup();
    const allTime = [
      makeComponent({
        id: "uuid-plug-1",
        slug: "plugin::uuid-plug-1",
        name: "Installed Pack",
        kind: AgentComponentKind.Plugin,
      }),
    ];
    const dataSource: AgentComponentsDataSource = {
      scope: "agent-components:http",
      list: (filters) =>
        Promise.resolve({
          items: typeof filters.startDate === "string" ? [] : allTime,
          total: 0,
        } satisfies AgentComponentListResponse),
      detail: () => Promise.reject(new Error("detail unused in list tests")),
    };

    render(
      <Wrapper dataSource={dataSource}>
        <AgentsGroupedList />
      </Wrapper>
    );

    // All-time: the installed plugin is visible on the Plugins tab.
    await user.click(screen.getByRole("radio", { name: RE_PLUGINS_TAB }));
    await screen.findByText("Installed Pack");

    // Narrow to the last 60 days — the window drops the unused plugin. The copy
    // must be usage-worded, and must NOT claim nothing is installed (a plugin IS
    // installed; it just had no in-window usage).
    await user.click(screen.getByRole("radio", { name: RE_LAST_60_DAYS }));
    await waitFor(() => {
      expect(screen.getByText(RE_NO_PLUGINS_USED_60)).toBeInTheDocument();
    });
    expect(screen.queryByText(RE_NO_PLUGINS_INSTALLED)).not.toBeInTheDocument();
    expect(
      screen.queryByText(RE_ADD_PLUGINS_FROM_PACKS)
    ).not.toBeInTheDocument();
  });
});
