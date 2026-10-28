import {
  type AgentComponent,
  AgentComponentKind,
  AgentMetricMode,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { AGENTS_CARD_ATTRIBUTE_LABELS_FLAG_KEY } from "@repo/api/src/types/agents-card-attribute-labels-flag";
import { LOC_PER_DOLLAR_LABEL } from "@repo/api/src/utils/loc-per-dollar";
import { GRID_EMPTY_VALUE_GLYPH } from "@repo/design-system/components/ui/grid-table-card";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { AgentsTable } from "../agents-table";

/**
 * ISS-5532 — the narrow card NAMES the attributes it promotes into its header.
 *
 * The card has no column header row to read a value against, so a promoted
 * value arrives anonymous: production opened `Tool —`, a type word and a dash,
 * with nothing saying what either was. ISS-5475 already dropped the metric's
 * labelled group when the metric is unavailable, which removed the dash; this
 * covers the other half — every promoted value that DOES render is paired with
 * its own column's label, in the `dt`/`dd` relationship the card body already
 * uses so the pairing is announced (WCAG 1.3.1) and not merely implied by
 * proximity.
 *
 * Every assertion here reads the `<dt>`/`<dd>` PAIR, never the label text alone.
 * A bare `getByText("Type")` would also be satisfied by the grid's own column
 * header — which this same table renders on the wide path — and by any stray
 * occurrence of the word on screen, so it would stay green with the card header
 * completely unlabelled. Reading the term's own `<dd>` sibling is a locator only
 * the card header can emit.
 */

// The sd3 Tooltip renders in a portal that never mounts in jsdom; mock it so the
// name-lead trigger stays inline, matching the sibling suites.
vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

/**
 * Only THIS gate is driven; every other flag the table reads stays at its
 * shipped default. A blanket `mockReturnValue` would also flip
 * `artifact-cell-primitives`, quietly making each case a two-flag render whose
 * failure could come from either one.
 */
const enabledFlags = vi.hoisted(() => new Set<string>());

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabledOptional: (key: string) => enabledFlags.has(key),
}));

/** The kind word the Type cell renders for a `tool` component. */
const TOOL_KIND_TEXT = "Tool";
/** A mid-range catalog value, rendered `2.50` by the column's fixed 2dp. */
const CATALOG_LOC_PER_DOLLAR = 2.5;
const CATALOG_LOC_PER_DOLLAR_TEXT = "2.50";

