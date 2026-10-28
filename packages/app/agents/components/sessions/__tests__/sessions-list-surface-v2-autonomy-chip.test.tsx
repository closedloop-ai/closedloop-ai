import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { pinSessionFixtureClock } from "@repo/app/test/mocks/session-fixture-clock";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSIONS_AUTONOMY_COLUMN_ID } from "../../../lib/sessions-table-columns";
import { SESSION_AUTONOMY_CHIP_TEST_ID } from "../session-cell-chips";
import { SessionsTable } from "../session-detail-table";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { SessionsListSurfaceV2 } from "../sessions-list-surface-v2";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

/**
 * FEA-4206: the two Sessions listings must render Autonomy the SAME way.
 *
 * `SessionsTable` — the listing both hosts mount today — renders the calibrated
 * tier as a colored `AutonomyChip` (ISS-6005). `SessionsListSurfaceV2`,
 * the v2-stack replacement that supersedes it, rendered the same column through
 * its `TableTextCell` fallback: the bare score, unstyled — precisely the
 * treatment this ticket exists to remove. Nobody sees it yet (no host mounts the
 * surface, and it only ever mounts behind `grid-table-v2`, off on both
 * platforms), which is why this is a divergence to close now rather than a
 * shipped defect.
 *
 * The load-bearing assertion is the two surfaces against EACH OTHER on one
 * rendered screen, not each against a constant: a constant-only check passes
 * while both drift together, and passes while only one of them is asserted at
 * all. The expected words are spelled out here rather than read from
 * `getAutonomyShortLabel`, because that helper and its thresholds are what this
 * test polices — importing them would make a changed cutoff unable to fail.
 *
 * The parity claim is scoped to the GRID path, which is the only path v2 has:
 * it passes no `cardRender`, so unlike `SessionsTable` it does not fall back to
 * cards on a narrow viewport and this column simply goes off screen there. That
 * gap predates this change and is the v2 migration's to close; nothing here
 * should be read as asserting the two listings agree below the card breakpoint.
 */

/** Wide enough that no column folds out of the assertions on either surface. */
const NATURAL_LAYOUT_CONTAINER_PX = 4000;

/**
 * Explicit, because comparing the two listings costs two heavy mounts and the
 * 5s default is not enough under a loaded parallel run — measured at 291ms
 * alone and 7.3s inside the full `agents/components/sessions` sweep, where this
 * file's neighbours already sit near that ceiling for the same reason
 * (`sessions-list-surface-v2-seam-columns.test.tsx`). Bounding the known cost,
 * not hiding a hang: the work here is synchronous rendering with no waiting, so
 * anything approaching this ceiling is a real regression in mount cost.
 */
const TWO_SURFACE_MOUNT_TIMEOUT_MS = 20_000;

/**
 * One row per tier, INCLUDING a measured zero, plus the unscored case.
 *
 * The zero is the row that makes the guard falsifiable. `guided`'s floor is 0
 * (`AUTONOMY_TIER_MIN_SCORE`), so a 0 is a real, producible score — and with an
 * all-truthy corpus the classic slip `row.autonomy == null` -> `!row.autonomy`
 * changes nothing any assertion can see, while silently rendering "nothing
 * recorded" over a measured floor. That is the ISS-5565 defect, and the shipped
 * table is pinned against it (`session-measured-properties.test.tsx`) while this
 * surface, which now carries its own copy of the guard, would not be.
 */
const ROWS: SessionTableRow[] = [
  createSessionTableRowFixture({ autonomy: 88, id: "ses-high" }),
  createSessionTableRowFixture({ autonomy: 50, id: "ses-mixed" }),
  createSessionTableRowFixture({ autonomy: 12, id: "ses-guided" }),
  createSessionTableRowFixture({ autonomy: 0, id: "ses-floor" }),
  createSessionTableRowFixture({ autonomy: null, id: "ses-unscored" }),
];

const EXPECTED_TIER_WORDS = ["High", "Mixed", "Guided", "Guided"];

function renderName(row: SessionTableRow, className: string) {
  return (
    <a className={className} href={`/sessions/${row.id}`}>
      {row.name}
    </a>
  );
}

