import {
  type AgentComponent,
  AgentComponentKind,
  type AgentComponentListResponse,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { AGENT_COMPONENT_AUTHORS_LABEL } from "@repo/app/agents/lib/agent-component-authors";
import { invocationsDerivation } from "@repo/app/agents/lib/agents-summary-aggregate";
import { AGENTS_INVOCATIONS_DEDUPE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { AgentComponentsDataSource } from "../../../data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "../../../data-source/provider";
import { AgentsGroupedList } from "../agents-grouped-list";

/**
 * FEA-3985: the Agents summary stat-card strip must keep all four KPI cards
 * reachable at any width. The strip previously was a fixed non-wrapping flex
 * row (4 × w-[260px] shrink-0 = 1088px intrinsic) that clipped the 4th card
 * (Collaborators) past the right edge with no scroll affordance below ~1088px. It now
 * reuses the shared `SummaryCardRow wrapBelow` — the same strip the Sessions
 * list page ships — so the cards wrap into a two-column grid below `md` and
 * pin to the fixed-min-width row at `md+`.
 *
 * Layout wrapping/clipping bounds are a browser concern (JSDOM never lays this
 * out), so they belong in browser-level responsive coverage, not here; this
 * focused case asserts the behavior the strip owns at the component level:
 * every KPI card renders, none is dropped.
 */

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
    id: "uuid-skill-1",
    name: "Python Expert Skill",
    kind: AgentComponentKind.Skill,
  }),
];

// Each summary card renders a MetricCard whose info popover has a unique
// accessible name `About <label>`. That per-card button is unambiguous (a table
// column header like "Invocations" also renders the bare label text below the
// strip), so it identifies the specific card rendered without pinning to layout
// classes or the row container.
const SUMMARY_CARD_LABELS = [
  "Components",
  "Invocations",
  "LOC / $",
  // FEA-4098 (Slice 3): the 4th card counts distinct authors, not owners.
  // FEA-4266: labelled "Authors".
  AGENT_COMPONENT_AUTHORS_LABEL,
] as const;