function makeComponent(
  overrides: Partial<AgentComponent> = {}
): AgentComponent {
  return {
    id: "uuid-default",
    slug: "tool::uuid-default",
    name: "acme/refactor-agent",
    kind: AgentComponentKind.Tool,
    sourceType: SourceType.Repo,
    source: "repo-a",
    harness: Harness.Claude,
    invocations: 12,
    sessions: 3,
    versionCount: 2,
    locPerDollar: CATALOG_LOC_PER_DOLLAR,
    trend: [],
    collaborators: [],
    computeTargetIds: [],
    firstSeenAt: "2020-01-01T00:00:00.000Z",
    lastSeenAt: "2020-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderCards(items: AgentComponent[] = [makeComponent()]) {
  return render(
    <AppCoreStoryProviders>
      <AgentsTable
        items={items}
        metricMode={AgentMetricMode.LocPerDollar}
        mode="compact"
        onSort={vi.fn()}
        sortBy="name"
        sortDir="asc"
      />
    </AppCoreStoryProviders>
  );
}

/**
 * The same table in its GRID form, so a card term can be compared against the
 * column header naming the same column ON ONE SCREEN. Comparing each of them to
 * a restated `"Type"` literal instead would keep passing through exactly the
 * drift the card is supposed to make impossible: hard-code the card's term and
 * rename the column to "Kind", and both halves still match their own copy of the
 * string while the two surfaces now disagree.
 */
function renderGrid(items: AgentComponent[] = [makeComponent()]) {
  return render(
    <AppCoreStoryProviders>
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

/** The grid's own header text for `columnId`, as the wide surface renders it. */
function gridColumnHeaderText(
  container: HTMLElement,
  columnId: string
): string {
  const header = container.querySelector<HTMLElement>(
    `[role="columnheader"][data-column-id="${columnId}"]`
  );
  if (!header) {
    throw new Error(`grid renders no column header for "${columnId}"`);
  }
  return header.textContent?.trim() ?? "";
}

/**
 * The card header's definition list, located by the one structural fact that
 * separates it from the card BODY's: the body list is the `dl` inside
 * `card-content`, the header's is the `dl` inside `card-header`. Scoping by the
 * slot rather than by index means a future body column cannot silently satisfy a
 * header assertion.
 */
function cardHeaderList(container: HTMLElement): HTMLElement {
  const list = container.querySelector<HTMLElement>(
    '[data-slot="card-header"] dl'
  );
  if (!list) {
    throw new Error("card header renders no definition list");
  }
  return list;
}

/** The `<dd>` paired with the header term whose text is `term`. */
function headerValueFor(container: HTMLElement, term: string): HTMLElement {
  const list = cardHeaderList(container);
  const dt = within(list).getByText(term);
  const value = dt.nextElementSibling;
  if (!(value instanceof HTMLElement) || value.tagName !== "DD") {
    throw new Error(`header term "${term}" has no paired <dd>`);
  }
  return value;
}

describe("the Agents card names its header attributes (ISS-5532)", () => {
  beforeEach(() => {
    enabledFlags.clear();
    enabledFlags.add(AGENTS_CARD_ATTRIBUTE_LABELS_FLAG_KEY);
  });

  it("names Type with the same word the grid column header uses", () => {
    // Both surfaces of the SAME table, in one test, compared to each other
    // rather than each to a constant — the only shape that can catch the two
    // naming one column two ways.
    const grid = renderGrid();
    const typeColumnLabel = gridColumnHeaderText(grid.container, "type");
    grid.unmount();

    const { container } = renderCards();

    // Non-vacuous on both ends: the grid genuinely named the column, and the
    // value the production defect left anonymous now sits in that term's `<dd>`.
    expect(typeColumnLabel).not.toBe("");
    expect(
      within(headerValueFor(container, typeColumnLabel)).getByText(
        TOOL_KIND_TEXT
      )
    ).toBeInTheDocument();
  });

  it("pairs the metric value with the shared LOC/$ label", () => {
    const { container } = renderCards();

    // The SHARED constant, not a literal: the card and the grid header must name
    // the unit identically, which a restated string here would stop policing.
    expect(
      within(headerValueFor(container, LOC_PER_DOLLAR_LABEL)).getByText(
        CATALOG_LOC_PER_DOLLAR_TEXT
      )
    ).toBeInTheDocument();
  });

  it("leaves no anonymous value in the header when the metric is unavailable", () => {
    // ISS-5475's contract, re-asserted through the new structure: the metric's
    // `—` is produced INSIDE `MetricCell`, so the generic emptiness filter
    // cannot see it and the whole labelled group has to be withheld upstream.
    // Without that, this header would read "LOC / $ —".
    const { container } = renderCards([makeComponent({ locPerDollar: null })]);

    const list = cardHeaderList(container);
    expect(
      within(list).queryByText(LOC_PER_DOLLAR_LABEL)
    ).not.toBeInTheDocument();
    expect(
      within(list).queryByText(GRID_EMPTY_VALUE_GLYPH)
    ).not.toBeInTheDocument();
    // Positive sibling for the two absences above: the header is genuinely
    // rendering its labelled list, with EXACTLY the one surviving pair, so the
    // misses are the metric's own and not an empty container satisfying both
    // queries vacuously.
    expect(within(list).getAllByRole("term")).toHaveLength(1);
    expect(within(list).getByText(TOOL_KIND_TEXT)).toBeInTheDocument();
  });

  it("keeps the header values unnamed when the gate is off", () => {
    enabledFlags.clear();

    const { container } = renderCards();

    // Closed by default (ISS-4779): the card header renders no definition list
    // at all, which is the shipped state this change dark-launches behind.
    expect(container.querySelector('[data-slot="card-header"] dl')).toBeNull();
    // Non-vacuous: the card itself still rendered, and still shows the Type
    // value — the gate withholds the NAMING, not the attribute.
    expect(screen.getByText(TOOL_KIND_TEXT)).toBeInTheDocument();
  });
});
