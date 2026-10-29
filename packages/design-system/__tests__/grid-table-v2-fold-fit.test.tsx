import {
  GRID_TABLE_V2_FAVORITE_TRACK,
  GridTableV2,
  type GridTableV2Column,
} from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { stubContainerWidthPx } from "./fixtures/container-width";

/**
 * ISS-8909 — `GridTableV2`'s wiring of the whole-column fold fit (ISS-4889 /
 * ISS-4788 / ISS-4906), ported from `GridTable` when the desktop v1 Sessions
 * host was retired and took the only surface that opted into it with it.
 *
 * `fitGridTemplateToWholeColumns` itself is covered next door
 * (`__tests__/column-fold.test.ts`). What has nowhere else to fail is the
 * COMPONENT's half:
 *
 *  1. that the fitted template reaches the BODY rows as well as the header. A
 *     grid that fitted one and not the other renders each cell on a track its
 *     own column header does not sit above — ISS-4788's defect, which renders
 *     without error.
 *  2. that the track which absorbs the leftover is the IDENTITY column, not
 *     track 0. v1 never had a leading utility track so the two were the same
 *     statement; v2 does, and the web Sessions host declares one. Absorbing into
 *     track 0 there widens the 36px favourite STAR and leaves the name column at
 *     its declared width — and because the DESKTOP host declares no utility
 *     track, the desktop e2e fold spec passes either way. This is the case that
 *     tells them apart.
 *  3. that the fit is gated on a REAL measurement, so an unmeasured container
 *     (SSR, first paint, `display:none`, a parked keep-alive view) renders the
 *     caller's own template rather than being fitted against
 *     `useContainerWidth`'s 1024px placeholder.
 *
 * Assertions read the rendered `grid-template-columns` of each `role="row"`, not
 * a snapshot: the defect class is geometric and the markup is identical either
 * way.
 */

type Row = { id: string; name: string };

const ROWS: Row[] = [
  { id: "1", name: "Alpha" },
  { id: "2", name: "Beta" },
];

const COLUMNS: GridTableV2Column[] = [
  { id: "status", label: "Status" },
  { id: "owner", label: "Owner" },
  { id: "repo", label: "Repo" },
  { id: "cost", label: "Cost" },
  { id: "updated", label: "Updated" },
];

/**
 * Identity + one track per data column: 240 + 5 x 190 = 1190px of declared
 * track. Deliberately wider than BOTH the container below (so a real fold
 * exists to snap — a template that already fits comes back byte-identical,
 * which would let every assertion here pass against a grid that had stopped
 * fitting anything) AND `useContainerWidth`'s 1024px unmeasured placeholder (so
 * fitting against that placeholder produces a visibly wrong template rather
 * than a no-op, which is what gives case 3 something to fail on).
 */
const DECLARED_TEMPLATE = "240px 190px 190px 190px 190px 190px";

/** Narrower than the 1190px of declared track above, so a fold exists. */
const CONTAINER_WIDTH_PX = 500;

/**
 * The fit at 500px: 240 + 190 = 430 fits whole, the next 190 does not, so 70px
 * is left over and the identity track absorbs it (240 + 70 = 310). Pinned as a
 * literal rather than recomputed from the helper the component calls — a test
 * that re-derives its expectation cannot disagree with the code.
 *
 * For contrast, the same fit against the 1024px placeholder seats five tracks
 * and widens the identity track to 264px, so case 3 and this cannot both pass.
 */
const FITTED_TEMPLATE = "310px 190px 190px 190px 190px 190px";

/** The same grid with a favourite star declared ahead of the identity column. */
const DECLARED_TEMPLATE_WITH_UTILITY = `${GRID_TABLE_V2_FAVORITE_TRACK} ${DECLARED_TEMPLATE}`;

/**
 * The fit at 500px with the star in front: 36 + 240 = 276 fits, + 190 = 466
 * fits, the next 190 does not, so 34px is left over and the IDENTITY track
 * absorbs it (240 + 34 = 274). The star stays exactly 36px.
 */
const FITTED_TEMPLATE_WITH_UTILITY = `${GRID_TABLE_V2_FAVORITE_TRACK} 274px 190px 190px 190px 190px 190px`;

/**
 * What absorbing into track 0 would emit instead — the star grown to 70px while
 * the name column keeps its declared 240px. Never expected; asserted against so
 * the wrong answer cannot pass silently.
 */
