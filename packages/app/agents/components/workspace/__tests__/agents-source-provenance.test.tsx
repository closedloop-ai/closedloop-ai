import {
  type AgentComponent,
  AgentComponentKind,
  AgentMetricMode,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { ComponentScope } from "@repo/api/src/types/component-scope";
import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY } from "../../../../shared/lib/feature-flags";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { AgentComponentsDataSource } from "../../../data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "../../../data-source/provider";
import { NO_SOURCE_RECORDED_TITLE } from "../../../lib/component-meta";
import { makeComponent, makeDetail } from "../agent-component-fixtures";
import { AgentDetail } from "../agent-detail";
import { AgentsTable } from "../agents-table";

/**
 * ISS-5009 — the Agents Source column must stop echoing the component's own
 * identity key when the producer found no real provenance.
 *
 * Every case asserts BOTH sides of the gate. The flag-OFF assertions are the
 * load-bearing ones: this ships dark under the ISS-4779 closed-by-default
 * policy, so "no change at all with the flag off" is the contract, not a
 * courtesy. A third case covers a server that predates the field entirely
 * (`honestSource === undefined`), where absence must read as "assume `source`
 * is meaningful" rather than as "no provenance".
 *
 * `mode="expanded"` forces the grid so the layout is deterministic in jsdom
 * without a real container-width measurement, matching the sibling suites.
 */

// The sd3 Tooltip renders in a portal that never mounts in jsdom; mock it so the
// name-lead trigger stays inline, matching the sibling suites.
vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

const EM_DASH = "—";
const LOCAL_GLYPH_TITLE = "Local, builder-specific";
const REPO_GLYPH_TITLE = "Checked into a repo";

/**
 * A row WITH real provenance whose legacy `source` is nonetheless the identity
 * key echo — the plan's headline After-case. Its honest projection differs from
 * the legacy pair in BOTH dimensions (the scope token vs the echo, glyph Local
 * vs Repo), which is what makes the flag-off assertions able to fail.
 */
const KEY_ECHO_SOURCE = "skill::python";
const HONEST_SCOPE_SOURCE = ComponentScope.User;

const WITH_PROVENANCE: AgentComponent = makeComponent({
  id: "uuid-skill-1",
  slug: "skill::python",
  name: "Python Expert Skill",
  kind: AgentComponentKind.Skill,
  sourceType: SourceType.Repo,
  source: KEY_ECHO_SOURCE,
  honestSource: {
    hasProvenance: true,
    source: HONEST_SCOPE_SOURCE,
    sourceType: SourceType.Local,
  },
});

/**
 * A row with NO provenance at all: a plugin whose `pack_id`, identity key and
 * name are the same string, so today's Source cell renders a pack dot beside the
 * component's own name — a column of duplicated identifiers presented as
 * provenance. The name and the legacy source are deliberately identical so the
 * flag-on assertion can prove the cell shows an em dash and NOT the name.
 */
const PLUGIN_NAME_ECHO = "code";

const WITHOUT_PROVENANCE: AgentComponent = makeComponent({
  id: "uuid-plugin-1",
  slug: "plugin::code",
  name: PLUGIN_NAME_ECHO,
  kind: AgentComponentKind.Plugin,
  sourceType: SourceType.Pack,
  source: PLUGIN_NAME_ECHO,
  honestSource: {
    hasProvenance: false,
    source: null,
    sourceType: SourceType.Local,
  },
});

/** The same two rows as a server that predates ISS-5009 would send them. */
const OLD_SERVER_ROWS: AgentComponent[] = [
  makeComponent({
    id: WITH_PROVENANCE.id,
    slug: WITH_PROVENANCE.slug,
    name: WITH_PROVENANCE.name,
    kind: WITH_PROVENANCE.kind,
    sourceType: SourceType.Repo,
    source: KEY_ECHO_SOURCE,
  }),
  makeComponent({
    id: WITHOUT_PROVENANCE.id,
    slug: WITHOUT_PROVENANCE.slug,
    name: WITHOUT_PROVENANCE.name,
    kind: WITHOUT_PROVENANCE.kind,
    sourceType: SourceType.Pack,
    source: PLUGIN_NAME_ECHO,
  }),
];

