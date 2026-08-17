import {
  type AgentComponent,
  AgentComponentKind,
  AgentMetricMode,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { AgentsTable } from "../agents-table";

// The reorder handle's accessible name states the operation ("use arrow keys")
// so a screen-reader user knows the keys reorder, not just that a control exists.
const RE_REORDER_HANDLE = /^Reorder .+ column, use arrow keys$/;
const RE_REORDER_TYPE = /^Reorder Type column, use arrow keys$/;

// The sd3 Tooltip renders its content in a portal that only opens on
// hover/focus, so it never mounts in JSDOM. Mock it via the shared factory the
// sessions-table suite also uses so the trigger stays inline (preserving the
// truncation classes) and the tooltip content is always present for assertion.
// The name lead's no-href path renders a native <button> trigger, so the
// default focusable-button shape is required (asserted below). Imported lazily
// inside the (hoisted) factory to avoid a TDZ error.
vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

// A component name long enough to overflow the lead cell and (before FEA-3775)
// render underneath the Type chip in the adjacent column.
const LONG_MCP_NAME = "mcp__closedloop__create-document-version";

function makeComponent(overrides: Partial<AgentComponent>): AgentComponent {
  return {
    id: overrides.id ?? "uuid-default",
    slug: overrides.slug ?? overrides.id ?? "mcp::uuid-default",
    name: overrides.name ?? "Default Component",
    kind: overrides.kind ?? AgentComponentKind.Mcp,
    sourceType: SourceType.Repo,
    source: "repo-a",
    harness: Harness.Claude,
    invocations: 10,
    sessions: 3,
    locPerDollar: 2.5,
    trend: [],
    collaborators: [],
    computeTargetIds: [],
    firstSeenAt: "2020-01-01T00:00:00.000Z",
    lastSeenAt: "2020-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderTable(items: AgentComponent[], getComponentHref?: boolean) {
  return render(
    <AgentsTable
      getComponentHref={
        getComponentHref
          ? (item) => `/agents/${encodeURIComponent(item.id)}`
          : undefined
      }
      items={items}
      metricMode={AgentMetricMode.LocPerDollar}
      onSort={() => {
        // no-op
      }}
      sortBy="name"
      sortDir="asc"
    />,
    { wrapper: AppCoreStoryProviders }
  );
}

/**
 * The tooltip content carrying the component NAME.
 *
 * ISS-5366: scoped by its text rather than taken as the page's only tooltip. The
 * Metric column header carries its own what/how tooltip, which used to sit
 * behind `agents-loc-per-dollar-display` and now renders unconditionally —
 * ISS-5475 moved it onto the base `COLUMN_SPECS` metric entry, so it ships with
 * the label rather than with the alignment delta. Either way a bare
 * `getByTestId("tooltip-content")` matches two nodes
 * and throws. The name lead is what this suite is about; the Metric header
 * tooltip is asserted in `agents-count-column-alignment.test.tsx`.
 */
function nameTooltipContent(): HTMLElement {
  const match = screen
    .getAllByTestId("tooltip-content")
    .find((node) => node.textContent?.includes(LONG_MCP_NAME));
  if (!match) {
    throw new Error("no tooltip content rendered carrying the component name");
  }
  return match;
}

describe("AgentsTable name lead — FEA-3775 overflow", () => {
  it("truncates a long mcp__ name inside the lead cell", () => {
    renderTable(
      [makeComponent({ id: "uuid-mcp-1", name: LONG_MCP_NAME })],
      true
    );

    // The name renders as a link (href supplied) with the truncation classes so
    // it ellipsizes within the flex min-w-0 lead track rather than overflowing.
    const link = screen.getByRole("link", { name: LONG_MCP_NAME });
    expect(link.className).toContain("truncate");
    expect(link.className).toContain("min-w-0");
    // block-level so `truncate` actually clamps (an inline anchor would not).
    expect(link.className).toContain("block");
  });

  it("exposes the full name via the design-system tooltip (accessible on focus)", () => {
    renderTable(
      [makeComponent({ id: "uuid-mcp-2", name: LONG_MCP_NAME })],
      true
    );

    // Full value carried in the tooltip content — hover/focus reveals it.
    expect(nameTooltipContent()).toHaveTextContent(LONG_MCP_NAME);
  });

  it("keeps the Type value in its own column, un-overlapped by the name", () => {
    renderTable(
      [makeComponent({ id: "uuid-mcp-3", name: LONG_MCP_NAME })],
      true
    );

    // The Type value ("MCP tool") renders distinctly from the name link; the
    // fixed Type track owns its space.
    expect(screen.getByText("MCP tool")).toBeInTheDocument();

    // Scope to the actual DATA row via the rendered name, not a bare
    // `.grid[style]` (which also matches the header row). Mirrors the sibling
    // synced-sessions-table suite's `.closest('.group.grid')` pattern.
    const link = screen.getByRole("link", { name: LONG_MCP_NAME });
    const row = link.closest<HTMLElement>(".group.grid");
    expect(row).not.toBeNull();
    // The row uses a fixed grid template that gives the Type column its own
    // 96px track (FEA-4248 tightened it from 132px so the flexible lead reclaims
    // the space) — not `auto`/content-sized — so the name cannot grow into it.
    expect(row?.style.gridTemplateColumns).toContain("96px");
    // And the Type cell is a real, separate grid cell keyed to the Type column,
    // so the value lives in its own track rather than under the name.
    expect(row?.querySelector('[data-column-id="type"]')).not.toBeNull();
  });

  it("renders the centralized Type label treatment in the expanded grid", () => {
    renderTable([
      makeComponent({
        id: "uuid-skill-type",
        kind: AgentComponentKind.Skill,
        name: "Skill Component",
      }),
    ]);

    const name = screen.getByRole("button", { name: "Skill Component" });
    const row = name.closest<HTMLElement>(".group.grid");
    const typeCell = row?.querySelector<HTMLElement>('[data-column-id="type"]');
    const label = typeCell?.querySelector<HTMLElement>(
      ".text-muted-foreground"
    );
    const icon = typeCell?.querySelector("svg");

    expect(typeCell).not.toBeNull();
    expect(label).toHaveTextContent("Skill");
    expect(label).toHaveClass("gap-1.5", "text-xs", "font-medium");
    expect(icon).toHaveClass("size-3.5", "shrink-0");
  });

  it("truncates even when no href is supplied, with a keyboard-focusable trigger", () => {
    renderTable(
      [makeComponent({ id: "uuid-mcp-4", name: LONG_MCP_NAME })],
      false
    );

    // No link in this mode; the name is a natively-focusable tooltip trigger
    // (a real element, not a tabIndex-on-a-plain-span) carrying the truncation
    // classes. Select it by its trigger slot (the mocked tooltip content also
    // carries the name, so plain getByText would match both).
    expect(
      screen.queryByRole("link", { name: LONG_MCP_NAME })
    ).not.toBeInTheDocument();
    const trigger =
      nameTooltipContent().parentElement?.querySelector<HTMLElement>(
        '[data-slot="tooltip-trigger"]'
      );
    expect(trigger).not.toBeNull();
    expect(trigger).toHaveTextContent(LONG_MCP_NAME);
    // Actually a focusable element: the non-asChild trigger is a native
    // <button> (keyboard-focusable by default), not a tabIndex-on-a-plain-span.
    expect(trigger?.tagName).toBe("BUTTON");
    expect(trigger?.tabIndex).not.toBe(-1);
    expect(trigger?.className).toContain("truncate");
    expect(trigger?.className).toContain("min-w-0");
    // Full name still reachable via the tooltip.
    expect(nameTooltipContent()).toHaveTextContent(LONG_MCP_NAME);
  });
});

describe("AgentsTable name lead navigation — FEA-4018", () => {
  it("renders the name as a link to the per-component detail href", () => {
    render(
      <AgentsTable
        getComponentHref={(item) => `/agents/${encodeURIComponent(item.slug)}`}
        items={[
          makeComponent({ id: "nav-1", slug: "mcp::nav-1", name: "My Agent" }),
        ]}
        metricMode={AgentMetricMode.LocPerDollar}
        onSort={() => {
          // no-op
        }}
        sortBy="name"
        sortDir="asc"
      />,
      { wrapper: AppCoreStoryProviders }
    );

    const link = screen.getByRole("link", { name: "My Agent" });
    expect(link).toHaveAttribute("href", "/agents/mcp%3A%3Anav-1");
  });

  // Regression for the desktop dead-click (FEA-4018): the name lead was a raw
  // `<a href>`, which the desktop renderer's hash-store navigation adapter does
  // not intercept (and the Electron nav guard blocks the raw document
  // navigation to `/agents/…`), so clicking the name was a no-op on desktop.
  // Routing through the surface-agnostic `@repo/navigation` `Link` drives the
  // active adapter on a plain left-click. Assert the adapter's real navigation
  // state changed — the same behavior both surfaces share — not just the href.
  it("drives the navigation adapter when the name is clicked (not a raw anchor)", () => {
    const nav = createMemoryNavigation({ initialPath: "/agents" });
    render(
      <NavigationProvider adapter={nav.adapter}>
        <AgentsTable
          getComponentHref={(item) =>
            `/agents/${encodeURIComponent(item.slug)}`
          }
          items={[
            makeComponent({
              id: "nav-2",
              slug: "mcp::nav-2",
              name: "My Agent",
            }),
          ]}
          metricMode={AgentMetricMode.LocPerDollar}
          onSort={() => {
            // no-op
          }}
          sortBy="name"
          sortDir="asc"
        />
      </NavigationProvider>
    );

    fireEvent.click(screen.getByRole("link", { name: "My Agent" }));

    expect(nav.getCurrentHref()).toBe("/agents/mcp%3A%3Anav-2");
    expect(nav.getHistory()).toContain("/agents/mcp%3A%3Anav-2");
  });
});

describe("AgentsTable low-variance collapse — FEA-3968", () => {
  it("renders the Type as a plain colored label, not a filled badge", () => {
    renderTable([
      makeComponent({ id: "t1", name: "one", kind: AgentComponentKind.Tool }),
      makeComponent({
        id: "t2",
        name: "two",
        kind: AgentComponentKind.Command,
      }),
    ]);
    // "Tool" reads as a plain colored text span (truncate + text tone class),
    // never boxed in a rounded-full Badge.
    const label = screen.getByText("Tool");
    expect(label.className).toContain("truncate");
    expect(label.className).not.toContain("rounded-full");
  });

  // FEA-4248: Type is a canonical categorical column, so it is exempt from the
  // low-variance collapse — a constant kind down every row keeps the column and
  // its grid track instead of dropping it, for a stable column set across kind
  // tabs. (This inverts the pre-FEA-4248 behavior, which dropped a constant Type
  // column.)
  it("keeps the Type column even when every visible row is the same kind", () => {
    renderTable([
      makeComponent({ id: "t1", name: "one", kind: AgentComponentKind.Tool }),
      makeComponent({ id: "t2", name: "two", kind: AgentComponentKind.Tool }),
    ]);
    // Constant "Tool" across the page ⇒ the Type column stays (canonical column
    // exemption): its sortable header button and its "Tool" cells both render.
    expect(screen.getByRole("button", { name: "Type" })).toBeInTheDocument();
    expect(screen.getAllByText("Tool").length).toBeGreaterThan(0);
  });

  // FEA-4248 core regression (wongk): the production failure shape is a constant
  // Harness through the FULL table path — on `?kind=skill` every skill shares one
  // Harness value, so the Harness column used to collapse entirely (column AND
  // grid track gone), reading as missing data and diverging from the other kind
  // tabs. The canonical-column exemption must keep Harness present — header, grid
  // track, AND value cells — when its value is constant across every visible row.
  // This renders the real `AgentsTable`, not the collapse helper in isolation.
  it("keeps the Harness column and its value cells when every visible row shares one harness", () => {
    renderTable([
      makeComponent({
        id: "h1",
        name: "one",
        kind: AgentComponentKind.Tool,
        harness: Harness.Claude,
      }),
      makeComponent({
        id: "h2",
        name: "two",
        kind: AgentComponentKind.Command,
        harness: Harness.Claude,
      }),
    ]);
    // The sortable header button survives (the column was not dropped).
    const header = screen.getByRole("button", { name: "Harness" });
    expect(header).toBeInTheDocument();
    // And the value survives down every DATA row — the collapse would have taken
    // the cells + grid track with the header. Scope to the "harness"-keyed data
    // cells (not the header) so this asserts the full-path render, not just the
    // header's presence. Harness.Claude renders the "Claude" HarnessBadge label.
    const harnessCells = document.querySelectorAll<HTMLElement>(
      '.group.grid [data-column-id="harness"]'
    );
    expect(harnessCells.length).toBe(2);
    for (const cell of harnessCells) {
      expect(cell).toHaveTextContent("Claude");
    }
    // The Harness grid track survives too: the fixed 120px column is still in the
    // data row's template, so the value has a column to live in rather than
    // vanishing (collapse would have dropped the track along with the header).
    const row = harnessCells[0].closest<HTMLElement>(".group.grid");
    expect(row?.style.gridTemplateColumns).toContain("120px");
  });

  // FEA-4248: Source is canonical too — a single-repo page (every row from the
  // same source) keeps the Source column rather than dropping it.
  it("keeps the Source column when every visible row shares one source", () => {
    renderTable([
      makeComponent({
        id: "src1",
        name: "one",
        kind: AgentComponentKind.Tool,
        sourceType: SourceType.Repo,
        source: "repo-a",
      }),
      makeComponent({
        id: "src2",
        name: "two",
        kind: AgentComponentKind.Command,
        sourceType: SourceType.Repo,
        source: "repo-a",
      }),
    ]);
    expect(screen.getByRole("button", { name: "Source" })).toBeInTheDocument();
  });

  it("keeps the Type column when the kind varies across rows", () => {
    renderTable([
      makeComponent({ id: "t1", name: "one", kind: AgentComponentKind.Tool }),
      makeComponent({
        id: "t2",
        name: "two",
        kind: AgentComponentKind.Command,
      }),
    ]);
    expect(screen.getByRole("button", { name: "Type" })).toBeInTheDocument();
    expect(screen.getByText("Tool")).toBeInTheDocument();
    expect(screen.getByText("Command")).toBeInTheDocument();
  });

  it("keeps a uniform metric column — an all-zero LOC / $ is an answer, not an absence", () => {
    // FEA-3968 (reviewer): the user picked the metric from the metric-mode
    // control, so a column of zeros is the answer they asked to see. It must NOT
    // collapse the way a repeated categorical label does.
    renderTable([
      makeComponent({
        id: "m1",
        name: "one",
        kind: AgentComponentKind.Tool,
        locPerDollar: 0,
      }),
      makeComponent({
        id: "m2",
        name: "two",
        kind: AgentComponentKind.Command,
        locPerDollar: 0,
      }),
    ]);
    expect(screen.getByRole("button", { name: "LOC / $" })).toBeInTheDocument();
  });

  it("never collapses the active sort column even when it is constant", () => {
    // FEA-3968 (wongk): sorting runs before pagination, so a column can go
    // constant on the current page while the persisted sort still controls which
    // bucket shows. Dropping its header would strand the user with no way to
    // reverse the sort — so a constant sort column must stay.
    render(
      <AgentsTable
        items={[
          makeComponent({
            id: "s1",
            name: "one",
            kind: AgentComponentKind.Tool,
          }),
          makeComponent({
            id: "s2",
            name: "two",
            kind: AgentComponentKind.Tool,
          }),
        ]}
        metricMode={AgentMetricMode.LocPerDollar}
        onSort={() => {
          // no-op
        }}
        sortBy="type"
        sortDir="asc"
      />,
      { wrapper: AppCoreStoryProviders }
    );
    // Type is constant "Tool" AND the active sort column ⇒ kept, so the sort
    // header (which reverses the sort) is still reachable.
    expect(screen.getByRole("button", { name: "Type" })).toBeInTheDocument();
  });
});

describe("AgentsTable column reorder — FEA-4021", () => {
  // Two rows whose categorical columns all differ so the FEA-3968 low-variance
  // collapse (which needs 2+ constant rows) never drops a column under test.
  const rowA = makeComponent({
    id: "r-a",
    name: "alpha",
    kind: AgentComponentKind.Tool,
    source: "repo-a",
    harness: Harness.Claude,
  });
  const rowB = makeComponent({
    id: "r-b",
    name: "beta",
    kind: AgentComponentKind.Command,
    source: "repo-b",
    harness: Harness.Codex,
  });

  function renderReorderable(
    onColumnOrderChange: (order: string[]) => void,
    columnOrder?: string[]
  ) {
    return render(
      <AgentsTable
        columnOrder={columnOrder}
        items={[rowA, rowB]}
        metricMode={AgentMetricMode.LocPerDollar}
        onColumnOrderChange={onColumnOrderChange}
        onSort={() => {
          // no-op
        }}
        sortBy="name"
        sortDir="asc"
      />,
      { wrapper: AppCoreStoryProviders }
    );
  }

  it("renders a keyboard-operable drag handle per reorderable data column", () => {
    renderReorderable(() => {
      // no-op
    });
    // The Type header column exposes an accessibly-named reorder control.
    expect(
      screen.getByRole("button", { name: RE_REORDER_TYPE })
    ).toBeInTheDocument();
    // Every reorder handle names a real column label; the always-on actions
    // column (empty label, absent from the order) never gets one.
    const handles = screen.getAllByRole("button", { name: RE_REORDER_HANDLE });
    expect(handles.length).toBeGreaterThan(0);
    for (const handle of handles) {
      expect(handle.getAttribute("aria-label")).not.toBe(
        "Reorder  column, use arrow keys"
      );
    }
  });

  it("emits a new column order when a handle is moved right via keyboard", () => {
    const emitted: string[][] = [];
    renderReorderable((order) => {
      emitted.push(order);
    });
    const typeHandle = screen.getByRole("button", { name: RE_REORDER_TYPE });
    // `fireEvent` returns false when the handler called preventDefault, which it
    // must so the arrow key does not ALSO scroll the table sideways.
    const notPrevented = fireEvent.keyDown(typeHandle, { key: "ArrowRight" });
    expect(notPrevented).toBe(false);
    // Type leads the default data order; ArrowRight swaps it past its right
    // neighbour. ISS-5366 moved Metric down beside the counts, so that
    // neighbour is now Authors (`collaborators`) rather than `metric`.
    expect(emitted).toHaveLength(1);
    expect(emitted[0].slice(0, 2)).toEqual(["collaborators", "type"]);
  });

  it("keeps a hidden column in the emitted order when the visible subset is reordered", () => {
    // "metric" is hidden, so the header renders [type, collaborators, ...] and
    // can only reorder that subset. The emitted order must still carry "metric"
    // in its natural slot — not drop it or append it at the end — so re-showing
    // it later restores its position (FEA-4021). ISS-5366 moved that slot to the
    // head of the numeric block, so the assertion below pins Metric to the
    // column it must stay adjacent to (Invocations) rather than to a magic
    // index that has now moved once.
    const emitted: string[][] = [];
    render(
      <AgentsTable
        items={[rowA, rowB]}
        metricMode={AgentMetricMode.LocPerDollar}
        onColumnOrderChange={(order) => emitted.push(order)}
        onSort={() => {
          // no-op
        }}
        sortBy="name"
        sortDir="asc"
        visibleColumns={
          new Set([
            "type",
            "collaborators",
            "source",
            "harness",
            "invocations",
            "sessions",
          ])
        }
      />,
      { wrapper: AppCoreStoryProviders }
    );
    const typeHandle = screen.getByRole("button", { name: RE_REORDER_TYPE });
    fireEvent.keyDown(typeHandle, { key: "ArrowRight" });
    expect(emitted).toHaveLength(1);
    // The full data order is emitted (every COLUMN_SPECS id), with the hidden
    // "metric" still in its canonical slot at the head of the numeric block,
    // and the visible move applied.
    expect(emitted[0]).toContain("metric");
    expect(emitted[0].indexOf("metric")).toBe(
      emitted[0].indexOf("invocations") - 1
    );
    expect(emitted[0].indexOf("collaborators")).toBeLessThan(
      emitted[0].indexOf("type")
    );
  });

  it("renders data columns in the persisted order (metric before type)", () => {
    renderReorderable(() => {
      // no-op
    }, ["metric", "type"]);
    const headerEl = screen.getByText("Component").closest("div.grid");
    expect(headerEl).not.toBeNull();
    const cells = [
      ...(headerEl as Element).querySelectorAll("[data-column-id]"),
    ].map((cell) => cell.getAttribute("data-column-id"));
    // Metric now precedes Type in DOM order (the persisted order won).
    expect(cells).toContain("metric");
    expect(cells).toContain("type");
    expect(cells.indexOf("metric")).toBeLessThan(cells.indexOf("type"));
  });
});

describe("AgentsTable Versions column — FEA-4267 collapsed-family count", () => {
  it("renders the count in its own column at value scale for a prompt-kind family", () => {
    // A subagent (a PROMPT_KIND with a version dropdown on its detail page) with
    // 5 collapsed versions: the count lands in the Versions column, not the name
    // lead, and reads at value scale (text-sm) to match Invocations/Sessions.
    renderTable([
      makeComponent({
        id: "fam-multi",
        name: "cl-produce",
        kind: AgentComponentKind.Subagent,
        versionCount: 5,
      }),
    ]);

    // Column header present, and the value renders in a body cell.
    expect(screen.getByText("Versions")).toBeInTheDocument();
    const signal = screen.getByTestId("agent-version-count");
    expect(signal).toHaveTextContent("5");
    // Value scale, muted — matches the other count cells, NOT the text-xs label
    // scale the field labels use.
    expect(signal.className).toContain("text-sm");
    expect(signal.className).toContain("text-muted-foreground");
    expect(signal.className).not.toContain("text-xs");
  });

  it("hides the count for a multi-version family whose kind has no version dropdown", () => {
    // An mcp family with 5 collapsed versions: its detail page renders no Prompt
    // panel / version selector, so the catalog must NOT promise "N versions"
    // (a count with no destination). With no other qualifying row, the whole
    // Versions column is dropped too.
    renderTable([
      makeComponent({
        id: "mcp-fam",
        name: "mcp-family",
        kind: AgentComponentKind.Mcp,
        versionCount: 5,
      }),
    ]);

    expect(screen.queryByTestId("agent-version-count")).toBeNull();
    expect(screen.queryByText("Versions")).toBeNull();
  });

  it("drops the Versions column entirely when no visible row is a family", () => {
    renderTable([
      makeComponent({
        id: "single",
        name: "solo-skill",
        kind: AgentComponentKind.Skill,
      }),
    ]);

    expect(screen.queryByTestId("agent-version-count")).toBeNull();
    expect(screen.queryByText("Versions")).toBeNull();
  });

  it("omits the count when versionCount is 1 (single version)", () => {
    // Defensive: even if a server ever sent an explicit 1, the row is a single
    // version and must not show the count — and the column collapses out.
    renderTable([
      makeComponent({
        id: "one",
        name: "one-version",
        kind: AgentComponentKind.Command,
        versionCount: 1,
      }),
    ]);

    expect(screen.queryByTestId("agent-version-count")).toBeNull();
    expect(screen.queryByText("Versions")).toBeNull();
  });

  it("shows the count for a qualifying row even when a non-qualifying family shares the page", () => {
    // Column appears because at least one row qualifies (the subagent); the mcp
    // family in the same page renders an empty cell, never a phantom count.
    renderTable([
      makeComponent({
        id: "sub-fam",
        name: "cl-produce",
        kind: AgentComponentKind.Subagent,
        versionCount: 4,
      }),
      makeComponent({
        id: "mcp-fam",
        name: "mcp-family",
        kind: AgentComponentKind.Mcp,
        versionCount: 9,
      }),
    ]);

    expect(screen.getByText("Versions")).toBeInTheDocument();
    const signals = screen.getAllByTestId("agent-version-count");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toHaveTextContent("4");
  });
});