/** Every autonomy chip a surface rendered, in row order, by its label. */
function autonomyChipLabels(container: HTMLElement): string[] {
  return [
    ...container.querySelectorAll<HTMLElement>(
      `[data-testid="${SESSION_AUTONOMY_CHIP_TEST_ID}"]`
    ),
  ].map((element) => element.textContent?.trim() ?? "");
}

/**
 * The autonomy VALUE cells, in row order. `columnheader` carries the same
 * `data-column-id`, so matching it would assert against the word "Autonomy"
 * instead of the value under it.
 */
function autonomyCells(container: HTMLElement): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>(
      `[data-column-id="${SESSIONS_AUTONOMY_COLUMN_ID}"]`
    ),
  ].filter((element) => element.getAttribute("role") !== "columnheader");
}

/**
 * The class signature the shared sentinel actually renders with, read from it.
 *
 * Compared against `GridEmptyValue`'s OWN output rather than an em-dash literal:
 * asserting on the character would still pass if the cell grew a bespoke dash,
 * and the point is that it routes through the shared sentinel.
 */
function sharedEmptyGlyphClassName(): string {
  const { container, unmount } = render(<GridEmptyValue />);
  const span = container.querySelector("span");
  if (!span) {
    throw new Error("GridEmptyValue did not render a span");
  }
  const { className } = span;
  unmount();
  return className;
}

let restoreContainerWidth: (() => void) | null = null;

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

pinSessionFixtureClock();

describe("SessionsListSurfaceV2 autonomy cell", () => {
  /**
   * Deliberately ONE mount of each surface for every assertion below, per the
   * reasoning its sibling `sessions-list-surface-v2-seam-columns.test.tsx`
   * records: this surface renders a toolbar, four menus and the summary strip,
   * and repeated mounts measurably slow the whole `agents/components/sessions`
   * run and tip already-marginal neighbours into timing out. The assertions read
   * two rendered screens, so nothing is lost but the per-assertion `it`.
   */
  it(
    "renders the shared tier chip, matching the shipped Sessions table",
    () => {
      restoreContainerWidth = stubContainerWidthPx(NATURAL_LAYOUT_CONTAINER_PX);

      const surface = render(
        <SessionsListSurfaceV2 rows={ROWS} usage={undefined} />
      );
      const table = render(
        <SessionsTable items={ROWS} mode="expanded" renderName={renderName} />
      );

      const surfaceLabels = autonomyChipLabels(surface.container);
      const tableLabels = autonomyChipLabels(table.container);

      // Positive: the v2 surface routes the cell through the shared chip, and the
      // chip states the tier in WORDS — the non-color statement a reader who
      // cannot resolve the tone still gets (WCAG 1.4.1). A measured 0 is in here,
      // so a falsy guard drops a chip and fails this line.
      expect(surfaceLabels).toEqual(EXPECTED_TIER_WORDS);
      // The divergence guard: same rows, same words, on both listings. Fails if
      // either surface changes its treatment without the other.
      expect(surfaceLabels).toEqual(tableLabels);

      // The unscored row, asserted POSITIVELY rather than by chip count: it renders
      // the shared empty sentinel. Counting chips alone would stay green if the
      // cell returned `null` and drew nothing at all.
      const cells = autonomyCells(surface.container);
      expect(cells).toHaveLength(ROWS.length);
      const unscoredCell = cells.at(-1);
      if (!unscoredCell) {
        throw new Error("surface rendered no autonomy cells");
      }
      expect(
        unscoredCell.querySelector(
          `[data-testid="${SESSION_AUTONOMY_CHIP_TEST_ID}"]`
        )
      ).toBeNull();
      expect(unscoredCell.querySelector("span")?.className).toBe(
        sharedEmptyGlyphClassName()
      );

      // The score is MOVED into the chip's tooltip, never dropped — the capability
      // a reader has today survives, on the keyboard-reachable trigger the chip
      // already carries. Includes the 0, so the tooltip cannot quietly stop
      // describing a measured floor.
      const surfaceText = surface.container.textContent ?? "";
      for (const score of [88, 50, 12, 0]) {
        expect(surfaceText).toContain(`Autonomy score ${score} of 100`);
      }
    },
    TWO_SURFACE_MOUNT_TIMEOUT_MS
  );
});