const WRONGLY_FITTED_UTILITY_TRACK = "70px";

/** A container that measures zero is not a measurement: detached, hidden, SSR. */
const ZERO_CONTAINER_WIDTH_PX = 0;

const UTILITY_CONTROL_LABEL = "Favorite";

let restoreContainerWidth: (() => void) | null = null;

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

describe("GridTableV2 whole-column fold fit (ISS-4889/ISS-8909)", () => {
  it("puts the fitted template on the header row AND every body row", () => {
    restoreContainerWidth = stubContainerWidthPx(CONTAINER_WIDTH_PX);
    renderGrid({ snapFoldToColumns: true });

    const templates = renderedRowTemplates();
    // Header + one row per item, so a row that failed to render could not make
    // the agreement below vacuously true.
    expect(templates).toHaveLength(ROWS.length + 1);
    // The fit actually fired — without this the case would still pass against a
    // grid that fitted nothing and handed every row the declared template.
    expect(templates[0]).not.toBe(DECLARED_TEMPLATE);
    // Header and body sit on ONE set of tracks. Fitting only the header leaves
    // each cell under a column header that is no longer above it.
    expect(templates).toEqual(templates.map(() => FITTED_TEMPLATE));
  });

  it("leaves the caller's template alone without the opt-in", () => {
    restoreContainerWidth = stubContainerWidthPx(CONTAINER_WIDTH_PX);
    renderGrid({});

    const templates = renderedRowTemplates();
    expect(templates).toHaveLength(ROWS.length + 1);
    expect(templates).toEqual(templates.map(() => DECLARED_TEMPLATE));
  });

  it("absorbs the leftover into the identity track, never the utility track", () => {
    restoreContainerWidth = stubContainerWidthPx(CONTAINER_WIDTH_PX);
    renderGrid({
      gridTemplateColumns: DECLARED_TEMPLATE_WITH_UTILITY,
      leadingUtilityLabel: UTILITY_CONTROL_LABEL,
      renderLeadingUtility: () => (
        <button type="button">{UTILITY_CONTROL_LABEL}</button>
      ),
      snapFoldToColumns: true,
    });

    const templates = renderedRowTemplates();
    expect(templates).toHaveLength(ROWS.length + 1);
    expect(templates).toEqual(
      templates.map(() => FITTED_TEMPLATE_WITH_UTILITY)
    );
    // The star keeps its declared width. Stated separately from the whole-string
    // match above because THIS is the fact the desktop e2e fold spec cannot see:
    // that host declares no utility track, so it passes either way.
    for (const template of templates) {
      expect(template.startsWith(`${GRID_TABLE_V2_FAVORITE_TRACK} `)).toBe(
        true
      );
      expect(template.startsWith(WRONGLY_FITTED_UTILITY_TRACK)).toBe(false);
    }
  });

  it("renders the caller's declared template until the container is really measured", () => {
    // A zero box is not a measurement. Without the measured gate the fold would
    // be fitted against `useContainerWidth`'s 1024px placeholder — snapping to a
    // width this container does not have.
    restoreContainerWidth = stubContainerWidthPx(ZERO_CONTAINER_WIDTH_PX);
    renderGrid({ snapFoldToColumns: true });

    const templates = renderedRowTemplates();
    expect(templates).toHaveLength(ROWS.length + 1);
    expect(templates).toEqual(templates.map(() => DECLARED_TEMPLATE));
  });
});

/**
 * The grid template every rendered row carries, header first. Read off the
 * `role="row"` elements rather than a class or DOM position, so a layout
 * refactor that keeps the grid a grid keeps this test meaningful.
 */
function renderedRowTemplates(): string[] {
  return screen.getAllByRole("row").map((row) => row.style.gridTemplateColumns);
}

function renderGrid(
  overrides: Partial<React.ComponentProps<typeof GridTableV2<Row>>>
) {
  render(
    <GridTableV2<Row>
      columns={COLUMNS}
      getRowId={(row) => row.id}
      gridTemplateColumns={DECLARED_TEMPLATE}
      items={ROWS}
      leadingLabel="Name"
      mode="expanded"
      renderCell={(columnId) => columnId}
      renderLead={(row) => <span>{row.name}</span>}
      {...overrides}
    />
  );
}
