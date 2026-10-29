import {
  GridTable,
  type GridTableColumn,
} from "@closedloop-ai/design-system/components/ui/grid-table";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { stubContainerWidthPx } from "./fixtures/container-width";

/**
 * ISS-6717 — the COMPONENT's wiring of the whole-column fold fit (ISS-4889 /
 * ISS-4788), which is the half of that mechanic nothing covered.
 *
 * `fitGridTemplateToWholeColumns` itself is exhaustively covered twice
 * (`__tests__/column-fold.test.ts` here and `packages/app/shared/lib/__tests__/
 * column-fold.test.ts`), and the fitted GEOMETRY is covered from the Sessions
 * consumer on both surfaces. But every one of those geometry assertions reads
 * `headerRowElement().style.gridTemplateColumns` — the HEADER row and only the
 * header row. So the two facts below had nowhere to fail:
 *
 *  1. that the fitted template reaches the BODY rows as well as the header. A
 *     `GridTable` that fitted one and not the other would keep every existing
 *     fold test green while rendering each cell on a track its own column header
 *     does not sit above — a value clipped by tracks that disagree, which is
 *     precisely ISS-4788's defect and renders without error.
 *  2. that the fit is gated on a REAL measurement. Every existing fold test
 *     stubs a positive width, so all of them stay green if the
 *     `isContainerMeasured` gate is dropped — and an unmeasured container
 *     (SSR, first paint, `display:none`, a detached or parked keep-alive view)
 *     would then be fitted against `useContainerWidth`'s 1024px placeholder,
 *     snapping the fold to a width the container does not have.
 *
 * Assertions are on the rendered template of each `role="row"` element, not on a
 * snapshot: the defect class here is geometric, and the markup is identical
 * either way.
 */

type Row = { id: string; name: string };

const ROWS: Row[] = [
  { id: "1", name: "Alpha" },
  { id: "2", name: "Beta" },
];

const COLUMNS: GridTableColumn[] = [
  { id: "owner", label: "Owner" },
  { id: "status", label: "Status" },
  { id: "repo", label: "Repo" },
  { id: "cost", label: "Cost" },
  { id: "updated", label: "Updated" },
];

/**
 * Lead + one track per data column: 300 + 5 × 190 = 1250px of declared track.
 *
 * Two properties are load-bearing and both are deliberate. It is wider than the
 * container below, so there is a real fold to snap — a template that already
 * fits is returned byte-identical, which would let every assertion here pass
 * against a component that had stopped fitting anything at all. And it is also
 * wider than `useContainerWidth`'s 1024px unmeasured placeholder, so fitting
 * against that placeholder produces a visibly WRONG template rather than a
 * no-op, which is what gives the measured-gate case below something to fail on.
 */
const DECLARED_TEMPLATE = "minmax(300px, 1fr) 190px 190px 190px 190px 190px";

/** Narrower than the 1250px of declared track above, so a fold exists. */
const CONTAINER_WIDTH_PX = 800;

/**
 * The fold at 800px: 300 + 190 + 190 = 680 fits whole, the next 190 does not, so
 * 120px is left over and the lead absorbs it (300 + 120 = 420). Pinned as the
 * expected literal rather than recomputed from the same helper the component
 * calls — a test that re-derives its expectation cannot disagree with the code.
 *
 * For contrast, the same fit against the 1024px placeholder would seat four
 * tracks and widen the lead to 454px, so the two cases below cannot both pass.
 */
const FITTED_TEMPLATE = "minmax(420px, 1fr) 190px 190px 190px 190px 190px";

/** A container that measures zero is not a measurement: detached, hidden, SSR. */
const ZERO_CONTAINER_WIDTH_PX = 0;

let restoreContainerWidth: (() => void) | null = null;

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

function renderGrid() {
  return render(
    <GridTable<Row>
      columns={COLUMNS}
      getRowId={(row) => row.id}
      gridTemplateColumns={DECLARED_TEMPLATE}
      items={ROWS}
      leadingLabel="Name"
      renderCell={(columnId, row) => `${columnId}:${row.name}`}
      renderLead={(row) => <span>{row.name}</span>}
      snapFoldToColumns
    />
  );
}

/**
 * The grid template every rendered row carries, header first. Read off the
 * `role="row"` elements rather than a class or DOM position, so a layout
 * refactor that keeps the table a table keeps this test meaningful.
 */
function renderedRowTemplates(): string[] {
  return within(screen.getByRole("table"))
    .getAllByRole("row")
    .map((row) => row.style.gridTemplateColumns);
}

describe("GridTable whole-column fold fit — wiring (ISS-4889/ISS-4788)", () => {
  it("puts the fitted template on the header row AND every body row", () => {
    restoreContainerWidth = stubContainerWidthPx(CONTAINER_WIDTH_PX);
    renderGrid();

    const templates = renderedRowTemplates();
    // Header + one row per item, so a row that failed to render could not make
    // the agreement below vacuously true.
    expect(templates).toHaveLength(ROWS.length + 1);
    // The fit actually fired — without this the case would still pass against a
    // component that fitted nothing and handed every row the declared template.
    expect(templates[0]).not.toBe(DECLARED_TEMPLATE);
    // Header and body sit on ONE set of tracks. Fitting only the header leaves
    // each cell under a column header that is no longer above it.
    expect(templates).toEqual(templates.map(() => FITTED_TEMPLATE));
  });

  it("renders the caller's declared template until the container is really measured", () => {
    // A zero box is not a measurement. Without the `isContainerMeasured` gate
    // the fold would be fitted against `useContainerWidth`'s 1024px placeholder
    // — snapping to a width this container does not have.
    restoreContainerWidth = stubContainerWidthPx(ZERO_CONTAINER_WIDTH_PX);
    renderGrid();

    const templates = renderedRowTemplates();
    expect(templates).toHaveLength(ROWS.length + 1);
    expect(templates).toEqual(templates.map(() => DECLARED_TEMPLATE));
  });
});
