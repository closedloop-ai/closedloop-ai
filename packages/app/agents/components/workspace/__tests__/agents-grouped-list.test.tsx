import {
  type AgentComponent,
  AgentComponentKind,
  type AgentComponentListResponse,
  type AgentComponentQueryFilters,
} from "@repo/api/src/types/agent-component";
import {
  FIXTURE_COMPONENTS,
  makeComponent,
} from "@repo/app/agents/components/workspace/agent-component-fixtures";
import { AGENT_COMPONENT_AUTHORS_LABEL } from "@repo/app/agents/lib/agent-component-authors";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { AgentComponentsDataSource } from "../../../data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "../../../data-source/provider";
import { AgentsGroupedList } from "../agents-grouped-list";

// ---------------------------------------------------------------------------
// Fixtures — the factory + inventory are shared with the desktop parity suite
// via `agent-component-fixtures` so the two "renders consistently on both
// surfaces" parity claims cannot drift against different component shapes.
// ---------------------------------------------------------------------------

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
const RE_LOAD_ERROR = /couldn't load components/i;
// FEA-4019: kind-named empty state for an empty tab (no facet/search filter).
const RE_NO_SKILLS = /no skills yet/i;
// Exact plural aria-labels (kindMeta().plural) for the FEA-4019 graduated kinds.
const RE_MCP_TAB = /^MCPs$/;
const RE_TOOLS_TAB = /^Tools$/;
const RE_HOOKS_TAB = /^Hooks$/;
const RE_NEXT_PAGE = /go to next page/i;
const RE_LAST_60_DAYS = /last 60 days/i;
// FEA-3202 / FEA-4098: filter-popover trigger + authors facet submenu + the
// `bob` author option that must survive as a zero-count entry when the window
// narrows. FEA-4266: the facet's visible label is now "Authors"
// (AGENT_COMPONENT_AUTHORS_LABEL); the `collaborators` filter key is unchanged.
const RE_FILTER_BUTTON = /^Filter$/;
const RE_AUTHORS_FACET = new RegExp(`^${AGENT_COMPONENT_AUTHORS_LABEL}$`);
const RE_BOB_COLLABORATOR_OPTION = /bob/i;
// ISO-8601 datetime prefix — asserts the windowed query carries a startDate.
const RE_ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
// FEA-3178: MetricCard delta chip renders `{positive?"+":""}{delta}%`.
const RE_PLUS_100_PCT = /\+100%/;
const RE_MINUS_50_PCT = /-50%/;
// Any signed-percentage delta chip — used to assert NONE render for "All".
const RE_ANY_PCT_CHIP = /[+-]\d+%/;
// FEA-3176 / FEA-3620: accessible name of the newly-discovered "New" indicator
// (unified from a text pill into a pulsing dot; the label is preserved).
const RE_NEW_BADGE = /discovered in the last 7 days/i;
// FEA-3620: the visible "New" text is gone once the badge becomes a dot.
const RE_NEW_TEXT = /^New$/;
// FEA-3054: accessible name (aria-label) of the inventory search box. Anchors
// the control by its a11y contract so the test breaks if the label regresses.
const RE_SEARCH_BOX = /^Search components$/;

// Near-now vs. well-outside-the-window fixed timestamps for the New-badge tests.
const RECENT_FIRST_SEEN = new Date(
  Date.now() - 2 * 24 * 60 * 60 * 1000
).toISOString();
const OLD_FIRST_SEEN = new Date(
  Date.now() - 30 * 24 * 60 * 60 * 1000
).toISOString();

