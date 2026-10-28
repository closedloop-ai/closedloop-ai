import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { SessionsSeamCellRenderer } from "@repo/app/agents/lib/session-list-row";
import { SESSIONS_SEAM_REQUIRED_COLUMN_IDS } from "@repo/app/agents/lib/sessions-column-visibility";
import {
  SESSIONS_COLUMN_SPECS,
  SESSIONS_COST_COLUMN_ID,
  SESSIONS_UPDATED_COLUMN_ID,
} from "@repo/app/agents/lib/sessions-table-columns";
import { artifactStatusFullLabel } from "@repo/app/shared/components/artifact-status/artifact-status-presentation";
import { sessionStatusView } from "@repo/app/shared/lib/artifact-status-adapter";
import { fireEvent, render, screen } from "@testing-library/react";
import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { CostAvailability } from "../../../lib/cost-availability";
import { renderSessionCell as renderSharedCell } from "../session-cell-renderers";
import { SESSION_COST_CELL_TEST_ID } from "../session-cost-cell";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { createSessionsListSurfaceRenderers } from "../sessions-list-surface-renderers";
import {
  renderSessionGridCell as renderGridCell,
  renderSessionCell as renderSurfaceCell,
} from "../sessions-list-surface-rows";

/**
 * ISS-7902 / FEA-4206 — the column-divergence class, closed exhaustively.
 *
 * Sessions cells used to be rendered TWICE: `SessionsTable` switched over all 14
 * non-seam columns while `sessions-list-surface-rows.tsx` re-implemented four and
 * dropped the other ten through a generic text cell. Each divergence was then
 * found by hand, one column per ticket — Autonomy (FEA-4206), Harness and Status
 * (ISS-7902) — with ten still queued to be discovered the same way.
 *
 * This iterates `SESSIONS_COLUMN_SPECS` rather than listing columns, so a column
 * ADDED to the canonical geometry is covered the day it is added. A per-column
 * list would have exactly the hole the two renderers had: it covers what
 * somebody remembered.
 */

/**
 * How many columns the shared renderer owns: every `SESSIONS_COLUMN_SPECS` entry
 * that is not a host seam.
 *
 * An independent literal, deliberately — computing it from the same filter the
 * cases iterate would assert `x === x` and pass against an empty geometry. It is
 * an EQUALITY rather than a floor so the number stated in this file's prose, in
 * `session-cell-renderers.tsx`'s docstring, and in the switch there cannot drift
 * apart in silence (whitlockk, ISS-7902): adding a column reddens this, and the
 * per-column case below then proves the shared renderer actually claims it.
 */
const NON_SEAM_COLUMN_COUNT = 14;

const NO_SEAMS: ReadonlyMap<string, SessionsSeamCellRenderer> = new Map();

/** Element type + props, which is what "renders the same cell" means here. */
function shapeOf(node: ReactNode): unknown {
  if (!isValidElement(node)) {
    return { literal: node ?? null };
  }
  const { children, ...rest } = (node.props ?? {}) as Record<string, unknown>;
  return {
    type:
      typeof node.type === "function"
        ? (node.type.name ?? "anonymous")
        : String(node.type),
    props: rest,
    hasChildren: children !== undefined,
  };
}

const ROW = createSessionTableRowFixture();

