import { BranchProvenance } from "@repo/api/src/types/branch";
import {
  columnBoundariesPx as boundariesForTemplate,
  trackWidthsPx as widthsForTemplate,
} from "@repo/app/test/grid-track-geometry";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { CARD_FALLBACK_BREAKPOINT } from "@repo/design-system/lib/column-order";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SESSIONS_GLANCEABLE_COLUMNS,
  SESSIONS_TOGGLEABLE_COLUMNS,
  sessionsToggleableColumns,
} from "../../../hooks/use-sessions-view-state";
// ISS-4890: the budget (and the canonical column order it governs) moved to the
// dependency-light `sessions-table-columns` module so the persisted-view
// migration can read the same list the table renders by.
import {
  SESSIONS_LEGIBLE_COLUMN_BUDGET_PX,
  SESSIONS_OWNER_COLUMN_WIDTH_PX,
  SESSIONS_UPDATED_COLUMN_ID,
} from "../../../lib/sessions-table-columns";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { SessionsTable, type SessionTableRow } from "../sessions-table";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

/**
 * ISS-5315: the shared Sessions table renders exactly the column set and order
 * the Sessions prototype specifies (`apps/prototypes/app/p/sessions/components/
 * sessions-table.tsx` on `prototype/generic-artifacts-web-master`), so the web
 * app and the desktop renderer cannot drift from it or from each other:
 * Session (lead), Status, Owner, Autonomy, Repository, Linked branches, Harness,
 * Model, Duration, Cost, Last active — then the three columns that ship HIDDEN
 * (PR, Merge, Started), which this component still renders because default
 * visibility is the view state's job, not the table's.
 *
 * This SUPERSEDES FEA-4006's agent-detail-mock order and ISS-4788's promotion of
 * Cost to the third slot. ISS-4788's premise was that a Cost track straddling
 * the viewport edge rendered `$772.3` for a `$772.39` row — a value lie.
 * ISS-4889 removed that failure mode structurally (`snapFoldToColumns`: a column
 * is whole or absent), so the assertions below now pin the invariant that
 * actually protects the figure — no partial column at any width — plus a budget
 * assertion on Status, and pin ISS-5315's own consequence explicitly rather than
 * leaving it to be rediscovered.
 */

const ROW: SessionTableRow = createSessionTableRowFixture({
  autonomy: 88,
  branch: "feature/auth-guard",
  model: "opus-4.8",
  repo: "acme/app",
  status: "Working",
  user: { avatarUrl: null, name: "Parker Byrd" },
});

function renderName(row: SessionTableRow, className: string) {
  return (
    <a className={className} href={`/sessions/${row.id}`}>
      {row.name}
    </a>
  );
}

// The ISS-5315 prototype order, then the three default-hidden columns. This
// component has no default-visibility opinion, so all of them render here; the
// hidden set is asserted against `useSessionsViewState` in
// `sessions-default-hidden-columns.test.ts`.
const EXPECTED_HEADERS_IN_ORDER = [
  "Session", // lead — ISS-5315 renamed from "Session Name"
  "Status", // #4480: Status leads, as the prototype does
  "Owner",
  "Autonomy",
  "Repository",
  "Linked branches", // ISS-5315 renamed from "Branch"
  "Harness",
  "Model",
  "Duration",
  "Cost",
  // ISS-5770: Started takes the prototype's slot just before Last active. It
  // still ships HIDDEN — this is the declared render order, which a bare mount
  // (no `visibleColumns`) draws in full.
  "Started",
  // ISS-6005: `Updated` (record-mutation recency) takes the prototype's slot
  // between Started and Last active. Like Started it ships HIDDEN; this literal
  // is the declared RENDER order, which a bare mount (no `visibleColumns`)
  // draws in full — the default-hidden claim is pinned separately, by
  // `sessions-prototype-alignment` and both e2e column-surface specs.
  "Updated",
  "Last active",
  // PR and Merge have no prototype slot, so they trail the prototype-ordered
  // columns rather than interleaving. Both ship hidden.
  "PR",
  "Merge",
] as const;