function renderTable({
  flagOn,
  items = [WITH_PROVENANCE, WITHOUT_PROVENANCE],
}: {
  flagOn: boolean;
  items?: AgentComponent[];
}) {
  return render(
    <AppCoreStoryProviders
      enabledFlags={flagOn ? [AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY] : []}
    >
      <AgentsTable
        items={items}
        metricMode={AgentMetricMode.LocPerDollar}
        mode="expanded"
        onSort={vi.fn()}
        sortBy="name"
        sortDir="asc"
      />
    </AppCoreStoryProviders>
  );
}

/**
 * The Source BODY cells, in row order. Scoped to `.group.grid` (the grid's body
 * rows) rather than queried by text because the Metric and Versions cells emit
 * the same em dash, and scoped to `data-column-id` because the header carries
 * the same attribute.
 */
function sourceCells(container: HTMLElement): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>(
      '.group.grid [data-column-id="source"]'
    ),
  ];
}

describe("Agents Source column — provenance honesty (ISS-5009)", () => {
  it("renders the real provenance and its own glyph when enabled", () => {
    const { container } = renderTable({ flagOn: true });
    const [withProvenance] = sourceCells(container);

    // The honest VALUE replaces the identity-key echo...
    expect(withProvenance).toHaveTextContent(HONEST_SCOPE_SOURCE);
    expect(withProvenance).not.toHaveTextContent(KEY_ECHO_SOURCE);
    // ...and the honest sourceType drives the glyph, so the row no longer claims
    // to be checked into a repo it was never in.
    expect(
      within(withProvenance).getByTitle(LOCAL_GLYPH_TITLE)
    ).toBeInTheDocument();
    expect(
      within(withProvenance).queryByTitle(REPO_GLYPH_TITLE)
    ).not.toBeInTheDocument();
  });

  it("renders an explained em dash — not the component name — for a row with no provenance", () => {
    const { container } = renderTable({ flagOn: true });
    const [, withoutProvenance] = sourceCells(container);

    expect(withoutProvenance).toHaveTextContent(EM_DASH);
    // The whole point of the ticket: the Source cell must not restate what the
    // Component column already says.
    expect(withoutProvenance).not.toHaveTextContent(PLUGIN_NAME_ECHO);
    // The title is on the em dash itself — an unexplained em dash would trade
    // one silent lie for another.
    expect(
      within(withoutProvenance).getByTitle(NO_SOURCE_RECORDED_TITLE)
    ).toBeInTheDocument();
    // The component name is still rendered elsewhere in the row (the name lead),
    // so the assertion above is about the CELL, not about the row losing it.
    expect(screen.getAllByText(PLUGIN_NAME_ECHO).length).toBeGreaterThan(0);
  });

  it("renders today's echo for BOTH rows when disabled (the dark launch is a real no-op)", () => {
    const { container } = renderTable({ flagOn: false });
    const [withProvenance, withoutProvenance] = sourceCells(container);

    // The row WITH provenance keeps the legacy echo AND the legacy Repo glyph.
    // Leaking the corrected glyph to a flag-off viewer while keeping the legacy
    // text is the exact ISS-4779 violation this gate exists to prevent, so the
    // glyph is asserted as strictly as the text.
    expect(withProvenance).toHaveTextContent(KEY_ECHO_SOURCE);
    expect(withProvenance).not.toHaveTextContent(HONEST_SCOPE_SOURCE);
    expect(
      within(withProvenance).getByTitle(REPO_GLYPH_TITLE)
    ).toBeInTheDocument();
    expect(
      within(withProvenance).queryByTitle(LOCAL_GLYPH_TITLE)
    ).not.toBeInTheDocument();

    // The row WITHOUT provenance keeps its pack-dot echo — no em dash, no
    // explanation tooltip.
    expect(withoutProvenance).toHaveTextContent(PLUGIN_NAME_ECHO);
    expect(withoutProvenance).not.toHaveTextContent(EM_DASH);
    expect(
      within(withoutProvenance).queryByTitle(NO_SOURCE_RECORDED_TITLE)
    ).not.toBeInTheDocument();
  });

  it("renders today's output for a server that omits honestSource, even with the flag on", () => {
    // Version skew: a new client against an older API. Absence is NOT "no
    // provenance" — it means the producer never computed the projection, so the
    // legacy fields stay authoritative and nothing turns into an em dash.
    const { container } = renderTable({ flagOn: true, items: OLD_SERVER_ROWS });
    const [withProvenance, withoutProvenance] = sourceCells(container);

    expect(withProvenance).toHaveTextContent(KEY_ECHO_SOURCE);
    expect(withoutProvenance).toHaveTextContent(PLUGIN_NAME_ECHO);
    expect(withoutProvenance).not.toHaveTextContent(EM_DASH);
  });
});