// FEA-4019: Tools/MCPs/Hooks are first-class top-level type tabs by DEFAULT on
// both web and desktop — no feature flag. The `agents-show-tools-mcps-hooks`
// Labs gate that previously scoped them out (FEA-3152) has been removed from the
// shared component.

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

  it("shows an error state (not the empty state) when the list query rejects", async () => {
    const rejectingSource: AgentComponentsDataSource = {
      scope: "test-error",
      list: () => Promise.reject(new Error("network down")),
      detail: () => Promise.reject(new Error("detail unused")),
    };

    render(
      <Wrapper dataSource={rejectingSource}>
        <AgentsGroupedList />
      </Wrapper>
    );

    // A rejected query must surface a real error, never the "no components
    // match" empty state — that would tell the user "no agents" during an
    // outage (FEA-3994 review).
    await waitFor(() => {
      expect(screen.getByText(RE_LOAD_ERROR)).toBeInTheDocument();
    });
    expect(screen.queryByText(RE_NO_MATCH)).not.toBeInTheDocument();
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

  it("shows a kind-named empty state (not the filter copy) for an empty tab", async () => {
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

    // Click Skills — no skills exist. FEA-4019: with no facet/search filter
    // set, the empty state names the kind ("No skills yet.") instead of the
    // misleading "no components match the current filters" copy, which would
    // send the user off to clear a filter they never set. The default window is
    // "All", so the message has no time-window clause.
    await user.click(screen.getByRole("radio", { name: RE_SKILLS_TAB }));

    await waitFor(() => {
      expect(screen.getByText(RE_NO_SKILLS)).toBeInTheDocument();
    });
    expect(screen.queryByText(RE_NO_MATCH)).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // FEA-4019: Tools/MCPs/Hooks are first-class top-level type tabs by DEFAULT
  // (no feature flag) on both web and desktop — the shared component drives
  // both surfaces, so removing the old Labs gate lights the tabs up everywhere.
  // -------------------------------------------------------------------------

  it("renders Tools/MCPs/Hooks as first-class top-level type tabs by default (no flag)", async () => {
    render(
      // No enabledFlags — proves the tabs show WITHOUT any opt-in, matching the
      // desktop tab set on the web surface (FEA-4019).
      <Wrapper dataSource={testDataSource(FIXTURE_WITH_TMH)}>
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

    // Tools / MCPs / Hooks now have their own top-level tabs, no flag required.
    expect(screen.getByRole("radio", { name: RE_MCP_TAB })).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: RE_TOOLS_TAB })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: RE_HOOKS_TAB })
    ).toBeInTheDocument();
  });

  it("the Tools tab filters rows to only tool-kind components (default, no flag)", async () => {
    const user = userEvent.setup();

    render(
      <Wrapper dataSource={testDataSource(FIXTURE_WITH_TMH)}>
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
  // FEA-3054: inventory search box (the control this PR renders)
  // -------------------------------------------------------------------------

  it("narrows the rendered rows to the typed query and resets to page 1", async () => {
    const user = userEvent.setup();
    // 60 "Alpha" + 60 "Beta" = 120 rows across 3 pages on the All tab. Names are
    // zero-padded so the default Name-Asc sort is index order, letting us assert
    // WHICH page's rows are visible. Typing "Alpha" leaves 60 rows (still 2
    // pages, NOT empty), so surfacing "Alpha 00" can ONLY come from a
    // reset-to-page-1 — the empty-state clamp cannot, since the set is non-empty.
    const alphas = Array.from({ length: 60 }, (_, i) =>
      makeComponent({
        id: `uuid-alpha-${i}`,
        name: `Alpha ${String(i).padStart(2, "0")}`,
        kind: AgentComponentKind.Subagent,
      })
    );
    const betas = Array.from({ length: 60 }, (_, i) =>
      makeComponent({
        id: `uuid-beta-${i}`,
        name: `Beta ${String(i).padStart(2, "0")}`,
        kind: AgentComponentKind.Subagent,
      })
    );

    render(
      <Wrapper dataSource={testDataSource([...alphas, ...betas])}>
        <AgentsGroupedList getComponentHref={(c) => `/agents/${c.id}`} />
      </Wrapper>
    );

    // Page 1 of the All tab shows the first 50 rows (Alpha 00…Alpha 49).
    await waitFor(() => expect(rowLinks()).toHaveLength(50));
    // Advance to page 2 (rows 51-100) — "Alpha 00" is no longer on screen.
    await user.click(screen.getByLabelText(RE_NEXT_PAGE));
    await waitFor(() =>
      expect(screen.queryByText("Alpha 00")).not.toBeInTheDocument()
    );

    // Enter a query in the search box: only the 60 "Alpha …" rows should remain,
    // and a correct filter reset lands back on page 1 (so "Alpha 00" reappears)
    // while the "Beta …" rows drop out entirely. A single `fireEvent.change`
    // models the control's `onChange(handleFiltersChange)` in one shot — the
    // render→state→filter→page-reset wiring under test — without paying for a
    // per-keystroke re-render of the 120-row set (which times out under load).
    const searchBox = screen.getByLabelText(RE_SEARCH_BOX);
    fireEvent.change(searchBox, { target: { value: "Alpha" } });

    await waitFor(() => {
      expect(screen.getByText("Alpha 00")).toBeInTheDocument();
    });
    // Page 1 of the 60 filtered Alphas is a FULL page of 50 — proving page 1
    // (page 2 would show the remaining 10), i.e. an explicit reset, not the
    // empty-state clamp (which would show 0).
    expect(rowLinks()).toHaveLength(50);
    expect(screen.queryByText("Beta 00")).not.toBeInTheDocument();
    expect(screen.queryByText(RE_NO_MATCH)).not.toBeInTheDocument();
  });

  it("shows the empty state when the search query matches nothing", async () => {
    const user = userEvent.setup();

    render(
      <Wrapper dataSource={testDataSource()}>
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText("My Orchestrator Agent");

    // A query that matches no component name drives the empty state.
    await user.type(
      screen.getByLabelText(RE_SEARCH_BOX),
      "zzz-no-such-component"
    );

    await waitFor(() => {
      expect(screen.getByText(RE_NO_MATCH)).toBeInTheDocument();
      expect(
        screen.queryByText("My Orchestrator Agent")
      ).not.toBeInTheDocument();
    });
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

  it("keeps Authors facet options for authors with no in-window usage when the window narrows (FEA-3202)", async () => {
    // FEA-3160 made the window server-enforced: the windowed list drops
    // usage-trackable components with zero in-window usage. The Authors/
    // Source filter options must NOT collapse with it — they are seeded from the
    // UNWINDOWED inventory (value universe) so an author whose components had no
    // recent usage stays selectable as a zero-count option. Model a windowed
    // (HTTP) source that returns only Alice when a `startDate` is present and
    // both Alice + Bob when it is absent.
    const user = userEvent.setup();
    const allTime = [
      makeComponent({
        id: "u-alice",
        name: "Alice Agent",
        collaborators: ["alice"],
      }),
      makeComponent({
        id: "u-bob",
        name: "Bob Agent",
        collaborators: ["bob"],
      }),
    ];
    const windowed = [
      makeComponent({
        id: "u-alice",
        name: "Alice Agent",
        collaborators: ["alice"],
      }),
    ];
    const dataSource: AgentComponentsDataSource = {
      scope: "agent-components:http",
      list: (filters) =>
        Promise.resolve({
          items: typeof filters.startDate === "string" ? windowed : allTime,
          total: 0,
        } satisfies AgentComponentListResponse),
      detail: () => Promise.reject(new Error("detail unused in list tests")),
    };

    render(
      <Wrapper dataSource={dataSource}>
        <AgentsGroupedList />
      </Wrapper>
    );

    // All-time: both authors' rows render.
    await screen.findByText("Alice Agent");
    expect(screen.getByText("Bob Agent")).toBeInTheDocument();

    // Narrow to the last 60 days — the server drops Bob (no in-window usage).
    await user.click(screen.getByRole("radio", { name: RE_LAST_60_DAYS }));
    await waitFor(() =>
      expect(screen.queryByText("Bob Agent")).not.toBeInTheDocument()
    );

    // …but the Authors filter menu still lists `bob` as a (zero-count)
    // option.
    await user.click(screen.getByRole("button", { name: RE_FILTER_BUTTON }));
    await user.hover(screen.getByRole("menuitem", { name: RE_AUTHORS_FACET }));
    await waitFor(() =>
      expect(
        screen.getByRole("menuitem", { name: RE_BOB_COLLABORATOR_OPTION })
      ).toBeVisible()
    );
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
    // (30-15)/15 = +100%. Authors: current {alice,bob}=2 vs previous
    // {alice}=1 = +100%.
    const current = [
      makeComponent({
        id: "cur-1",
        name: "Current A",
        invocations: 20,
        collaborators: ["alice"],
      }),
      makeComponent({
        id: "cur-2",
        name: "Current B",
        invocations: 10,
        collaborators: ["bob"],
      }),
    ];
    const previous = [
      makeComponent({
        id: "prev-1",
        name: "Prev A",
        invocations: 15,
        collaborators: ["alice"],
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

    // At least one +100% delta chip renders (Components / Invocations /
    // Authors all moved +100%). The chip text carries the sign + percentage.
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
  // FEA-3176 / FEA-3620: newly-discovered "New" indicator — a pulsing dot
  // (unified from the old text pill) when firstSeenAt is within the last 7 days.
  // -------------------------------------------------------------------------

  it("renders a New dot (not a text pill) for a component discovered in the last 7 days", async () => {
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
    // FEA-3620: the indicator is now a pulsing dot carrying the accessible label…
    const dot = screen.getByTestId("agent-new-dot");
    expect(dot).toBeInTheDocument();
    expect(dot).toHaveAccessibleName(RE_NEW_BADGE);
    // …with no visible "New" text pill anymore.
    expect(screen.queryByText(RE_NEW_TEXT)).not.toBeInTheDocument();
  });

  it("does not render a New dot for a component discovered long ago", async () => {
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
    expect(screen.queryByTestId("agent-new-dot")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(RE_NEW_BADGE)).not.toBeInTheDocument();
  });

  it("renders the New and Active dots inline together for a fresh, recently-invoked component", async () => {
    // FEA-3620: both signals now share the pulsing-dot vocabulary, so a single
    // row that is BOTH newly discovered AND active in the last hour carries the
    // two dots side-by-side in the same Name lead span — differentiated by tone,
    // not by two different UI vocabularies.
    const recentInvoke = new Date(Date.now() - 60 * 1000).toISOString();
    render(
      <Wrapper
        dataSource={testDataSource([
          makeComponent({
            id: "uuid-new-and-active",
            name: "Fresh Active Agent",
            kind: AgentComponentKind.Subagent,
            firstSeenAt: RECENT_FIRST_SEEN,
            lastInvokedAt: recentInvoke,
          }),
        ])}
      >
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText("Fresh Active Agent");
    const newDot = screen.getByTestId("agent-new-dot");
    const activeDot = screen.getByTestId("agent-active-dot");
    expect(newDot).toBeInTheDocument();
    expect(activeDot).toBeInTheDocument();
    // Both dots are siblings of the name within the same lead-cell span.
    const nameSpan = screen.getByText("Fresh Active Agent").parentElement;
    expect(nameSpan).toContainElement(newDot);
    expect(nameSpan).toContainElement(activeDot);
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
