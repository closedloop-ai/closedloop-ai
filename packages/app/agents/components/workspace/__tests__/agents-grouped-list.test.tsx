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
// Fixture helpers
// ---------------------------------------------------------------------------

function makeComponent(overrides: Partial<AgentComponent>): AgentComponent {
  return {
    id: overrides.id ?? "uuid-default",
    name: overrides.name ?? "Default Component",
    kind: overrides.kind ?? AgentComponentKind.Subagent,
    sourceType: SourceType.Repo,
    source: "repo-a",
    harness: Harness.Claude,
    invocations: 10,
    sessions: 3,
    klocPerDollar: 2.5,
    trend: [],
    owner: "alice",
    collaborators: [],
    computeTargetIds: [],
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

const FIXTURE_COMPONENTS: AgentComponent[] = [
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
    id: "uuid-skill-1",
    name: "Python Expert Skill",
    kind: AgentComponentKind.Skill,
  }),
];

// ---------------------------------------------------------------------------
// Test data source factory
// ---------------------------------------------------------------------------

function testDataSource(
  items: AgentComponent[] = FIXTURE_COMPONENTS,
  onList?: (filters: AgentComponentQueryFilters) => void,
  scope = "test"
): AgentComponentsDataSource {
  return {
    scope,
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
  enabledFlags,
}: {
  children: ReactNode;
  dataSource: AgentComponentsDataSource;
  enabledFlags?: readonly string[];
}) {
  return (
    <AppCoreStoryProviders enabledFlags={enabledFlags}>
      <AgentComponentsDataSourceProvider dataSource={dataSource}>
        {children}
      </AgentComponentsDataSourceProvider>
    </AppCoreStoryProviders>
  );
}

// ---------------------------------------------------------------------------
// Top-level regex constants (biome/performance/useTopLevelRegex)
// ---------------------------------------------------------------------------

// Exact match: the type-tab "All" (aria-label "All"), NOT the time-window
// "All time" radio which also contains "all".
const RE_ALL_TAB = /^All$/;
const RE_AGENTS_TAB = /agents/i;
const RE_COMMANDS_TAB = /commands/i;
const RE_SKILLS_TAB = /skills/i;
const RE_PLUGINS_TAB = /plugins/i;
const RE_LOADING = /loading components/i;
const RE_NO_MATCH = /no components match/i;
// Exact plural aria-labels (kindMeta().plural) for the flag-gated kinds.
const RE_MCP_TAB = /^MCP tools$/;
const RE_TOOLS_TAB = /^Tools$/;
const RE_HOOKS_TAB = /^Hooks$/;
const RE_NEXT_PAGE = /go to next page/i;
const RE_LAST_60_DAYS = /last 60 days/i;
// ISO-8601 datetime prefix — asserts the windowed query carries a startDate.
const RE_ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
// FEA-3178: MetricCard delta chip renders `{positive?"+":""}{delta}%`.
const RE_PLUS_100_PCT = /\+100%/;
const RE_MINUS_50_PCT = /-50%/;
// Any signed-percentage delta chip — used to assert NONE render for "All".
const RE_ANY_PCT_CHIP = /[+-]\d+%/;
// FEA-3176: accessible name of the newly-discovered "New" badge.
const RE_NEW_BADGE = /discovered in the last 7 days/i;

// Near-now vs. well-outside-the-window fixed timestamps for the New-badge tests.
const RECENT_FIRST_SEEN = new Date(
  Date.now() - 2 * 24 * 60 * 60 * 1000
).toISOString();
const OLD_FIRST_SEEN = new Date(
  Date.now() - 30 * 24 * 60 * 60 * 1000
).toISOString();

// FEA-3152: desktop Labs flag key surfacing Tools/MCPs/Hooks as first-class
// kinds in the listing. Redeclared here (rather than imported) to keep the test
// asserting the exact wire key the shared component gates on.
const AGENTS_SHOW_TOOLS_MCPS_HOOKS_FLAG = "agents-show-tools-mcps-hooks";