// ---------------------------------------------------------------------------
// Detail page — the Properties "Source" row
// ---------------------------------------------------------------------------

function detailSource(detail: ReturnType<typeof makeDetail>) {
  const source: AgentComponentsDataSource = {
    scope: "test-iss-5009-detail",
    list: () => Promise.reject(new Error("list unused in detail tests")),
    detail: () => Promise.resolve(detail),
  };
  return source;
}

function renderDetail({
  flagOn,
  detail,
}: {
  flagOn: boolean;
  detail: ReturnType<typeof makeDetail>;
}) {
  return render(
    <AppCoreStoryProviders
      enabledFlags={flagOn ? [AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY] : []}
    >
      <AgentComponentsDataSourceProvider dataSource={detailSource(detail)}>
        <AgentDetail backHref="/acme/agents" slug={detail.slug} />
      </AgentComponentsDataSourceProvider>
    </AppCoreStoryProviders>
  );
}

/**
 * The VALUE side of the Properties panel's "Source" row. `PropRow` renders a
 * label span and a value container as siblings, so the row is located by its
 * label and the value read off the second child — reading the row's whole text
 * would include the literal word "Source" and mask an empty value.
 */
async function propertiesSourceValue(): Promise<HTMLElement> {
  const label = await screen.findByText("Source");
  const value = label.parentElement?.children[1];
  if (!(value instanceof HTMLElement)) {
    throw new Error("Properties panel rendered no Source row value");
  }
  return value;
}

describe("Agent detail Properties Source row — provenance honesty (ISS-5009)", () => {
  it("renders an explained em dash when enabled and the producer found no provenance", async () => {
    const detail = makeDetail({
      slug: "plugin::code",
      name: PLUGIN_NAME_ECHO,
      kind: AgentComponentKind.Plugin,
      sourceType: SourceType.Pack,
      source: PLUGIN_NAME_ECHO,
      honestSource: {
        hasProvenance: false,
        source: null,
        sourceType: SourceType.Local,
      },
    });

    renderDetail({ flagOn: true, detail });

    const value = await propertiesSourceValue();
    // Without this gate the catalog row shows an em dash while the detail page
    // one click deeper still prints the echo — two screens describing the same
    // component's provenance differently. The detail page uses words ("None
    // recorded") instead of a dash because a labeled two-column Properties row
    // needs to say what it means.
    expect(value).toHaveTextContent("None recorded");
    expect(value).not.toHaveTextContent(PLUGIN_NAME_ECHO);
    expect(
      within(value).getByTitle(NO_SOURCE_RECORDED_TITLE)
    ).toBeInTheDocument();
  });

  it("renders the real provenance when enabled and the producer found some", async () => {
    const detail = makeDetail({
      slug: "skill::python",
      source: KEY_ECHO_SOURCE,
      honestSource: {
        hasProvenance: true,
        source: HONEST_SCOPE_SOURCE,
        sourceType: SourceType.Local,
      },
    });

    renderDetail({ flagOn: true, detail });

    const value = await propertiesSourceValue();
    expect(value).toHaveTextContent(HONEST_SCOPE_SOURCE);
    expect(value).not.toHaveTextContent(KEY_ECHO_SOURCE);
  });

  it("renders today's raw source when disabled", async () => {
    const detail = makeDetail({
      slug: "plugin::code",
      name: PLUGIN_NAME_ECHO,
      kind: AgentComponentKind.Plugin,
      sourceType: SourceType.Pack,
      source: PLUGIN_NAME_ECHO,
      honestSource: {
        hasProvenance: false,
        source: null,
        sourceType: SourceType.Local,
      },
    });

    renderDetail({ flagOn: false, detail });

    const value = await propertiesSourceValue();
    await waitFor(() => expect(value).toHaveTextContent(PLUGIN_NAME_ECHO));
    expect(
      within(value).queryByTitle(NO_SOURCE_RECORDED_TITLE)
    ).not.toBeInTheDocument();
  });
});