describe("Sessions cell rendering is one renderer, not two", () => {
  const shared = SESSIONS_COLUMN_SPECS.filter(
    (spec) => !SESSIONS_SEAM_REQUIRED_COLUMN_IDS.has(spec.id)
  );

  it("covers every non-seam column in the canonical geometry", () => {
    // Guards the guard: if the specs were empty or every column were a seam,
    // each case below would vacuously pass.
    expect(shared.length).toBe(NON_SEAM_COLUMN_COUNT);
  });

  it.each(shared.map((spec) => [spec.id] as const))(
    "renders %s identically on the v2 surface and the shared renderer",
    (columnId) => {
      const viaSurface = renderSurfaceCell(columnId, ROW, NO_SEAMS);
      const viaShared = renderSharedCell(columnId, ROW);

      // The shared renderer must CLAIM the column — a `null` here means the v2
      // surface fell through to its text cell, which is the exact shape every
      // "column X renders raw" ticket reported.
      expect(
        viaShared,
        `${columnId} is not claimed by the shared renderer, so the v2 surface falls back to a plain text cell`
      ).not.toBeNull();
      expect(shapeOf(viaSurface)).toEqual(shapeOf(viaShared));
    }
  );

  it("still lets a host seam win over the shared renderer", () => {
    // Seam columns are cloud-only projections a mount may not be able to fill,
    // so they remain the host's call rather than the column's.
    const seamId = [...SESSIONS_SEAM_REQUIRED_COLUMN_IDS][0] as string;
    const seams = new Map<string, SessionsSeamCellRenderer>([
      [seamId, () => <span data-testid="seam" />],
    ]);

    expect(shapeOf(renderSurfaceCell(seamId, ROW, seams))).toEqual(
      shapeOf(<span data-testid="seam" />)
    );
  });
});

describe("Sessions narrow lead status", () => {
  it("adds the canonical status icon only through the narrow lead renderer", () => {
    const renderers = createSessionsListSurfaceRenderers({
      customFieldColumns: [],
      customFields: undefined,
      seamRenderers: NO_SEAMS,
    });
    const narrow = render(
      renderers.renderGridLead(ROW, { isNarrowList: true })
    );
    const statusLabel = artifactStatusFullLabel(
      sessionStatusView(ROW.id, ROW.status, ROW.rawStatus)
    );

    expect(screen.getByLabelText(statusLabel)).toBeInTheDocument();
    narrow.unmount();

    render(renderers.renderGridLead(ROW, { isNarrowList: false }));
    expect(screen.queryByLabelText(statusLabel)).toBeNull();
  });

  it("reads an unrecognized raw status as the Active the wide pill shows (ISS-10364)", () => {
    const renderers = createSessionsListSurfaceRenderers({
      customFieldColumns: [],
      customFields: undefined,
      seamRenderers: NO_SEAMS,
    });
    const skewedRow = createSessionTableRowFixture({
      rawStatus: UNRECOGNIZED_RAW_STATUS,
      status: SESSION_STATUS.ACTIVE,
    });
    render(renderers.renderGridLead(skewedRow, { isNarrowList: true }));

    const activeLabel = artifactStatusFullLabel(
      sessionStatusView(skewedRow.id, SESSION_STATUS.ACTIVE)
    );
    expect(screen.getByLabelText(activeLabel)).toBeInTheDocument();
    expect(screen.queryByLabelText(UNKNOWN_STATUS_LABEL_RE)).toBeNull();
  });
});

/** A producer status this build does not recognize (version skew). */
const UNRECOGNIZED_RAW_STATUS = "not-a-session-status";
const UNKNOWN_STATUS_LABEL_RE = /Unknown/;

/**
 * codex-review, ISS-7902: the Cost column's right alignment on the v2 GRID.
 *
 * Routing Cost through the shared renderer took its alignment with it. It used
 * to arrive from `TableNumberCell`'s default `alignEnd`; `SessionCostCell` owns
 * no alignment class, and `GridTableV2` hands `column.className` to the HEADER
 * only — so the figure and the no-usage dash both went flush left under a
 * right-aligned "Cost" header, and the decimals stopped scanning down a column.
 *
 * Driven through `renderSessionGridCell`, the function the surface's `renderCell`
 * actually calls, so deleting the wrapper reddens this rather than leaving a
 * helper nobody reaches under test.
 */