const FIXTURE_WITH_TMH: AgentComponent[] = [
  ...FIXTURE_COMPONENTS,
  makeComponent({
    id: "uuid-mcp-1",
    name: "Linear MCP",
    kind: AgentComponentKind.Mcp,
  }),
  makeComponent({
    id: "uuid-tool-1",
    name: "Bash Tool",
    kind: AgentComponentKind.Tool,
  }),
  makeComponent({
    id: "uuid-hook-1",
    name: "PreCommit Hook",
    kind: AgentComponentKind.Hook,
  }),
];

// ---------------------------------------------------------------------------
// T-10.7: AgentsGroupedList component tests
// ---------------------------------------------------------------------------

describe("AgentsGroupedList", () => {
  it("renders the type-tab bar with All and core-kind tabs", async () => {
    render(
      <Wrapper dataSource={testDataSource()}>
        <AgentsGroupedList />
      </Wrapper>
    );

    // All tab always present
    expect(
      await screen.findByRole("radio", { name: RE_ALL_TAB })
    ).toBeInTheDocument();

    // Core kind tabs (Agents, Commands, Skills, Plugins — SCOPED_CORE_KINDS)
    expect(
      screen.getByRole("radio", { name: RE_AGENTS_TAB })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: RE_COMMANDS_TAB })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: RE_SKILLS_TAB })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: RE_PLUGINS_TAB })
    ).toBeInTheDocument();
  });

  it("renders component names after data loads", async () => {
    render(
      <Wrapper dataSource={testDataSource()}>
        <AgentsGroupedList />
      </Wrapper>
    );

    expect(
      await screen.findByText("My Orchestrator Agent")
    ).toBeInTheDocument();
    expect(screen.getByText("Code Review Command")).toBeInTheDocument();
    expect(screen.getByText("Python Expert Skill")).toBeInTheDocument();
  });

  it("shows loading state while data is in flight", () => {
    const neverResolves: AgentComponentsDataSource = {
      scope: "test-loading",
      list: () => new Promise(() => {}),
      detail: () => new Promise(() => {}),
    };

    render(
      <Wrapper dataSource={neverResolves}>
        <AgentsGroupedList />
      </Wrapper>
    );

    expect(screen.getByText(RE_LOADING)).toBeInTheDocument();
  });

  it("clicking a kind tab filters rows to only that kind", async () => {
    const user = userEvent.setup();

    render(
      <Wrapper dataSource={testDataSource()}>
        <AgentsGroupedList />
      </Wrapper>
    );

    // Wait for data to load
    await screen.findByText("My Orchestrator Agent");

    // Click the Commands tab
    const commandsTab = screen.getByRole("radio", { name: RE_COMMANDS_TAB });
    await user.click(commandsTab);

    // Only the Command-kind component should be visible
    await waitFor(() => {
      expect(
        screen.queryByText("My Orchestrator Agent")
      ).not.toBeInTheDocument();
      expect(screen.getByText("Code Review Command")).toBeInTheDocument();
      expect(screen.queryByText("Python Expert Skill")).not.toBeInTheDocument();
    });
  });

  it("clicking All tab after a kind tab shows all rows again", async () => {
    const user = userEvent.setup();

    render(
      <Wrapper dataSource={testDataSource()}>
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText("My Orchestrator Agent");

    // Narrow to Skills
    const skillsTab = screen.getByRole("radio", { name: RE_SKILLS_TAB });
    await user.click(skillsTab);

    await waitFor(() => {
      expect(
        screen.queryByText("My Orchestrator Agent")
      ).not.toBeInTheDocument();
    });

    // Click All to restore
    const allTab = screen.getByRole("radio", { name: RE_ALL_TAB });
    await user.click(allTab);

    await waitFor(() => {
      expect(screen.getByText("My Orchestrator Agent")).toBeInTheDocument();
      expect(screen.getByText("Code Review Command")).toBeInTheDocument();
      expect(screen.getByText("Python Expert Skill")).toBeInTheDocument();
    });
  });

  it("renders pluginsFooter only while the Plugins tab is active", async () => {
    const user = userEvent.setup();

    render(
      <Wrapper dataSource={testDataSource()}>
        <AgentsGroupedList
          pluginsFooter={<div data-testid="plugins-footer">Manage plugins</div>}
        />
      </Wrapper>
    );

    // On the default (All) tab the footer is not rendered.
    await screen.findByText("My Orchestrator Agent");
    expect(screen.queryByTestId("plugins-footer")).not.toBeInTheDocument();

    // Selecting Plugins reveals the injected management footer.
    await user.click(screen.getByRole("radio", { name: RE_PLUGINS_TAB }));
    await waitFor(() => {
      expect(screen.getByTestId("plugins-footer")).toBeInTheDocument();
    });

    // Switching back to a non-plugin tab hides it again.
    await user.click(screen.getByRole("radio", { name: RE_SKILLS_TAB }));
    await waitFor(() => {
      expect(screen.queryByTestId("plugins-footer")).not.toBeInTheDocument();
    });
  });

  it("never renders a pluginsFooter that was not provided", async () => {
    const user = userEvent.setup();

    render(
      <Wrapper dataSource={testDataSource()}>
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText("My Orchestrator Agent");
    await user.click(screen.getByRole("radio", { name: RE_PLUGINS_TAB }));

    // No footer node exists when the caller (e.g. web) passes none.
    expect(screen.queryByTestId("plugins-footer")).not.toBeInTheDocument();
  });

  it("shows empty-state message when no rows match the filter", async () => {
    const user = userEvent.setup();

    // Data source with only a Subagent
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

    // Click Plugins — no plugins exist
    await user.click(screen.getByRole("radio", { name: RE_PLUGINS_TAB }));

    await waitFor(() => {
      expect(screen.getByText(RE_NO_MATCH)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // FEA-3152: Tools/MCPs/Hooks first-class rows behind the desktop Labs flag
  // -------------------------------------------------------------------------

  it("flag OFF: tool/mcp/hook are NOT first-class top-level type tabs", async () => {
    render(
      <Wrapper dataSource={testDataSource(FIXTURE_WITH_TMH)}>
        <AgentsGroupedList />
      </Wrapper>
    );

    // Core tabs still present.
    expect(
      await screen.findByRole("radio", { name: RE_AGENTS_TAB })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: RE_PLUGINS_TAB })
    ).toBeInTheDocument();

    // No MCP / Tools / Hooks top-level tab (scoped-out, reachable via All only).
    expect(
      screen.queryByRole("radio", { name: RE_MCP_TAB })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: RE_TOOLS_TAB })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: RE_HOOKS_TAB })
    ).not.toBeInTheDocument();
  });

  it("flag ON: tool/mcp/hook surface as first-class top-level type tabs", async () => {
    render(
      <Wrapper
        dataSource={testDataSource(FIXTURE_WITH_TMH)}
        enabledFlags={[AGENTS_SHOW_TOOLS_MCPS_HOOKS_FLAG]}
      >
        <AgentsGroupedList />
      </Wrapper>
    );

    // Existing core tabs unaffected.
    expect(
      await screen.findByRole("radio", { name: RE_AGENTS_TAB })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: RE_PLUGINS_TAB })
    ).toBeInTheDocument();

    // The three previously scoped-out kinds now have their own tabs.
    expect(screen.getByRole("radio", { name: RE_MCP_TAB })).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: RE_TOOLS_TAB })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: RE_HOOKS_TAB })
    ).toBeInTheDocument();
  });

  it("flag ON: the Tools tab filters rows to only tool-kind components", async () => {
    const user = userEvent.setup();

    render(
      <Wrapper
        dataSource={testDataSource(FIXTURE_WITH_TMH)}
        enabledFlags={[AGENTS_SHOW_TOOLS_MCPS_HOOKS_FLAG]}
      >
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText("Bash Tool");

    await user.click(screen.getByRole("radio", { name: RE_TOOLS_TAB }));

    await waitFor(() => {
      expect(screen.getByText("Bash Tool")).toBeInTheDocument();
      expect(screen.queryByText("Linear MCP")).not.toBeInTheDocument();
      expect(
        screen.queryByText("My Orchestrator Agent")
      ).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Pagination + summary-over-full-set (agents page pagination bug fix)
  // -------------------------------------------------------------------------

  // Row name anchors carry an /agents/ href (see AgentsTable renderNameLead);
  // pagination controls are hrefless <a> and so are NOT role="link", which lets
  // us count just the data rows.
  const rowLinks = () =>
    screen
      .getAllByRole("link")
      .filter((el) => el.getAttribute("href")?.startsWith("/agents/"));

  it("caps the list at one page while the summary counts the full set", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 60 }, (_, i) =>
      makeComponent({
        id: `uuid-page-${i}`,
        name: `Paged Component ${i}`,
        kind: AgentComponentKind.Subagent,
        invocations: 10,
      })
    );

    render(
      <Wrapper dataSource={testDataSource(many)}>
        <AgentsGroupedList getComponentHref={(c) => `/agents/${c.id}`} />
      </Wrapper>
    );

    // Page 1 renders exactly AGENTS_PAGE_SIZE (50) of the 60 rows…
    await waitFor(() => expect(rowLinks()).toHaveLength(50));

    // …but the Invocations summary sums ALL 60 rows (60 × 10 = 600), proving the
    // stats are computed over the full set, not just the visible page.
    expect(screen.getByText("600")).toBeInTheDocument();

    // Next page shows the remaining 10 rows.
    await user.click(screen.getByLabelText(RE_NEXT_PAGE));
    await waitFor(() => expect(rowLinks()).toHaveLength(10));
  });

  it("resets to page 1 when a filter narrows to a still-multi-page subset", async () => {
    const user = userEvent.setup();
    // 60 subagents + 60 commands = 120 rows across 3 pages on the All tab.
    // Names are zero-padded so the default Name-Asc sort is index order, which
    // lets us assert WHICH page's rows are visible. Filtering to Commands still
    // leaves 60 rows (2 pages), so a reset-to-page-1 is the ONLY thing that can
    // surface "Command 00" — the empty-state clamp cannot, since the set is not
    // empty. This distinguishes an explicit reset from the empty-state clamp.
    const subagents = Array.from({ length: 60 }, (_, i) =>
      makeComponent({
        id: `uuid-sub-${i}`,
        name: `Subagent ${String(i).padStart(2, "0")}`,
        kind: AgentComponentKind.Subagent,
      })
    );
    const commands = Array.from({ length: 60 }, (_, i) =>
      makeComponent({
        id: `uuid-cmd-${i}`,
        name: `Command ${String(i).padStart(2, "0")}`,
        kind: AgentComponentKind.Command,
      })
    );

    render(
      <Wrapper dataSource={testDataSource([...subagents, ...commands])}>
        <AgentsGroupedList getComponentHref={(c) => `/agents/${c.id}`} />
      </Wrapper>
    );

    // Page 1 of the All tab shows the first 50 rows (Command 00…Command 49).
    await waitFor(() => expect(rowLinks()).toHaveLength(50));
    // Advance to page 2 (rows 51-100) — "Command 00" is no longer on screen.
    await user.click(screen.getByLabelText(RE_NEXT_PAGE));
    await waitFor(() =>
      expect(screen.queryByText("Command 00")).not.toBeInTheDocument()
    );

    // Filter to Commands: 60 rows remain (still 2 pages, NOT empty). A correct
    // reset lands on page 1, so the first page's rows (incl. "Command 00")
    // render and page 2's last-page count (10) is NOT what we see.
    await user.click(screen.getByRole("radio", { name: RE_COMMANDS_TAB }));
    await waitFor(() => {
      expect(screen.getByText("Command 00")).toBeInTheDocument();
    });
    // Page 1 of the 60 filtered commands is a FULL page of 50 — proving we are
    // on page 1 (page 2 would show the remaining 10), i.e. an explicit reset,
    // not the empty-state clamp (which would show 0).
    expect(rowLinks()).toHaveLength(50);
    expect(screen.queryByText(RE_NO_MATCH)).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Time-window (All / 30 / 60 / 90 day) filter
  // -------------------------------------------------------------------------

  it("selecting a time window re-queries the server with a startDate param", async () => {
    // FEA-3160: windowing is SERVER-SIDE now. The default "All" window sends no
    // startDate; selecting "Last 60 days" must re-query with a startDate ISO
    // lower bound so the endpoint scopes usage by `lastInvokedAt >= startDate`.
    const user = userEvent.setup();
    const captured: AgentComponentQueryFilters[] = [];

    render(
      <Wrapper
        dataSource={testDataSource(FIXTURE_COMPONENTS, (f) => captured.push(f))}
      >
        <AgentsGroupedList />
      </Wrapper>
    );

    // Initial (All-time) fetch: no startDate bound.
    await screen.findByText("My Orchestrator Agent");
    expect(captured[0]?.startDate).toBeUndefined();

    // Narrow to the last 60 days — a new query with a startDate must fire.
    await user.click(screen.getByRole("radio", { name: RE_LAST_60_DAYS }));
    await waitFor(() => {
      const windowed = captured.find((f) => typeof f.startDate === "string");
      expect(windowed?.startDate).toMatch(RE_ISO_DATETIME);
    });
  });

  it("summary Invocations sums the full server-windowed set, not the page", async () => {
    // The server returns the windowed rows; the summary must aggregate over all
    // of them (across every client page), not just the visible page slice.
    const many = Array.from({ length: 60 }, (_, i) =>
      makeComponent({
        id: `uuid-win-${i}`,
        name: `Windowed Component ${i}`,
        kind: AgentComponentKind.Subagent,
        invocations: 5,
      })
    );

    render(
      <Wrapper dataSource={testDataSource(many)}>
        <AgentsGroupedList getComponentHref={(c) => `/agents/${c.id}`} />
      </Wrapper>
    );

    // Page 1 caps at 50 rows…
    await waitFor(() => expect(rowLinks()).toHaveLength(50));
    // …but Invocations sums all 60 windowed rows (60 × 5 = 300).
    expect(screen.getByText("300")).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // FEA-3178: period-over-period delta on the summary cards
  // -------------------------------------------------------------------------

  // The delta is ONLY shown on a data source that genuinely honors the
  // startDate/endDate window — the web/HTTP source ("agent-components:http").
  // A source that ignores the window (the desktop local source) would return
  // the SAME rows for the current and preceding query, fabricating a 0% delta,
  // so the component suppresses the delta there. These tests therefore mint a
  // source under the windowed scope so a real prior baseline exists.
  const WINDOWED_SCOPE = "agent-components:http";
  // The desktop local source scope — ignores the window, so no delta must show.
  const LOCAL_SCOPE = "agent-components:local";

  // A data source that serves the CURRENT window (startDate only, or all-time)
  // vs the PRECEDING window (startDate + endDate) from two distinct populations,
  // so a delta computes off a real prior baseline. The preceding query is the
  // only one that sends `endDate` (see AgentsGroupedList's second
  // useAgentComponents). `scope` defaults to the windowed source; pass
  // LOCAL_SCOPE to model a source that ignores the window.
  function periodOverPeriodDataSource(
    current: AgentComponent[],
    previous: AgentComponent[],
    scope: string = WINDOWED_SCOPE
  ): AgentComponentsDataSource {
    return {
      scope,
      list: (filters) => {
        const isPreceding = typeof filters.endDate === "string";
        const items = isPreceding ? previous : current;
        return Promise.resolve({
          items,
          total: items.length,
        } satisfies AgentComponentListResponse);
      },
      detail: () => Promise.reject(new Error("detail unused in list tests")),
    };
  }

  it("renders a period-over-period delta chip with the right sign when a window is selected", async () => {
    const user = userEvent.setup();
    // Current window: 2 components, 30 invocations total. Previous window: 1
    // component, 15 invocations. Components: (2-1)/1 = +100%. Invocations:
    // (30-15)/15 = +100%. Owners: current {alice,bob}=2 vs previous {alice}=1 =
    // +100%.
    const current = [
      makeComponent({
        id: "cur-1",
        name: "Current A",
        invocations: 20,
        owner: "alice",
      }),
      makeComponent({
        id: "cur-2",
        name: "Current B",
        invocations: 10,
        owner: "bob",
      }),
    ];
    const previous = [
      makeComponent({
        id: "prev-1",
        name: "Prev A",
        invocations: 15,
        owner: "alice",
      }),
    ];

    render(
      <Wrapper dataSource={periodOverPeriodDataSource(current, previous)}>
        <AgentsGroupedList />
      </Wrapper>
    );

    // Select a bounded window so the preceding query fires.
    await screen.findByText("Current A");
    await user.click(screen.getByRole("radio", { name: RE_LAST_60_DAYS }));

    // At least one +100% delta chip renders (Components / Invocations / Owners
    // all moved +100%). The chip text carries the sign + percentage.
    await waitFor(() => {
      expect(screen.getAllByText(RE_PLUS_100_PCT).length).toBeGreaterThan(0);
    });
  });

  it("renders a NEGATIVE delta when the current window shrank vs the prior period", async () => {
    const user = userEvent.setup();
    // Invocations: current 10 vs previous 20 ⇒ (10-20)/20 = -50%.
    const current = [
      makeComponent({ id: "cur-1", name: "Current A", invocations: 10 }),
    ];
    const previous = [
      makeComponent({ id: "prev-1", name: "Prev A", invocations: 20 }),
    ];

    render(
      <Wrapper dataSource={periodOverPeriodDataSource(current, previous)}>
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText("Current A");
    await user.click(screen.getByRole("radio", { name: RE_LAST_60_DAYS }));

    await waitFor(() => {
      expect(screen.getAllByText(RE_MINUS_50_PCT).length).toBeGreaterThan(0);
    });
  });

  it("shows NO delta chip for the All window (no prior period to compare)", async () => {
    // The default window is "All": the preceding query is disabled (never sends
    // endDate), so no baseline exists and no delta chip renders — never a
    // fabricated placeholder. Assert no signed-percentage chip is present.
    render(
      <Wrapper
        dataSource={testDataSource(
          FIXTURE_COMPONENTS,
          undefined,
          WINDOWED_SCOPE
        )}
      >
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText("My Orchestrator Agent");
    expect(screen.queryByText(RE_ANY_PCT_CHIP)).not.toBeInTheDocument();
  });

  it("shows NO delta on a data source that ignores the date window (desktop local)", async () => {
    const user = userEvent.setup();
    // The local source returns the SAME population regardless of the window, so
    // current === previous and a naive delta would fabricate 0%. The component
    // gates the delta on the windowed (HTTP) scope, so NO chip must render even
    // after a bounded window is selected on the local source.
    const rows = [
      makeComponent({ id: "loc-1", name: "Local A", invocations: 20 }),
      makeComponent({ id: "loc-2", name: "Local B", invocations: 10 }),
    ];

    render(
      <Wrapper dataSource={periodOverPeriodDataSource(rows, rows, LOCAL_SCOPE)}>
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText("Local A");
    await user.click(screen.getByRole("radio", { name: RE_LAST_60_DAYS }));

    // Give the (suppressed) preceding query a chance to have run: assert the
    // summary is rendered but carries no signed-percentage delta chip.
    await waitFor(() => {
      expect(screen.getByText("Local A")).toBeInTheDocument();
    });
    expect(screen.queryByText(RE_ANY_PCT_CHIP)).not.toBeInTheDocument();
  });

  it("facet-filters the PREVIOUS window the same way as the current before computing the delta", async () => {
    const user = userEvent.setup();
    // Current window (Subagent kind): 1 subagent, 10 invocations.
    // Previous window: 1 subagent (10 invocations) PLUS an unrelated Command.
    // With the Agents (Subagent) type-tab active, BOTH the current and the
    // previous populations must be narrowed to Subagents. The facet-filtered
    // previous Invocations = 20 (the subagent only), so the delta is
    // (10-20)/20 = -50%. If the previous window were left UNfiltered, its
    // Invocations would be 20 (subagent) + 30 (command) = 50, giving
    // (10-50)/50 = -80% — a different, apples-to-oranges number. Asserting the
    // -50% chip proves the previous population is facet-filtered like-for-like.
    const current = [
      makeComponent({
        id: "cur-sub",
        name: "Current Subagent",
        kind: AgentComponentKind.Subagent,
        invocations: 10,
      }),
    ];
    const previous = [
      makeComponent({
        id: "prev-sub",
        name: "Prev Subagent",
        kind: AgentComponentKind.Subagent,
        invocations: 20,
      }),
      makeComponent({
        id: "prev-cmd",
        name: "Prev Command",
        kind: AgentComponentKind.Command,
        invocations: 30,
      }),
    ];

    render(
      <Wrapper dataSource={periodOverPeriodDataSource(current, previous)}>
        <AgentsGroupedList />
      </Wrapper>
    );

    // Narrow to the Agents (Subagent) type-tab AND select a bounded window.
    await screen.findByText("Current Subagent");
    await user.click(screen.getByRole("radio", { name: RE_AGENTS_TAB }));
    await user.click(screen.getByRole("radio", { name: RE_LAST_60_DAYS }));

    // The Invocations delta reflects the FACET-FILTERED previous population
    // (subagent only, 20 → -50%), never the unfiltered previous total (50).
    await waitFor(() => {
      expect(screen.getAllByText(RE_MINUS_50_PCT).length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // FEA-3176: newly-discovered "New" badge (firstSeenAt within the last 7 days)
  // -------------------------------------------------------------------------

  it("renders a New badge for a component discovered in the last 7 days", async () => {
    render(
      <Wrapper
        dataSource={testDataSource([
          makeComponent({
            id: "uuid-recent",
            name: "Freshly Discovered Agent",
            kind: AgentComponentKind.Subagent,
            firstSeenAt: RECENT_FIRST_SEEN,
          }),
        ])}
      >
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText("Freshly Discovered Agent");
    expect(screen.getByLabelText(RE_NEW_BADGE)).toBeInTheDocument();
  });

  it("does not render a New badge for a component discovered long ago", async () => {
    render(
      <Wrapper
        dataSource={testDataSource([
          makeComponent({
            id: "uuid-old",
            name: "Long-Lived Agent",
            kind: AgentComponentKind.Subagent,
            firstSeenAt: OLD_FIRST_SEEN,
          }),
        ])}
      >
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText("Long-Lived Agent");
    expect(screen.queryByLabelText(RE_NEW_BADGE)).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // FEA-3179: live "active in the last hour" pulse dot in the Name lead cell
  // -------------------------------------------------------------------------

  it("renders the active pulse dot for a recently-invoked component and not for a stale one", async () => {
    // The dot keys off `lastInvokedAt` (real usage recency), NOT `lastSeenAt`
    // (a sync-heartbeat the pack scanner refreshes to now() every sync, so it
    // would light up for every installed component). Two rows: one invoked a
    // minute ago (inside the 60-min window → live dot), one invoked days ago
    // (stale → no dot). A recent `lastSeenAt` on the stale row proves the dot
    // does NOT key off `lastSeenAt`. Timestamps derive from now so the
    // assertion stays stable regardless of when the suite runs.
    const now = Date.now();
    const recent = new Date(now - 60 * 1000).toISOString(); // 1 min ago
    const stale = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(); // 3d ago

    render(
      <Wrapper
        dataSource={testDataSource([
          makeComponent({
            id: "uuid-live",
            name: "Live Component",
            kind: AgentComponentKind.Subagent,
            lastInvokedAt: recent,
          }),
          makeComponent({
            id: "uuid-stale",
            name: "Stale Component",
            kind: AgentComponentKind.Subagent,
            // Fresh sync heartbeat but stale real usage → must NOT be "active".
            lastSeenAt: recent,
            lastInvokedAt: stale,
          }),
        ])}
      >
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText("Live Component");
    await screen.findByText("Stale Component");

    // Exactly one active dot renders — for the recently-invoked row only.
    const dots = screen.getAllByTestId("agent-active-dot");
    expect(dots).toHaveLength(1);
    expect(dots[0]).toHaveAccessibleName("Active in the last hour");

    // The dot is a sibling of the live row's name, not the stale one's.
    const liveName = screen.getByText("Live Component");
    expect(liveName.parentElement).toContainElement(dots[0]);
    const staleName = screen.getByText("Stale Component");
    expect(staleName.parentElement).not.toContainElement(dots[0]);
  });

  it("renders no active dot when a component has never been invoked", async () => {
    // A component with a fresh `lastSeenAt` but no `lastInvokedAt` at all (e.g.
    // a configured-only kind, or a surface that does not project the field)
    // must never be treated as active — the whole point of FEA-3179's fix.
    const fresh = new Date(Date.now() - 60 * 1000).toISOString();
    render(
      <Wrapper
        dataSource={testDataSource([
          makeComponent({
            id: "uuid-never-invoked",
            name: "Never Invoked Component",
            kind: AgentComponentKind.Config,
            lastSeenAt: fresh,
            lastInvokedAt: undefined,
          }),
        ])}
      >
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText("Never Invoked Component");
    expect(screen.queryByTestId("agent-active-dot")).not.toBeInTheDocument();
  });
});