function headerRowElement(): HTMLElement {
  const headerRow = screen.getByText("Session").closest(".grid");
  if (!(headerRow instanceof HTMLElement)) {
    throw new Error("Could not find the sessions table header row");
  }
  return headerRow;
}

function headerLabelsInOrder(): string[] {
  return [...headerRowElement().children]
    .map((cell) => cell.textContent?.trim() ?? "")
    .filter((label) => label.length > 0);
}

/**
 * Declared pixel width of each rendered grid track, in order, and the right edge
 * of each. Derived by the shared `@repo/app/test/grid-track-geometry` helpers
 * (ISS-4889) — see there for why each `minmax()` is read at its minimum, and why
 * the reading goes through the production parser rather than a copy of its regex.
 */
function trackWidthsPx(): number[] {
  return widthsForTemplate(headerRowElement().style.gridTemplateColumns);
}

/** Right edge of every rendered track, in order — the fold's legal landing spots. */
function columnBoundariesPx(): number[] {
  return boundariesForTemplate(headerRowElement().style.gridTemplateColumns);
}

function columnIndexOf(label: string): number {
  const index = headerLabelsInOrder().indexOf(label);
  if (index < 0) {
    throw new Error(`No "${label}" column is rendered`);
  }
  return index;
}

/** Distance from the table's left edge to the right edge of `label`'s column. */
function columnRightEdgePx(label: string): number {
  return columnBoundariesPx()[columnIndexOf(label)];
}

/** Distance from the table's left edge to the LEFT edge of `label`'s column. */
function columnLeftEdgePx(label: string): number {
  const index = columnIndexOf(label);
  return columnBoundariesPx()[index] - trackWidthsPx()[index];
}

/**
 * A container wider than the whole table, so the ISS-4889 fold fit is a no-op
 * and the assertions below read the DECLARED track math — the column set and
 * order exactly as specified, which is what they were written to measure.
 */
const NATURAL_LAYOUT_CONTAINER_PX = 4000;

/**
 * The desktop Sessions content area at the 1380px window every clipping report in
 * ISS-4788 and ISS-4889 was filed at, minus the 256px sidebar and the inset
 * gutter.
 *
 * Deliberately the REPORTED width, not the current default — the desktop default
 * is 1400 (content area 1128) since the window was widened, and the desktop-side
 * twin at
 * `apps/desktop/src/renderer/components/sessions/__tests__/sessions-table-column-fold.test.tsx`
 * covers BOTH: the fresh-window content area AND this reported one, through the
 * desktop composition. Keeping the reported width here preserves the tighter
 * regime the reports came from; widening it would only give Cost more room.
 */
const DESKTOP_CONTENT_WIDTH_PX = 1108;

let restoreContainerWidth: (() => void) | null = null;

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

function renderAtContainerWidth(
  containerWidthPx: number,
  element: ReactElement
) {
  restoreContainerWidth?.();
  restoreContainerWidth = stubContainerWidthPx(containerWidthPx);
  return render(element);
}

