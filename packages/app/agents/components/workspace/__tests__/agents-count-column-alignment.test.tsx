import {
  type AgentComponent,
  AgentComponentKind,
  AgentMetricMode,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { AgentsTable } from "../agents-table";

/**
 * ISS-4973 — right-aligning the three COUNT columns (Invocations / Sessions /
 * Versions) so the `tabular-nums` they already render actually stacks digits.
 *
 * ISS-5366 retired both `agents-count-column-alignment` and
 * `agents-loc-per-dollar-display` to their enabled state, so every case here is
 * unconditional and the flag-off arms are gone. What replaces them as the
 * discriminator is the CARD: the same `renderCell` feeds the grid rows and the
 * narrow card, and the card must keep its inline key/value layout. Those
 * `mode: "compact"` cases are the ones that would fail if the alignment leaked
 * out of the grid-only seam, so they are the counterweight the flag-off arms
 * used to provide.
 *
 * `mode` is forwarded to `GridTable`; `expanded` forces the grid and `compact`
 * forces the narrow card list, so the layout is deterministic in jsdom without a
 * real container-width measurement (the sibling card-fallback suite's contract).
 * That matters here because the alignment is grid-ONLY by design.
 *
 * `enabledFlags={[]}` below is the explicit closed baseline, not a leftover from
 * the retired arms. It is exactly equivalent to omitting the prop —
 * `createStaticFeatureFlagAdapter` reads `options.enabledFlags ?? []` — so there
 * is no permissive provider default here that a flag added to this subtree later
 * could accidentally lean on. It is spelled out rather than dropped so the
 * baseline is a stated choice.
 *
 * That baseline is load-bearing today, not just hypothetically: `SourceLabel`
 * still reads `AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY` (ISS-5009) and renders
 * into the Source column of every row here. It resolves OFF under this harness,
 * matching the closed-by-default posture the product ships with, and the fixture
 * carries no `honestSource`, so the flag-on branch would fall through to the same
 * `SourceValue` anyway. Either way it changes label text, never column geometry,
 * so it cannot mask an alignment regression. A future flag that DOES move
 * geometry owes its own on-arm coverage in its own suite; this one asserts the
 * retired-to-enabled layout, not the flag matrix.
 */

// The sd3 Tooltip renders in a portal that never mounts in jsdom; mock it so the
// name-lead trigger stays inline, matching the sibling suites.
vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

const ALIGN_END_CLASS = "ml-auto";
const INVOCATIONS_COUNT = 1234;
const SESSIONS_COUNT = 8;
const VERSIONS_COUNT = 3;

function makeComponent(
  overrides: Partial<AgentComponent> = {}
): AgentComponent {
  return {
    id: "uuid-default",
    slug: "subagent::uuid-default",
    name: "acme/refactor-agent",
    // A kind with a real version dropdown on its detail page, so the Versions
    // column is not gated out by `hasVersionCountSignal`.
    kind: AgentComponentKind.Subagent,
    sourceType: SourceType.Repo,
    source: "repo-a",
    harness: Harness.Claude,
    invocations: INVOCATIONS_COUNT,
    sessions: SESSIONS_COUNT,
    versionCount: VERSIONS_COUNT,
    locPerDollar: 2.5,
    trend: [],
    collaborators: [],
    computeTargetIds: [],
    firstSeenAt: "2020-01-01T00:00:00.000Z",
    lastSeenAt: "2020-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderTable({
  mode = "expanded",
  items = [makeComponent()],
}: {
  mode?: "compact" | "expanded";
  items?: AgentComponent[];
} = {}) {
  return render(
    <AppCoreStoryProviders enabledFlags={[]}>
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

/** The rendered value span for a formatted count, by its displayed text. */
function countCell(formatted: string): HTMLElement {
  return screen.getByText(formatted);
}

/**
 * The header cell for a column, by the `data-column-id` the grid stamps on it.
 * Scoped to `role="columnheader"` because body cells carry the same attribute —
 * and queried by id rather than by label because `Versions` is not sortable, so
 * it renders no header button to match on.
 */
function columnHeader(container: HTMLElement, columnId: string): HTMLElement {
  const header = container.querySelector<HTMLElement>(
    `[role="columnheader"][data-column-id="${columnId}"]`
  );
  if (!header) {
    throw new Error(`no column header rendered for "${columnId}"`);
  }
  return header;
}

const COUNT_COLUMN_IDS = ["invocations", "sessions", "versions"];

/** The label span inside a header cell — the thing whose position is in question. */
function headerLabel(header: HTMLElement): HTMLElement {
  const label = header.querySelector<HTMLElement>("span");
  if (!label) {
    throw new Error(`header "${header.dataset.columnId}" rendered no label`);
  }
  return label;
}

/**
 * ISS-5333 — does this header's label ACTUALLY end up at the right edge?
 *
 * The assertion this replaces was `expect(header).toHaveClass("justify-end")`,
 * and it passed against markup where the label provably did not move: the class
 * was on the header CELL, but a sortable header wraps its label in a `flex-1`
 * button that consumes the cell, so the cell had no free space left to
 * distribute and `justify-end` was inert. A class being present somewhere in the
 * subtree is not alignment.
 *
 * jsdom has no layout engine — every `getBoundingClientRect()` is 0×0 — so a
 * literal x-position read is not available here (stated explicitly per the
 * ticket rather than quietly reverting to a class check). Instead this EXECUTES
 * the flexbox rule that decides the position, against the real rendered DOM:
 * walking from the label up to the header cell, the first ancestor carrying
 * `justify-end` wins — UNLESS something between the label and that ancestor is
 * itself a `flex-1` child, because then that ancestor has no free space and its
 * `justify-end` distributes nothing.
 *
 * That is the exact predicate the bug violated, so this returns `false` for the
 * pre-fix markup and `true` only when the alignment sits where it can act.
 */
function labelResolvesToEndAligned(header: HTMLElement): boolean {
  const label = headerLabel(header);
  let node: HTMLElement | null = label;
  let growsIntoFreeSpace = false;
  while (node && node !== header.parentElement) {
    if (node !== label && node.classList.contains("justify-end")) {
      // Reached a container that right-aligns its children — it only moves the
      // label if nothing below it already ate this container's free space.
      return !growsIntoFreeSpace;
    }
    if (node.classList.contains("flex-1") || node.classList.contains("grow")) {
      growsIntoFreeSpace = true;
    }
    node = node.parentElement;
  }
  return false;
}

/** The rendered unavailable-value em-dash spans (`GridEmptyValue`). */
function emptyValueGlyphs(): HTMLElement[] {
  return screen.getAllByText("—");
}

const METRIC_COLUMN_ID = "metric";

/**
 * The em-dashes rendered inside the named columns. Scoped by `data-column-id`
 * rather than sweeping every "—" on the page, because a table row also carries
 * dashes in columns that are NOT right-aligned (Collaborators), and asserting
 * alignment on those would be asserting a contract they never had.
 */
function columnGlyphs(columnIds: readonly string[]): HTMLElement[] {
  return emptyValueGlyphs().filter((glyph) => {
    const columnId = glyph
      .closest("[data-column-id]")
      ?.getAttribute("data-column-id");
    return columnId != null && columnIds.includes(columnId);
  });
}

/** The single unavailable em-dash in the Metric column. */
function metricGlyph(): HTMLElement {
  const [glyph] = columnGlyphs([METRIC_COLUMN_ID]);
  if (!glyph) {
    throw new Error("no unavailable dash rendered in the Metric column");
  }
  return glyph;
}

/**
 * Two rows: the Versions column is opt-in per page (FEA-4267), so with no row
 * carrying a version signal the column is dropped entirely and a lone empty row
 * could never prove the Versions dash aligns. The first row keeps the column on
 * the page; the second is the all-unavailable row under test.
 */
function allUnavailableRows(): AgentComponent[] {
  return [
    makeComponent(),
    makeComponent({
      id: "uuid-empty",
      slug: "subagent::uuid-empty",
      name: "acme/never-run-agent",
      invocations: null,
      sessions: null,
      versionCount: undefined,
      locPerDollar: null,
    }),
  ];
}

describe("Agents count-column alignment (ISS-4973)", () => {
  it("right-aligns all three count VALUES on the grid", () => {
    renderTable();

    // All three together — right-aligning one number column while its two
    // numeric siblings stay ragged is the outcome this ticket exists to avoid.
    expect(countCell("1,234")).toHaveClass(ALIGN_END_CLASS);
    expect(countCell(String(SESSIONS_COUNT))).toHaveClass(ALIGN_END_CLASS);
    expect(screen.getByTestId("agent-version-count")).toHaveClass(
      ALIGN_END_CLASS
    );
  });

  it("right-aligns all three count HEADERS", () => {
    const { container } = renderTable();

    // ISS-5333: resolved by the flex rule, not by "a class exists on the cell".
    // A right-aligned column of values under a left-aligned header would be
    // worse than leaving both alone, so the header and the cells are asserted as
    // one contract — and this half now actually checks its half.
    for (const columnId of COUNT_COLUMN_IDS) {
      expect(labelResolvesToEndAligned(columnHeader(container, columnId))).toBe(
        true
      );
    }
    // ISS-5366: the counterfactual the retired flag-off arm used to supply. A
    // predicate that returned `true` for every header would satisfy the loop
    // above and prove nothing, so a column that is deliberately NOT right-
    // aligned is asserted to resolve `false` in the same render.
    expect(labelResolvesToEndAligned(columnHeader(container, "harness"))).toBe(
      false
    );
  });

  it("puts the alignment on the SORT BUTTON for a sortable count header", () => {
    const { container } = renderTable();

    // The regression guard for the specific shape of the bug. `Invocations` is
    // sortable, so its label lives inside the `flex-1` button; the alignment has
    // to be on that button, because on the cell it is unreachable. `Versions` is
    // NOT sortable — a bare span in the cell — which is why it was the one count
    // column that appeared to work, and it must keep working.
    const sortableLabelParent = headerLabel(
      columnHeader(container, "invocations")
    ).parentElement;
    expect(sortableLabelParent?.tagName).toBe("BUTTON");
    // The button must NOT grow into the cell's free space. `flex-1` here is the
    // precise cause of the original bug: it leaves the cell's `justify-end`
    // nothing to distribute. Sized to its content, the cell can align it.
    expect(sortableLabelParent?.classList.contains("flex-1")).toBe(false);

    const staticHeader = columnHeader(container, "versions");
    expect(headerLabel(staticHeader).parentElement).toBe(staticHeader);
    expect(labelResolvesToEndAligned(staticHeader)).toBe(true);
  });

  it("leads the label with the caret and help icon on a right-aligned header", () => {
    // ISS-5333: right-aligning the header is not enough on its own. With the
    // caret and the help icon TRAILING the label, they are what lands on the
    // column's right rail and the LABEL stays inset — measured at 16px on a
    // sortable count column and 34px on Metric, so four adjacent right-aligned
    // columns showed three different label insets. Leading them puts the label
    // itself last in the row, on the same x as the digits beneath it.
    const { container } = renderTable();

    const sortButton = headerLabel(
      columnHeader(container, "invocations")
    ).parentElement;
    if (!sortButton) {
      throw new Error("sortable header rendered no button around its label");
    }
    // The label is the LAST child of the button, so nothing sits between it and
    // the button's (right-aligned) end edge.
    expect(sortButton.lastElementChild).toBe(headerLabel(sortButton));

    // Same for a left-aligned header, in the opposite direction: the label leads
    // and the caret trails, unchanged from what every other table renders.
    const leftAlignedButton = headerLabel(
      columnHeader(container, "harness")
    ).parentElement;
    expect(leftAlignedButton?.firstElementChild).toBe(
      headerLabel(columnHeader(container, "harness"))
    );
  });

  it("keeps the narrow card's inline layout", () => {
    // The same `renderCell` feeds the grid rows AND the card body, so the flag
    // must not reach the card: a card lays these values out as an inline
    // key/value list, where stretching one to the far edge would orphan it from
    // its own label. This is the regression the grid-only seam guards.
    renderTable({ mode: "compact" });

    expect(countCell("1,234")).not.toHaveClass(ALIGN_END_CLASS);
    expect(countCell(String(SESSIONS_COUNT))).not.toHaveClass(ALIGN_END_CLASS);
    expect(screen.getByTestId("agent-version-count")).not.toHaveClass(
      ALIGN_END_CLASS
    );
  });

  it("still renders the unavailable em-dash rather than an aligned zero", () => {
    // Alignment is presentation only. A row with no count keeps the distinct
    // "unavailable" state instead of gaining a fabricated aligned `0`.
    renderTable({
      items: [makeComponent({ invocations: null, sessions: null })],
    });

    expect(emptyValueGlyphs().length).toBeGreaterThan(0);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("right-aligns the unavailable DASH under the three COUNT columns", () => {
    // ISS-5333: `alignEnd` used to be applied only where a number existed, so a
    // row with no counts rendered left-flush dashes under right-flush columns.
    // Position is not value — the dash moving right does not fabricate a zero
    // (asserted above); it puts the "no number" mark where the eye is scanning.
    renderTable({ items: allUnavailableRows() });

    const dashes = columnGlyphs(COUNT_COLUMN_IDS);
    // All three unavailable at once is exactly the row the ticket measured.
    expect(dashes).toHaveLength(COUNT_COLUMN_IDS.length);
    for (const dash of dashes) {
      expect(dash).toHaveClass(ALIGN_END_CLASS);
    }
  });

  it("right-aligns the unavailable METRIC dash alongside its own column", () => {
    // The Metric column is a separate column from the three counts, and its
    // unavailable dash used to be the one part that moved while the header and
    // the real values stayed put. Asserted with the HEADER in the same case, so
    // a dash that right-aligns under a left-aligned header still fails.
    const { container } = renderTable({ items: allUnavailableRows() });

    expect(metricGlyph()).toHaveClass(ALIGN_END_CLASS);
    expect(
      labelResolvesToEndAligned(columnHeader(container, METRIC_COLUMN_ID))
    ).toBe(true);
  });

  it("leaves the unavailable dash inline on the narrow card", () => {
    // Same grid-only seam the values honor: a card lays values out inline beside
    // their labels, where stretching the dash to the far edge would orphan it.
    renderTable({
      mode: "compact",
      items: [makeComponent({ invocations: null, sessions: null })],
    });

    for (const dash of emptyValueGlyphs()) {
      expect(dash).not.toHaveClass(ALIGN_END_CLASS);
    }
  });

  it("renders the unavailable dash at the full muted token, not translucent", () => {
    // ISS-5333 contrast: `GridEmptyValue` shipped as `text-muted-foreground/50`,
    // which computes to 2.24:1 in light (rgb(170,170,170) on rgb(251,251,251))
    // and 2.95:1 in dark — under even the 3:1 non-text floor, for the ONE glyph
    // that distinguishes "no number" from "zero". At the full token it is 6.73:1
    // light / 7.64:1 dark, clearing WCAG 1.4.3's 4.5:1 in both themes.
    renderTable({
      items: [makeComponent({ invocations: null, sessions: null })],
    });

    for (const dash of columnGlyphs([...COUNT_COLUMN_IDS, METRIC_COLUMN_ID])) {
      expect(dash).toHaveClass("text-muted-foreground");
      expect(dash.className).not.toContain("text-muted-foreground/");
    }
  });

  it("renders the header help icon at the full muted token in a 24px hit box", () => {
    // ISS-5333 (review): the same contrast miss as the dash, on the header's
    // help glyph. `HeaderTooltip` painted its icon at `text-muted-foreground/60`,
    // which composites to 2.72:1 light (rgb(154,154,154) on rgb(251,251,251))
    // and 3.67:1 dark — under WCAG 1.4.11's 3:1 floor in light for a glyph that
    // carries meaning. At the full token it is 6.66:1 / 7.69:1, clearing 1.4.3.
    //
    // And it was a bare 14px target while the drag handle and the column menu in
    // this same header row both use a deliberate `size-6` (WCAG 2.5.8). Metric
    // is the column that carries a `tooltip`, so its polish flag drives this.
    const { container } = renderTable();

    const help = columnHeader(container, METRIC_COLUMN_ID).querySelector(
      'button[aria-label$="help"]'
    );
    expect(help).not.toBeNull();
    expect(help).toHaveClass("text-muted-foreground");
    expect(help?.className).not.toContain("text-muted-foreground/");
    // The padded hit area, matching the two sibling controls in this header row.
    expect(help).toHaveClass("size-6");
  });

  it("names the Metric column's real population, not a merged one", () => {
    // ISS-5366 (review cid 3737906515 / 3737914543): retiring
    // `agents-loc-per-dollar-display` makes this tooltip unconditional AND
    // removes the metric-mode picker, so it is now the only thing on screen
    // naming this unit for every user. It said "Lines of code merged per
    // dollar", copied from the Sessions card.
    //
    // This column is not merged-scoped. It renders
    // `AgentComponentRow.locPerDollar`, which
    // `apps/api/app/agent-components/loc-per-dollar.ts` derives from
    // `linesAdded + linesRemoved` over the component's sessions divided by their
    // `estimatedCost`, with no merge predicate in the path. Only the Sessions
    // card's `usage.mergedLocPerDollar` earns the word. A component whose
    // sessions changed 5,000 lines that never merged rendered a healthy number
    // under copy claiming merged output.
    const { container } = renderTable();

    const tooltip = columnHeader(container, METRIC_COLUMN_ID).querySelector(
      '[data-testid="tooltip-content"]'
    );
    expect(tooltip).not.toBeNull();
    // Positive control first: the copy is actually present and reachable, so
    // the negative below cannot pass merely because the query missed.
    expect(tooltip).toHaveTextContent("Lines changed per dollar");
    expect(tooltip?.textContent).not.toContain("merged");
  });

  it("renders the four right-flush numeric columns as one contiguous block", () => {
    // ISS-5366 (review cid 3737914557): right-aligning Metric while it sat at
    // position 3, between Type and Authors, pushed its digits against a
    // left-flush text column while the three columns sharing its alignment sat
    // right-flush at the far end of the row — the same ragged read this suite's
    // own ISS-4973 cases reject for the counts, one level up.
    //
    // Asserted as ADJACENCY over the rendered header order, not as fixed
    // indices: what makes the block read as a block is that nothing left-flush
    // separates the four, and pinning literal positions would re-break this
    // suite on any unrelated column added before them.
    const { container } = renderTable();

    const renderedIds = [
      ...container.querySelectorAll<HTMLElement>(
        '[role="columnheader"][data-column-id]'
      ),
    ].map((header) => header.dataset.columnId);

    const numericBlock = [METRIC_COLUMN_ID, ...COUNT_COLUMN_IDS];
    // Positive control: every column named here is actually on screen, so the
    // adjacency check below cannot pass vacuously on a missing column.
    for (const columnId of numericBlock) {
      expect(renderedIds).toContain(columnId);
    }

    const positions = numericBlock.map((columnId) =>
      renderedIds.indexOf(columnId)
    );
    // Contiguous AND in this order: consecutive positions, no gap for a
    // left-flush column to sit in.
    expect(positions).toEqual(
      positions.map((_value, offset) => positions[0] + offset)
    );
  });
});