function testDataSource(items: AgentComponent[]): AgentComponentsDataSource {
  return {
    scope: "test",
    list: () =>
      Promise.resolve({
        items,
        total: items.length,
      } satisfies AgentComponentListResponse),
    detail: () => Promise.reject(new Error("detail unused in summary tests")),
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

describe("AgentsGroupedList summary cards (FEA-3985)", () => {
  it("renders all four summary KPI cards", async () => {
    render(
      <Wrapper dataSource={testDataSource(FIXTURE)}>
        <AgentsGroupedList />
      </Wrapper>
    );

    // Await a resolved ROW (not just the always-rendered card row) so the
    // summary aggregates over the real population — the FIXTURE includes a
    // verifiable subagent, so the LOC/$ card is present, and "Authors"
    // (the previously-clipped 4th card) is asserted alongside the others below.
    await screen.findByText("My Orchestrator Agent");
    for (const label of SUMMARY_CARD_LABELS) {
      expect(
        screen.getByRole("button", { name: `About ${label}` })
      ).toBeInTheDocument();
    }
  });

  // FEA-4052: the LOC/$ card is shown only when the population has at least one
  // verifiable-kind component (only `subagent` today — skill/command are
  // session-level, excluded per wongk PR #3720). A population built solely of
  // non-verifiable kinds (skill/command/mcp/tool/…) HIDES the card rather than
  // render a misleading `0.0`.
  it("shows the LOC/$ card when the population has a verifiable kind (subagent)", async () => {
    render(
      <Wrapper
        dataSource={testDataSource([
          makeComponent({
            id: "uuid-subagent-only",
            name: "My Orchestrator Agent",
            kind: AgentComponentKind.Subagent,
          }),
        ])}
      >
        <AgentsGroupedList />
      </Wrapper>
    );

    // Await the resolved row so the summary reflects the loaded population, then
    // assert the LOC/$ card is present.
    await screen.findByText("My Orchestrator Agent");
    expect(
      screen.getByRole("button", { name: "About LOC / $" })
    ).toBeInTheDocument();
  });

  // FEA-4052 (wongk review): a verifiable-kind component can still legitimately
  // arrive with locPerDollar = null. Kind eligibility is not proof a measurement
  // exists, so the averaged value must stay `—` (unavailable), never collapse an
  // empty sample to a fabricated `0.0`.
  it("shows the LOC/$ card as unavailable (—) when the only verifiable component has no measured ratio", async () => {
    render(
      <Wrapper
        dataSource={testDataSource([
          makeComponent({
            id: "uuid-subagent-null-kloc",
            name: "Unmeasured Agent",
            kind: AgentComponentKind.Subagent,
            locPerDollar: null,
          }),
        ])}
      >
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText("Unmeasured Agent");
    // The card renders (a verifiable kind is present) but shows the dash, not 0.0.
    const klocCard = screen
      .getByRole("button", { name: "About LOC / $" })
      .closest("[data-slot='card']");
    expect(klocCard).not.toBeNull();
    expect(klocCard).toHaveTextContent("—");
    expect(klocCard).not.toHaveTextContent("0.0");
  });

  it("hides the LOC/$ card when every component is a non-verifiable kind", async () => {
    render(
      <Wrapper
        dataSource={testDataSource([
          makeComponent({
            id: "uuid-mcp-1",
            name: "Some MCP Tool",
            kind: AgentComponentKind.Mcp,
            locPerDollar: null,
          }),
          makeComponent({
            id: "uuid-tool-1",
            name: "Grep",
            kind: AgentComponentKind.Tool,
            locPerDollar: null,
          }),
        ])}
      >
        <AgentsGroupedList />
      </Wrapper>
    );

    // Await a resolved row so the summary aggregates over the real (all
    // non-verifiable) population; the unconditional Authors card still
    // renders (FEA-4098 replaced Owners with the authors people-set; FEA-4266
    // renamed the visible label to Authors), but the LOC/$ card is dropped
    // rather than showing a fabricated `0.0`.
    await screen.findByText("Some MCP Tool");
    expect(
      screen.getByRole("button", {
        name: `About ${AGENT_COMPONENT_AUTHORS_LABEL}`,
      })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "About LOC / $" })
    ).not.toBeInTheDocument();
  });
});

/**
 * ISS-5005 (second half): when a summary card is computed over a SMALLER
 * population than the table it sits above, the card has to say which population
 * it used. The production sweep that filed this found "avg across 23 components"
 * over a table reading 2,133 — the number was honest, but nothing in the strip
 * forced it to stay that way, and a headline efficiency figure silently computed
 * on 1.1% of the rows is a metric that does not reconcile with its own view.
 *
 * This is the reconciliation guard for that disclosure: the LOC/$ card names its
 * real averaged sample, and that sample is asserted to actually DIFFER from the
 * Components count in the same strip — so the case cannot pass by the two
 * happening to agree.
 */
describe("AgentsGroupedList summary card population disclosure (ISS-5005)", () => {
  const MEASURED_SUBAGENTS = 2;
  const MIXED_POPULATION: AgentComponent[] = [
    makeComponent({
      id: "uuid-measured-1",
      name: "Measured Agent One",
      kind: AgentComponentKind.Subagent,
      locPerDollar: 2,
    }),
    makeComponent({
      id: "uuid-measured-2",
      name: "Measured Agent Two",
      kind: AgentComponentKind.Subagent,
      locPerDollar: 4,
    }),
    makeComponent({
      id: "uuid-unmeasured-1",
      name: "Grep",
      kind: AgentComponentKind.Tool,
      locPerDollar: null,
    }),
    makeComponent({
      id: "uuid-unmeasured-2",
      name: "Read",
      kind: AgentComponentKind.Tool,
      locPerDollar: null,
    }),
    makeComponent({
      id: "uuid-unmeasured-3",
      name: "Some MCP Tool",
      kind: AgentComponentKind.Mcp,
      locPerDollar: null,
    }),
  ];

  it("names the averaged sample on the LOC/$ card when it is smaller than the Components count", async () => {
    render(
      <Wrapper dataSource={testDataSource(MIXED_POPULATION)}>
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText("Measured Agent One");

    const componentsCard = screen
      .getByRole("button", { name: "About Components" })
      .closest("[data-slot='card']");
    const locPerDollarCard = screen
      .getByRole("button", { name: "About LOC / $" })
      .closest("[data-slot='card']");
    expect(componentsCard).not.toBeNull();
    expect(locPerDollarCard).not.toBeNull();

    // The table's population — every row the filters matched.
    expect(componentsCard).toHaveTextContent(String(MIXED_POPULATION.length));
    // The card's OWN population, stated on the card. Only the two components
    // carrying a measured ratio contribute to the average.
    expect(locPerDollarCard).toHaveTextContent(
      `avg across ${MEASURED_SUBAGENTS} components`
    );
    // The guard that makes this a reconciliation case and not a tautology: the
    // two populations genuinely differ, so the disclosure is load-bearing.
    expect(MEASURED_SUBAGENTS).not.toBe(MIXED_POPULATION.length);
  });

  it("states a single-component sample in the singular, not '1 components'", async () => {
    render(
      <Wrapper
        dataSource={testDataSource([
          makeComponent({
            id: "uuid-lone-measured",
            name: "Lone Measured Agent",
            kind: AgentComponentKind.Subagent,
            locPerDollar: 3,
          }),
          makeComponent({
            id: "uuid-lone-unmeasured",
            name: "Grep",
            kind: AgentComponentKind.Tool,
            locPerDollar: null,
          }),
        ])}
      >
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText("Lone Measured Agent");

    const locPerDollarCard = screen
      .getByRole("button", { name: "About LOC / $" })
      .closest("[data-slot='card']");
    expect(locPerDollarCard).toHaveTextContent("avg across 1 component");
    expect(locPerDollarCard).not.toHaveTextContent("avg across 1 components");
  });

  // ISS-5534: the PRODUCTION wiring for the Invocations de-duplication — the
  // list must actually resolve the flag and thread it into the aggregate.
  // Testing `computeSummaryAggregate` alone would stay green if this component
  // stopped reading the flag entirely.
  //
  // The fixture deliberately gives BOTH the plugin AND its children non-zero
  // invocations: a plugin's 500 IS the 300 + 200 beneath it (the API and the
  // desktop reader both REPLACE a plugin's total with its children's), and on
  // the default "All" tab all three are rows. A childless plugin, or children
  // with zero invocations, would pass identically with and without the fix.
  const PLUGIN_AND_CHILDREN: AgentComponent[] = [
    makeComponent({
      id: "uuid-plugin-1",
      name: "PR Review Toolkit",
      kind: AgentComponentKind.Plugin,
      invocations: 500,
      packIds: ["pr-review-toolkit"],
    }),
    makeComponent({
      id: "uuid-skill-cr",
      name: "Code Review Skill",
      kind: AgentComponentKind.Skill,
      invocations: 300,
      packIds: ["pr-review-toolkit"],
    }),
    makeComponent({
      id: "uuid-cmd-commit",
      name: "Commit Command",
      kind: AgentComponentKind.Command,
      invocations: 200,
      packIds: ["pr-review-toolkit"],
    }),
  ];

  function invocationsCardText() {
    return screen
      .getByRole("button", { name: "About Invocations" })
      .closest("[data-slot='card']");
  }

  it("counts a plugin's invocations once when the dedupe flag is on", async () => {
    render(
      <Wrapper
        dataSource={testDataSource(PLUGIN_AND_CHILDREN)}
        enabledFlags={[AGENTS_INVOCATIONS_DEDUPE_FEATURE_FLAG_KEY]}
      >
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText("PR Review Toolkit");
    const card = invocationsCardText();
    expect(card).toHaveTextContent("500");
    expect(card).not.toHaveTextContent("1,000");
  });

  it("still counts plugin rollups when no child row represents them", async () => {
    // The Plugins-tab shape, driven through the real component: with no
    // skill/command/subagent/mcp row in the population the plugin rollup is the
    // ONLY representation of that activity, so it must still be counted.
    // Dropping it here would report a flat 0 for a plugin with real usage — a
    // worse lie than the double-count this change removes.
    render(
      <Wrapper
        dataSource={testDataSource([
          makeComponent({
            id: "uuid-plugin-only",
            name: "PR Review Toolkit",
            kind: AgentComponentKind.Plugin,
            invocations: 500,
            packIds: ["pr-review-toolkit"],
          }),
        ])}
        enabledFlags={[AGENTS_INVOCATIONS_DEDUPE_FEATURE_FLAG_KEY]}
      >
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText("PR Review Toolkit");
    expect(invocationsCardText()).toHaveTextContent("500");
  });

  it("keeps the prior (double-counted) total when the dedupe flag is off", async () => {
    // Closed-by-default (ISS-4779): with no flag enabled the card must render
    // exactly what it renders today, so nothing changes for any user until the
    // PostHog flag / desktop Labs toggle is lit.
    render(
      <Wrapper dataSource={testDataSource(PLUGIN_AND_CHILDREN)}>
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText("PR Review Toolkit");
    expect(invocationsCardText()).toHaveTextContent("1,000");
  });

  // ISS-6182: the card must EXPLAIN the derivation it actually ran. Under the
  // dedupe gate the total deliberately drops every represented plugin rollup, so
  // the pre-fix literal — a plain per-component sum — contradicted the 500 beside
  // it. Asserting against `invocationsDerivation(...).how` rather than a copied
  // sentence is the point: it fails if the card stops reading the gate, and it
  // cannot be satisfied by restating the copy at the call site.
  async function invocationsInfoText(): Promise<string> {
    const trigger = screen.getByRole("button", { name: "About Invocations" });
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    const dialog = await screen.findByRole("dialog", {
      name: "About Invocations",
    });
    return dialog.textContent ?? "";
  }

  it("says plugin rollups are excluded when the dedupe flag is on", async () => {
    render(
      <Wrapper
        dataSource={testDataSource(PLUGIN_AND_CHILDREN)}
        enabledFlags={[AGENTS_INVOCATIONS_DEDUPE_FEATURE_FLAG_KEY]}
      >
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText("PR Review Toolkit");
    expect(invocationsCardText()).toHaveTextContent("500");
    expect(await invocationsInfoText()).toContain(
      invocationsDerivation(true).how
    );
  });

  it("keeps the plain per-component explainer when the dedupe flag is off", async () => {
    render(
      <Wrapper dataSource={testDataSource(PLUGIN_AND_CHILDREN)}>
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText("PR Review Toolkit");
    const infoText = await invocationsInfoText();
    expect(infoText).toContain(invocationsDerivation(false).how);
    expect(infoText).not.toContain(invocationsDerivation(true).how);
  });
});