describe("SessionsTable column set + order — prototype reconciliation (FEA-4006)", () => {
  beforeEach(() => {
    restoreContainerWidth = stubContainerWidthPx(NATURAL_LAYOUT_CONTAINER_PX);
  });

  it("renders exactly the expected columns, in order, with Owner shown by default", () => {
    render(
      <SessionsTable items={[ROW]} mode="expanded" renderName={renderName} />
    );
    expect(headerLabelsInOrder()).toEqual([...EXPECTED_HEADERS_IN_ORDER]);
  });

  it("keeps the prototype's leading order: Status, Owner, Autonomy, Repository", () => {
    render(
      <SessionsTable items={[ROW]} mode="expanded" renderName={renderName} />
    );
    const labels = headerLabelsInOrder();
    expect(labels.indexOf("Status")).toBeLessThan(labels.indexOf("Owner"));
    expect(labels.indexOf("Owner")).toBeLessThan(labels.indexOf("Autonomy"));
    expect(labels.indexOf("Autonomy")).toBeLessThan(
      labels.indexOf("Repository")
    );
    expect(labels.indexOf("Repository")).toBeLessThan(
      labels.indexOf("Linked branches")
    );
    // ISS-5770: Started takes the prototype's slot just before Last active, and
    // the two columns the prototype has no slot for trail everything.
    expect(labels.indexOf("Started")).toBeLessThan(
      labels.indexOf("Last active")
    );
    expect(labels.indexOf("Last active")).toBeLessThan(labels.indexOf("PR"));
  });

  // FEA-4006 made Owner shown-by-default on the primary lists. A supplied
  // `visibleColumns` set must still be able to hide it — the contract the
  // glanceable dashboard/telemetry mini-tables depend on to stay Owner-free.
  it("hides Owner when a visibleColumns set omits it, keeping Autonomy (the always-on exemption)", () => {
    render(
      <SessionsTable
        items={[ROW]}
        mode="expanded"
        renderName={renderName}
        // Every toggleable column except Owner.
        visibleColumns={new Set(["status", "repo", "branch", "pr"])}
      />
    );
    const labels = headerLabelsInOrder();
    expect(labels).not.toContain("Owner");
    expect(labels).toContain("Status");
    // Autonomy is exempt from the filter and always renders.
    expect(labels).toContain("Autonomy");
  });

  // ISS-4788: on desktop the Sessions grid is ~2,156px wide against a ~1,108px
  // content area (the 1380px window the reports were filed at − the 256px sidebar
  // − the inset gutter), so everything past ~1,100px sits behind a horizontal
  // scroll. Cost used to
  // span x≈1120–1220 — straight across that edge — and the row's headline number
  // rendered as "$772.3" with its last digits cut off. The durable contract is
  // not "1108px" (a window can be any size) but SESSIONS_LEGIBLE_COLUMN_BUDGET_PX
  // — the narrowest width this grid ever renders at, since SessionsTable supplies
  // a `cardRender` and defaults to `mode="auto"`, so below it the card list takes
  // over. Any container at least that wide must therefore show Cost whole. Fails
  // on the pre-fix order (Cost's right edge was 1220px).
  it("keeps Status fully on-screen at the narrowest width the grid renders", () => {
    render(
      <SessionsTable items={[ROW]} mode="expanded" renderName={renderName} />
    );
    expect(columnRightEdgePx("Status")).toBeLessThanOrEqual(
      SESSIONS_LEGIBLE_COLUMN_BUDGET_PX
    );
  });

  // ISS-5315's own consequence, pinned rather than left to be rediscovered as a
  // regression: the prototype order puts Cost ninth, well past the legible-width
  // budget, so it is NOT on the first screen at rest. That is a deliberate
  // product decision about which columns earn the first screen — but it is only
  // acceptable because the ISS-4889 fold keeps the column whole (the very next
  // describe block), so the figure is scrolled-to, never truncated. If a future
  // change wants Cost back on the first screen, this assertion is the place that
  // says so out loud.
  it("records that Cost now sits past the legible-width budget in the default order", () => {
    render(
      <SessionsTable items={[ROW]} mode="expanded" renderName={renderName} />
    );
    expect(columnRightEdgePx("Cost")).toBeGreaterThan(
      SESSIONS_LEGIBLE_COLUMN_BUDGET_PX
    );
  });

  it("renders the whole cost value in the Cost column, undivided", () => {
    render(
      <SessionsTable
        items={[{ ...ROW, costLabel: "$772.39" }]}
        mode="expanded"
        renderName={renderName}
      />
    );
    const costCell = screen
      .getByText("$772.39")
      .closest('[data-column-id="cost"]');
    expect(costCell).not.toBeNull();
  });

  // Currency only reads down a column when the decimals line up, so the figure
  // is right-aligned inside its track. Asserted on the rendered cell (not the
  // spec) so a refactor of the cell renderer can't quietly drop the alignment.
  it("right-aligns the cost figure within its track", () => {
    render(
      <SessionsTable
        items={[{ ...ROW, costLabel: "$772.39" }]}
        mode="expanded"
        renderName={renderName}
      />
    );
    const costCell = screen
      .getByText("$772.39")
      .closest('[data-column-id="cost"]');
    expect(costCell?.querySelector(".justify-end")).not.toBeNull();
  });

  // The budget above governs the DEFAULT order only. A user who drag-reordered
  // columns before ISS-4788 has the complete id list persisted (mergeColumnOrder
  // emits every id, not just the moved ones), and that array is replayed
  // verbatim — so their Cost column stays where they left it, clipped included.
  // That precedence is intentional (an explicit user arrangement outranks a
  // default, and "Reset view" clears it), but it is the kind of intent that
  // reads as a bug later, so it is pinned rather than left to a comment.
  it("lets a persisted column order win over the default, budget included", () => {
    const preFixOrder = [
      "owner",
      "status",
      "repo",
      "branch",
      "pr",
      "cost",
      "started",
    ];
    render(
      <SessionsTable
        columnOrder={preFixOrder}
        items={[ROW]}
        mode="expanded"
        renderName={renderName}
      />
    );
    const labels = headerLabelsInOrder();
    expect(labels.indexOf("Cost")).toBeGreaterThan(labels.indexOf("PR"));
    // Documents the consequence: the user's own order is NOT re-budgeted.
    expect(columnRightEdgePx("Cost")).toBeGreaterThan(
      SESSIONS_LEGIBLE_COLUMN_BUDGET_PX
    );
  });

  // The columns show/hide menu and the table's render order are declared in two
  // different modules, so they drift silently. Pin them together in the DEFAULT
  // state (the toolbar renders the menu list verbatim and never applies a
  // persisted order, so this agreement is default-only by construction).
  it("keeps the columns-menu order in step with the default rendered order", () => {
    render(
      <SessionsTable items={[ROW]} mode="expanded" renderName={renderName} />
    );
    const renderedLabels = headerLabelsInOrder();
    // ISS-5770: the menu list is DERIVED from SESSIONS_COLUMN_SPECS, so this
    // agreement now holds by construction rather than by two lists being kept in
    // step by hand. Pinned anyway — construction can be undone.
    const menuLabels: string[] = sessionsToggleableColumns().map(
      (column) => column.label
    );
    const renderedToggleableLabels = renderedLabels.filter((label) =>
      menuLabels.includes(label)
    );
    expect(renderedToggleableLabels).toEqual(menuLabels);
    // ISS-5770: and no Signals entry survives anywhere in the menu.
    expect(
      SESSIONS_TOGGLEABLE_COLUMNS.map((column) => column.label)
    ).not.toContain("Signals");
  });

  // ISS-5666 code-review finding `auditor_f0` (CONFIRMED by the verifier):
  // clearing the lead cell unconditionally deleted the "not started by a human"
  // signal on the agent-detail Sessions tab, which had no `Signals` column for
  // it to move to. A silent verdict drop is worse than the crowding that ticket
  // removed, so the FEA-3575 chip is retained on exactly those mounts.
  //
  // ISS-5770 kept that carve-out but made it EXPLICIT: the mount now says
  // `showProvenanceChip` instead of earning the chip by omitting a seam. Both
  // directions are pinned, because the default is the load-bearing half — the
  // Sessions listing must not grow a pill in the name cell just because the
  // column the chips lived in went away.
  it("renders the provenance chip only on a mount that opts in (ISS-5666 / ISS-5770)", () => {
    const { unmount } = render(
      <SessionsTable
        items={[{ ...ROW, provenance: BranchProvenance.Agent }]}
        mode="expanded"
        renderName={renderName}
        showProvenanceChip
      />
    );
    expect(screen.getByText("Agent")).toBeInTheDocument();
    unmount();

    render(
      <SessionsTable
        items={[{ ...ROW, provenance: BranchProvenance.Agent }]}
        mode="expanded"
        renderName={renderName}
      />
    );
    expect(screen.queryByText("Agent")).not.toBeInTheDocument();
  });

  it("SESSIONS_GLANCEABLE_COLUMNS drives an Owner-free glanceable table", () => {
    expect(SESSIONS_GLANCEABLE_COLUMNS.has("owner")).toBe(false);
    render(
      <SessionsTable
        items={[ROW]}
        mode="expanded"
        renderName={renderName}
        visibleColumns={SESSIONS_GLANCEABLE_COLUMNS}
      />
    );
    expect(headerLabelsInOrder()).not.toContain("Owner");
  });

  /**
   * ISS-6005. The embedded Insights "Recent Sessions" and agent-telemetry
   * tables pass this set explicitly and mount no View menu, so membership here
   * means PERMANENTLY on, not "on by default". `Updated` ships default-hidden,
   * so letting it ride along would render, on the two surfaces that cannot turn
   * it off, a 120px column the ticket declares off — beside the `Last active`
   * column it mostly repeats.
   */
  it("SESSIONS_GLANCEABLE_COLUMNS omits the default-hidden Updated column", () => {
    expect(SESSIONS_GLANCEABLE_COLUMNS.has(SESSIONS_UPDATED_COLUMN_ID)).toBe(
      false
    );
    render(
      <SessionsTable
        items={[ROW]}
        mode="expanded"
        renderName={renderName}
        visibleColumns={SESSIONS_GLANCEABLE_COLUMNS}
      />
    );
    expect(headerLabelsInOrder()).not.toContain("Updated");
  });

  /**
   * The exclusion above is per-id ON PURPOSE. Deriving the glanceable set from
   * SESSIONS_DEFAULT_VISIBLE_COLUMN_IDS would also drop these three, which
   * these embeds have carried since before the ISS-5315 defaults existed —
   * a silent regression this asserts against.
   */
  it("SESSIONS_GLANCEABLE_COLUMNS keeps the other default-hidden columns", () => {
    for (const id of ["pr", "merge", "started"]) {
      expect(SESSIONS_GLANCEABLE_COLUMNS.has(id)).toBe(true);
    }
    render(
      <SessionsTable
        items={[ROW]}
        mode="expanded"
        renderName={renderName}
        visibleColumns={SESSIONS_GLANCEABLE_COLUMNS}
      />
    );
    expect(headerLabelsInOrder()).toContain("PR");
  });
});