describe("renderSessionGridCell cost alignment", () => {
  const alignedSpans = (container: HTMLElement) =>
    container.querySelectorAll(".justify-end");

  it("right-aligns the Cost figure on the grid", () => {
    const { container } = render(
      renderGridCell(SESSIONS_COST_COLUMN_ID, ROW, NO_SEAMS)
    );

    expect(alignedSpans(container)).toHaveLength(1);
    // The figure is INSIDE the alignment wrapper, not merely somewhere on the
    // page — a wrapper around nothing would satisfy the count alone.
    expect(alignedSpans(container)[0]?.textContent).toContain("$4.12");
  });

  it("right-aligns the no-usage dash too, not only the figure", () => {
    // The other half the review named: `GridEmptyValue` carries no `alignEnd`
    // here, so without the wrapper the dash sits left of the figures it shares
    // a column with.
    const { container } = render(
      renderGridCell(
        SESSIONS_COST_COLUMN_ID,
        { ...ROW, costAvailability: CostAvailability.NoUsage },
        NO_SEAMS
      )
    );

    expect(alignedSpans(container)).toHaveLength(1);
  });

  it("leaves a non-numeric column unaligned", () => {
    // The positive assertions above pass against a helper that wrapped EVERY
    // column, which would push each cell's content to the far edge of its track.
    // `Updated` is unset on the fixture, so this is also the empty glyph on a
    // NON-cost column: it proves the wrapper is keyed on the COLUMN rather than
    // on the cell happening to be empty.
    const { container } = render(
      renderGridCell(SESSIONS_UPDATED_COLUMN_ID, ROW, NO_SEAMS)
    );

    expect(alignedSpans(container)).toHaveLength(0);
    // …and the cell still rendered, so the zero above is not a blank render.
    expect(container.textContent).not.toBe("");
  });
});

/**
 * ISS-7902: the Cost dash that EXPLAINS itself, on the v2 grid.
 *
 * `Unavailable` and `NoTokenUsage` both render an em dash, and they are not the
 * same fact as `NoUsage`: the session DID run, and the tooltip names why there
 * is no figure — pricing config, or no usage recorded to price. Routing v2's
 * Cost through a bare numeric cell renders all three as one indistinguishable
 * dash and takes the explanation with it, which is a capability the reader
 * loses without anything on screen saying so.
 *
 * Driven through {@link renderGridCell}, the function the v2 surface's
 * `renderCell` calls, and asserted on the OPENED tooltip rather than on the
 * trigger alone — a button carrying an empty or wrong explanation would satisfy
 * "is a button".
 */
describe("v2 Cost keeps the explanation on a non-figure row", () => {
  const explained = [
    [CostAvailability.Unavailable, "No pricing data for this model"],
    [CostAvailability.NoTokenUsage, "No token usage recorded to price"],
  ] as const;

  it.each(explained)(
    "surfaces the %s tooltip on the v2 grid",
    async (availability, tooltip) => {
      render(
        renderGridCell(
          SESSIONS_COST_COLUMN_ID,
          {
            ...ROW,
            costAvailability: availability,
            costLabel: "—",
            costTooltip: tooltip,
          },
          NO_SEAMS
        )
      );

      // The chip-era keyboard path, preserved: the explanation is reachable by
      // focus, not by hover alone.
      const trigger = screen.getByTestId(SESSION_COST_CELL_TEST_ID);
      expect(trigger.tagName).toBe("BUTTON");

      fireEvent.focus(trigger);

      expect(await screen.findByRole("tooltip")).toHaveTextContent(tooltip);
    }
  );

  it("gives a priced row no tooltip control to explain away a real figure", () => {
    // The negative sibling: without it, the cases above pass against a build
    // that wrapped EVERY Cost cell in a tooltip button, which would put a
    // focusable control with nothing to say on every priced row in the column.
    render(renderGridCell(SESSIONS_COST_COLUMN_ID, ROW, NO_SEAMS));

    const cell = screen.getByTestId(SESSION_COST_CELL_TEST_ID);
    expect(cell.tagName).toBe("SPAN");
    expect(cell).toHaveTextContent("$4.12");
  });

  it("keeps a no-usage row as the shared empty glyph, not an explained dash", () => {
    // `NoUsage` is the third state, and it is NOT the same claim: the session
    // recorded nothing to explain, so it renders the shared sentinel and the
    // card drops the line entirely. Collapsing it into either case above is what
    // makes "absent", "zero" and "unavailable" one dash.
    const { container } = render(
      renderGridCell(
        SESSIONS_COST_COLUMN_ID,
        { ...ROW, costAvailability: CostAvailability.NoUsage },
        NO_SEAMS
      )
    );

    expect(screen.queryByTestId(SESSION_COST_CELL_TEST_ID)).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });
});
