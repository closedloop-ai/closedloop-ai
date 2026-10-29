import {
  type AgentComponent,
  AgentComponentKind,
  type AgentComponentListResponse,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import {
  invocationsDerivation,
  type SummaryAggregate,
} from "@repo/api/src/utils/agent-component-summary-aggregate";
import { AGENT_COMPONENT_AUTHORS_LABEL } from "@repo/app/agents/lib/agent-component-authors";
import { AGENTS_INVOCATIONS_DEDUPE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { AgentComponentsDataSource } from "../../../data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "../../../data-source/provider";
import { AgentsGroupedList } from "../agents-grouped-list";
import { AgentsSummaryCards } from "../agents-summary-cards";

/**
 * FEA-3985: the Agents summary stat-card strip must keep all four KPI cards
 * reachable at any width. The strip previously was a fixed non-wrapping flex
 * row (4 × w-[260px] shrink-0 = 1088px intrinsic) that clipped the 4th card
 * (Collaborators) past the right edge with no scroll affordance below ~1088px. It now
 * spreads the shared metric-band treatment the Sessions and Branches bands use
 * (ISS-9282, `SUMMARY_CARD_SURFACE_BAND_PROPS`): one rank whose own band scrolls
 * sideways when the cards do not fit.
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
    honorsDateWindow: false,
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
  // session-level, excluded per whitlockk PR #3720). A population built solely of
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

  // FEA-4052 (whitlockk review): a verifiable-kind component can still legitimately
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
 * real contributing sample, and that sample is asserted to actually DIFFER from the
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

  // ISS-6409: this path is the browser's LEGACY client-side reduction, which
  // supplies no producer fold, so the card is honestly unavailable here rather
  // than showing a differently-weighted number. The disclosure contract this
  // case was written for — the card naming its own, smaller population — is
  // pinned at render in "LOC/$ caption (ISS-5005 disclosure)" below, against a
  // producer-supplied aggregate.
  it("shows LOC/$ as unavailable when no producer fold supplied it", async () => {
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
    expect(locPerDollarCard).toHaveTextContent("across 0 components");
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
    // ISS-6409: legacy path, so no fold and no measured sample. See the
    // render-level caption cases below for the disclosure itself.
    expect(locPerDollarCard).toHaveTextContent("across 0 components");
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
  // it. Asserting against `invocationsDerivation(...).explain(...)` rather than a
  // copied sentence is the point: it fails if the card stops reading the gate,
  // and it cannot be satisfied by restating the copy at the call site.
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
      invocationsDerivation(true).explain(true).how
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
    expect(infoText).toContain(invocationsDerivation(false).explain(true).how);
    expect(infoText).not.toContain(
      invocationsDerivation(true).explain(true).how
    );
  });

  // ISS-6205: the PRODUCTION wiring for legacy (packIds-less) parentage. A
  // version-skewed producer omits `packIds` everywhere, so this plugin's
  // parentage is unknowable — and the unrelated skill beside it used to be read
  // as proof the plugin was already represented, dropping all 500 of its
  // invocations and rendering a confident "300". The aggregate test alone would
  // stay green if this component ignored the new exactness state.
  const LEGACY_PLUGIN_AND_UNRELATED_CHILD: AgentComponent[] = [
    makeComponent({
      id: "uuid-plugin-legacy",
      name: "Legacy Toolkit",
      kind: AgentComponentKind.Plugin,
      invocations: 500,
    }),
    makeComponent({
      id: "uuid-skill-unrelated",
      name: "Unrelated Skill",
      kind: AgentComponentKind.Skill,
      invocations: 300,
    }),
  ];

  it("says the total may be missing calls when a legacy plugin's rollup is dropped", async () => {
    render(
      <Wrapper
        dataSource={testDataSource(LEGACY_PLUGIN_AND_UNRELATED_CHILD)}
        enabledFlags={[AGENTS_INVOCATIONS_DEDUPE_FEATURE_FLAG_KEY]}
      >
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText("Legacy Toolkit");
    const card = invocationsCardText();
    // The canonical `AgentComponent.packIds` contract fixes the direction: an
    // unreportable parentage degrades to the population-wide heuristic, which
    // may under-count, never to an over-count. So the plugin's 500 is dropped
    // and 300 is what the card shows. What ISS-6205 changes is that the drop is
    // no longer SILENT — the caveat is carried in WORDS in the card's own
    // caption, not a `~` glyph, which reads as "rounded" and which a screen
    // reader does not speak (ISS-6205 design review).
    expect(card).toHaveTextContent("300");
    expect(card).not.toHaveTextContent("800");
    expect(card).toHaveTextContent("some calls may be missing");
    // …and the explainer switches with it, from the same table the number came
    // from. Pinning the inexact sentence here is what stops the card rendering
    // 300 beside copy that claims the excluded rollups were represented by rows
    // in view — the exact-path sentence must be absent, not merely joined.
    const infoText = await invocationsInfoText();
    expect(infoText).toContain(invocationsDerivation(true).explain(false).how);
    expect(infoText).not.toContain(
      invocationsDerivation(true).explain(true).how
    );
  });

  it("leaves the legacy case untouched with the dedupe flag off", async () => {
    render(
      <Wrapper dataSource={testDataSource(LEGACY_PLUGIN_AND_UNRELATED_CHILD)}>
        <AgentsGroupedList />
      </Wrapper>
    );

    await screen.findByText("Legacy Toolkit");
    const card = invocationsCardText();
    // Closed-by-default: the flat sum, and no caveat at all.
    expect(card).toHaveTextContent("800");
    expect(card).toHaveTextContent("across components in view");
    expect(card).not.toHaveTextContent("some calls may be counted twice");
  });
});

/**
 * ISS-5005 / ISS-6409: the LOC/$ caption names the population the figure was
 * folded over.
 *
 * Moved here from the grouped-list cases above when the figure became
 * producer-supplied: those drive the legacy client-side reduction, which no
 * longer computes LOC/$ at all, so they could no longer exercise the caption.
 * The contract did not retire with them — it moved to wherever the aggregate
 * comes from — so it is pinned directly against the card's own props.
 */
describe("LOC/$ caption (ISS-5005 disclosure)", () => {
  function aggregateWith(
    locPerDollar: number | null,
    locPerDollarSampleSize: number
  ): SummaryAggregate {
    return {
      components: 2133,
      invocations: 0,
      locPerDollar,
      locPerDollarSampleSize,
      collaborators: 0,
      hasVerifiableLocPerDollar: true,
      invocationsExact: true,
      invocationsPluginCoverage: new Map(),
    };
  }

  function locPerDollarCardOf(current: SummaryAggregate) {
    render(
      <AgentsSummaryCards
        current={current}
        dedupePluginRollups={false}
        isError={false}
        isLoading={false}
      />
    );
    return screen
      .getByRole("button", { name: "About LOC / $" })
      .closest("[data-slot='card']");
  }

  it("names the folded sample, not the whole population", () => {
    // The production sweep that filed ISS-5005 found a headline efficiency
    // figure computed over 1.1% of the rows with nothing on the card saying so.
    const card = locPerDollarCardOf(aggregateWith(30.26, 23));

    expect(card).toHaveTextContent("across 23 components");
    // Load-bearing: the folded sample and the component count genuinely differ,
    // so the disclosure is not a tautology.
    expect(card).not.toHaveTextContent("across 2133 components");
  });

  it("states a single-component sample in the singular", () => {
    const card = locPerDollarCardOf(aggregateWith(12, 1));

    expect(card).toHaveTextContent("across 1 component");
    expect(card).not.toHaveTextContent("across 1 components");
  });

  it("says 'across', never 'avg across'", () => {
    // ISS-6409: the card is a ratio of sums folded over the session union, so
    // naming it an average would misstate the statistic.
    expect(locPerDollarCardOf(aggregateWith(30, 5))).not.toHaveTextContent(
      "avg across"
    );
  });
});