/**
 * ISS-4889. Reordering columns (ISS-4788) chose WHICH column the desktop fold
 * cut; it did not stop the cutting. The default set is ~2,156px against a
 * ~1,108px content area, so at rest some track always straddled the viewport's
 * right edge — after the Cost promotion it was the PR column, rendering ~36px of
 * a 148px track.
 *
 * The table now asks `GridTable` to fit the fold to a whole column
 * (`snapFoldToColumns`), which widens the lead track so the container's
 * edge lands on a column BOUNDARY. Nothing is hidden and nothing is reordered:
 * every column past the fold is one scroll away at its declared width. These
 * assert the rendered grid template, so they fail on the unfitted layout.
 */
describe("SessionsTable whole-column fold (ISS-4889)", () => {
  it("renders no partially-visible column at the desktop content width", () => {
    renderAtContainerWidth(
      DESKTOP_CONTENT_WIDTH_PX,
      <SessionsTable items={[ROW]} mode="expanded" renderName={renderName} />
    );

    // The fold lands ON a column's right edge, so no track starts before it and
    // ends after it. Fails unfitted: the boundaries are 300/480/612/712/892/
    // 1072/1220/…, and 1108 falls inside the PR track.
    expect(columnBoundariesPx()).toContain(DESKTOP_CONTENT_WIDTH_PX);
  });

  it("renders no partial column at the narrowest width the grid renders", () => {
    renderAtContainerWidth(
      CARD_FALLBACK_BREAKPOINT,
      <SessionsTable items={[ROW]} mode="expanded" renderName={renderName} />
    );

    // The ISS-4788 invariant, now structural rather than a function of where
    // Cost happens to sit in the order: whichever columns fall inside the fold
    // are rendered whole, and Cost — which ISS-5315 moved past it — begins after
    // the boundary rather than straddling it.
    expect(columnBoundariesPx()).toContain(CARD_FALLBACK_BREAKPOINT);
    expect(columnLeftEdgePx("Cost")).toBeGreaterThanOrEqual(
      CARD_FALLBACK_BREAKPOINT
    );
  });

  it("widens only the leading track, leaving every data column at its declared width", () => {
    renderAtContainerWidth(
      DESKTOP_CONTENT_WIDTH_PX,
      <SessionsTable items={[ROW]} mode="expanded" renderName={renderName} />
    );

    const widths = trackWidthsPx();
    // ISS-5315 order: boundaries are 300/432/612/752/932/1112/… so the last one
    // inside 1108 is Repository at 932, and the lead absorbs the leftover 176px.
    // Status, Owner and Autonomy are untouched, so a persisted resize is never
    // overwritten.
    //
    // This case wires no `renderQualifiers` seam, so there is no `Signals` track
    // and the lead keeps its full 300px minimum rather than ISS-5282's 200px.
    // ISS-5666 retired the flag but kept those two halves tied to the SEAM, so
    // this pre-existing arithmetic still stands unchanged.
    //
    // ISS-5282's first draft ALSO narrowed Owner to 136px to pay for the new
    // column, which would have moved these numbers. That narrowing is reverted
    // (review cids 3731452656 / 3731458714) — it was applied outside the column's
    // own flag AND 136px does not hold a display name — so Owner is 180px on both
    // sides of the seam. Its width is read from the constant rather than re-typed,
    // so the next change to it fails on the LEAD arithmetic (the thing this case
    // is about) instead of on a stale literal.
    expect(widths[0]).toBe(476);
    expect(widths.slice(1, 4)).toEqual([
      132,
      SESSIONS_OWNER_COLUMN_WIDTH_PX,
      140,
    ]);
  });

  it("protects a user's persisted order too — without silently reordering it", () => {
    // The pre-ISS-4788 arrangement, replayed verbatim from a saved view. Reordering
    // could only ever re-aim the cut, and in THIS arrangement it lands on the PR
    // track (972–1120) — a saved view is never re-budgeted, so ISS-4788's fix for
    // the default order does nothing here. The fold fit is what covers it.
    const preFixOrder = [
      "owner",
      "status",
      "repo",
      "branch",
      "pr",
      "cost",
      "started",
    ];
    renderAtContainerWidth(
      DESKTOP_CONTENT_WIDTH_PX,
      <SessionsTable
        columnOrder={preFixOrder}
        items={[ROW]}
        mode="expanded"
        renderName={renderName}
      />
    );

    // The user's order still wins — Cost stays where they left it.
    const labels = headerLabelsInOrder();
    expect(labels.indexOf("Cost")).toBeGreaterThan(labels.indexOf("PR"));
    // But it is no longer cut in half: the fold lands on a boundary, and Cost's
    // whole track now begins past it — scrollable, never rendered mid-glyph.
    expect(columnBoundariesPx()).toContain(DESKTOP_CONTENT_WIDTH_PX);
    expect(columnLeftEdgePx("Cost")).toBeGreaterThanOrEqual(
      DESKTOP_CONTENT_WIDTH_PX
    );
  });

  it("leaves the declared template alone when the table already fits its container", () => {
    renderAtContainerWidth(
      NATURAL_LAYOUT_CONTAINER_PX,
      <SessionsTable items={[ROW]} mode="expanded" renderName={renderName} />
    );

    // No fold to fit, and the lead's `1fr` maximum is entitled to the free space.
    expect(trackWidthsPx()[0]).toBe(300);
  });
});
