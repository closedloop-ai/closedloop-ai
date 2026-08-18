import {
  type AgentComponent,
  AgentComponentKind,
  AgentMetricMode,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { LOC_PER_DOLLAR_LABEL } from "@repo/api/src/utils/loc-per-dollar";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { AgentsTable, LOC_PER_DOLLAR_COLUMN_TOOLTIP } from "../agents-table";

/**
 * ISS-5475 — the LOC/$ column renders its value in the DEFAULT text colour.
 *
 * The deleted `locPerDollarToneClass` graded every figure emerald/amber/rose off
 * a `LOC_PER_DOLLAR_BASELINE` of 4.1 that its own comment conceded was
 * "prototype-derived, not measured". Real catalog rows are ~1–3, so effectively
 * every row rendered rose and the column read as a solid stripe of red — "every
 * component is bad" — from a threshold that was never calibrated to the data.
 *
 * Every case asserts BOTH halves of the contract together: that the row's number
 * is actually on screen, AND that nothing carrying it takes a palette tone class.
 * Asserting only the absence would pass vacuously on an empty cell, which is
 * exactly the state the `—` case below renders on purpose.
 *
 * ISS-5366 (landed on main first) retired `agents-loc-per-dollar-display` to its
 * enabled state and deleted the adaptive `LocPerDollarValue` the flag used to
 * alternate with, so there is one cell to cover rather than two arms — the tone
 * this asserts the absence of had ridden BOTH of those call sites.
 */

// The sd3 Tooltip renders in a portal that never mounts in jsdom; mock it so the
// name-lead trigger stays inline, matching the sibling suites.
vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

/** The palette families the removed classifier painted the column with. */
const TONE_PALETTE_FAMILIES = ["emerald", "amber", "rose"] as const;

/**
 * A mid-range catalog value, rendered `2.50` by the column's fixed 2dp. The
 * assertions below are about the COLOUR, not about the precision (which
 * `loc-per-dollar-column-precision` covers).
 */
const CATALOG_LOC_PER_DOLLAR = 2.5;
const CATALOG_LOC_PER_DOLLAR_TEXT = "2.50";

/** The dash the column renders for a genuinely unavailable value (ISS-5333). */
const EMPTY_VALUE_GLYPH = "—";
const ALIGN_END_CLASS = "ml-auto";
const METRIC_COLUMN_ID = "metric";

/**
 * The shape of a stated baseline comparison ("LOC / $ vs 4.1", "vs 4.1K").
 *
 * Deliberately NOT "the header contains no digit at all" (VQA): that would also
 * block a genuinely MEASURED baseline landing here later, which is exactly where
 * this should eventually go. What is being rejected is an uncalibrated constant
 * painted onto the column, not every numeral.
 */
const STATED_BASELINE_COMPARISON = /\bvs\b\s*[\d.]/i;

/** The specific retired constant, which must not reappear anywhere on screen. */
const RETIRED_BASELINE_TEXT = "4.1";

function makeComponent(
  overrides: Partial<AgentComponent> = {}
): AgentComponent {
  return {
    id: "uuid-default",
    slug: "subagent::uuid-default",
    name: "acme/refactor-agent",
    kind: AgentComponentKind.Subagent,
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

function renderTable({
  items = [makeComponent()],
  mode = "expanded",
}: {
  items?: AgentComponent[];
  mode?: "compact" | "expanded";
} = {}) {
  return render(
    <AppCoreStoryProviders>
      <AgentsTable
        items={items}
        metricMode={AgentMetricMode.LocPerDollar}
        mode={mode}
        onSort={vi.fn()}
        sortBy="name"
        sortDir="asc"
      />
    </AppCoreStoryProviders>
  );
}

/**
 * True when the cell or ANYTHING inside it applies one of the retired palette
 * families. Scanning the whole subtree matters: a tone class re-added on a
 * wrapper rather than on the text span would still repaint the column, and an
 * assertion pinned to the text node alone would not see it.
 */
function hasToneClass(cell: HTMLElement): boolean {
  const nodes = [cell, ...cell.querySelectorAll<HTMLElement>("*")];
  return nodes.some((node) => {
    const className = node.getAttribute("class") ?? "";
    return TONE_PALETTE_FAMILIES.some((family) => className.includes(family));
  });
}

/** A Metric-column cell, by the role + column id the grid stamps on it. */
function metricCell(
  container: HTMLElement,
  role: "cell" | "columnheader"
): HTMLElement {
  const cell = container.querySelector<HTMLElement>(
    `[role="${role}"][data-column-id="${METRIC_COLUMN_ID}"]`
  );
  if (!cell) {
    throw new Error(`No ${role} for column "${METRIC_COLUMN_ID}"`);
  }
  return cell;
}

describe("LOC/$ renders in the default text colour (ISS-5475)", () => {
  it("renders a real value with no tone class", () => {
    const { container } = renderTable();

    const cell = metricCell(container, "cell");
    // Non-vacuous: the number is genuinely on screen before the absence is read.
    expect(
      within(cell).getByText(CATALOG_LOC_PER_DOLLAR_TEXT)
    ).toBeInTheDocument();
    expect(hasToneClass(cell)).toBe(false);
  });

  it("states no uncalibrated baseline in the column header", () => {
    // The prototype puts its baseline in the header instead of a per-row tone.
    // Production deliberately does NOT back-port that half: 4.1 is an unmeasured
    // figure no real row (~1–3) reaches, so "LOC / $ vs 4.1" would only relocate
    // the same uncalibrated verdict from the row to the header. (VQA confirmed
    // the mirror image in the prototype: every mock row CLEARS its 4100, so that
    // header states a bar nothing fails — equally uninformative.) The measured
    // comparator production does have is the summary card's "avg across N
    // components", which sits directly above this table.
    const { container } = renderTable();

    const header = metricCell(container, "columnheader");
    const headerText = header.textContent ?? "";
    expect(header).toHaveTextContent(LOC_PER_DOLLAR_LABEL);
    expect(headerText).not.toMatch(STATED_BASELINE_COMPARISON);
    expect(headerText).not.toContain(RETIRED_BASELINE_TEXT);
  });

  it("explains the metric in the column header", () => {
    // The counterpart to the assertion above: having refused the prototype's
    // baseline, the header must still tell a first-time reader what 2.50 means.
    // That sentence used to ride `POLISHED_METRIC_HEADER`, the ALIGNMENT delta.
    // It now sits on the base `COLUMN_SPECS` metric entry, single-sourced with
    // the label it explains: copy on a header is not alignment polish, and
    // keeping the two in one place is what stops a later change to the delta
    // taking the explanation with it.
    const { container } = renderTable();

    const header = metricCell(container, "columnheader");
    expect(within(header).getByTestId("tooltip-content")).toHaveTextContent(
      LOC_PER_DOLLAR_COLUMN_TOOLTIP
    );
  });

  it("leaves the unavailable dash and its alignment unchanged", () => {
    // ISS-5333 / ISS-5363: the `—` and its right-alignment (unconditional since
    // ISS-5366 retired the display flag) are a separate contract this change
    // must not disturb.
    const { container } = renderTable({
      items: [makeComponent({ locPerDollar: null })],
    });

    const cell = metricCell(container, "cell");
    expect(within(cell).getByText(EMPTY_VALUE_GLYPH)).toHaveClass(
      ALIGN_END_CLASS
    );
    expect(hasToneClass(cell)).toBe(false);
  });
});

/**
 * ISS-5475 (review cid 3737914557) — the narrow card names the unit.
 *
 * The card has no column header to fall back on, and with the per-row tone gone
 * the value lost the last thing marking it as a measurement: it rendered as a
 * bare "2.50" beside the "Subagent" Type chip, reading as more chip metadata.
 * The label makes it a metric again, and it is the SHARED
 * {@link LOC_PER_DOLLAR_LABEL} so the card and the grid header cannot drift.
 */
describe("LOC/$ on the narrow card carries its unit (ISS-5475)", () => {
  it("labels the value in the card header", () => {
    renderTable({ mode: "compact" });

    const label = screen.getByText(LOC_PER_DOLLAR_LABEL);
    expect(label).toBeInTheDocument();
    // Non-vacuous: the label sits with the number it names, not adrift in the
    // card. They share the one wrapper the header renders for the pair.
    const group = label.parentElement as HTMLElement;
    expect(
      within(group).getByText(CATALOG_LOC_PER_DOLLAR_TEXT)
    ).toBeInTheDocument();
  });

  it("drops the labelled group entirely when the metric is unavailable", () => {
    // The empty metric reaches the card header as the shared `GridEmptyValue`
    // sentinel. Without the `isEmptyCellValue` guard the new label would pin
    // itself in front of it and every unpriced row's header would read
    // "LOC / $ —", where the card BODY drops empty rows on that same test.
    renderTable({
      mode: "compact",
      items: [makeComponent({ locPerDollar: null })],
    });

    expect(screen.queryByText(LOC_PER_DOLLAR_LABEL)).not.toBeInTheDocument();
    // …and it leaves no unlabelled dash behind in the header either. Body rows
    // may legitimately render `—` (an empty Authors cell does), but those sit in
    // a `<dd>` beside their own `<dt>` label, so they are never anonymous. A
    // metric dash stranded in the header would fail this: it has no `<dd>`.
    for (const dash of screen.queryAllByText(EMPTY_VALUE_GLYPH)) {
      expect(dash.closest("dd")).not.toBeNull();
    }
  });
});
