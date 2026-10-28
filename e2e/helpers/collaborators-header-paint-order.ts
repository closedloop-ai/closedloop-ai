import { expect, type Page } from "@playwright/test";

/** No exported constant for this id yet; every write site is a bare literal. */
const COLLABORATORS_COLUMN = "collaborators";

/**
 * Where along the scroller the probe walks. The two shells need different
 * windows and both are measured, not chosen: the browser shell's comes from
 * #8657's geometry (scroller clientHeight 155, scrollHeight 1136), while the
 * Electron window's chrome sets its own band, so desktop walks the whole range.
 */
export type HeaderOverlapScan = {
  /** First `scrollTop` probed. */
  firstScrollTop: number;
  /** How far the scan advances between probes. */
  stepPx: number;
  /** Probes to run, or `null` to walk to the scroller's own maximum. */
  steps: number | null;
};

type HeaderOverlapProbe = {
  chipBehindHeader: boolean;
  hitIsHeader: boolean;
  scrolled: number;
};

/**
 * ISS-12307: the Branches list's Collaborators cell must not draw over the
 * sticky table header.
 *
 * The `+N` overflow chip carried `z-10`, the same z-index the grid header uses
 * (`table-grid-header-v2.tsx`). Equal z-index inside one stacking context is
 * broken by DOM order, and the rows come after the header — so the chip won the
 * tie and painted across the Collaborators header label while a row scrolled
 * beneath it.
 *
 * Shared by both shells because stacking is a property of the tree AROUND the
 * shared `Collaborators` component: each shell supplies its own scroll
 * container, page chrome and transform/filter ancestors, and any one of those
 * creates a new stacking context that changes which element wins the tie. A
 * green run on one surface therefore says nothing about the other.
 *
 * It has to be a real browser either way: jsdom applies no stylesheet and
 * computes no paint order, so the same assertion passes there whatever the
 * z-index says.
 */
export async function expectCollaboratorsCellUnderTableHeader(
  page: Page,
  options: {
    cellTimeoutMs?: number;
    chipLabel: string;
    scan: HeaderOverlapScan;
  }
): Promise<void> {
  // `role="gridcell"` is what makes this the first BODY cell: the column header
  // carries the same `data-column-id` and renders before every row, so the bare
  // attribute selector resolves to it and never holds a chip (whitlockk, PR #8657).
  const firstCell = page
    .locator(`[role="gridcell"][data-column-id="${COLLABORATORS_COLUMN}"]`)
    .first();
  await expect(firstCell).toBeVisible({ timeout: options.cellTimeoutMs });
  await expect(firstCell.getByText(options.chipLabel)).toBeVisible();

  const probe = await page.evaluate(probeChipAgainstHeader, {
    chipLabel: options.chipLabel,
    columnId: COLLABORATORS_COLUMN,
    scan: options.scan,
  });

  // Not vacuous: the hit below means nothing unless a chip really was behind
  // the header band at the probed point, and the scan says which scroll
  // position put it there.
  expect(probe.chipBehindHeader).toBe(true);
  expect(probe.scrolled).toBeGreaterThan(0);
  expect(probe.hitIsHeader).toBe(true);
}

/**
 * Aims at the CHIP, not at the column's centre. The stack is left-aligned in a
 * ~160px column, so a hit test at the header cell's midpoint lands beside the
 * chip and resolves to the header whether or not the bug is present.
 */
function probeChipAgainstHeader({
  chipLabel,
  columnId,
  scan,
}: {
  chipLabel: string;
  columnId: string;
  scan: HeaderOverlapScan;
}): HeaderOverlapProbe {
  const headerCell = document.querySelector<HTMLElement>(
    `[role="columnheader"][data-column-id="${columnId}"]`
  );
  if (!headerCell) {
    throw new Error(`no ${columnId} column header`);
  }
  // The header ROW is what carries `position: sticky`; the cell inherits its
  // placement from it, so the row is the node a hit must resolve inside.
  let headerRow: HTMLElement | null = headerCell;
  while (headerRow && getComputedStyle(headerRow).position !== "sticky") {
    headerRow = headerRow.parentElement;
  }
  let scroller: HTMLElement | null = headerCell;
  while (scroller && getComputedStyle(scroller).overflowY !== "auto") {
    scroller = scroller.parentElement;
  }
  if (!(headerRow && scroller)) {
    throw new Error("no sticky header row or scroll container");
  }

  const chipSpanningRow = (midY: number) =>
    Array.from(
      document.querySelectorAll<HTMLElement>(`[data-column-id="${columnId}"] *`)
    )
      .filter((node) => node.textContent === chipLabel)
      .find((chip) => {
        const rect = chip.getBoundingClientRect();
        return rect.top < midY && rect.bottom > midY;
      });

  const maxScrollTop = scroller.scrollHeight - scroller.clientHeight;
  const steps =
    scan.steps ??
    Math.floor((maxScrollTop - scan.firstScrollTop) / scan.stepPx) + 1;
  // Row height is not a constant this probe may assume, so walk the scroll by
  // small steps until a chip genuinely straddles the header's mid-line.
  for (let step = 0; step < steps; step += 1) {
    scroller.scrollTop = scan.firstScrollTop + step * scan.stepPx;
    const headerRect = headerRow.getBoundingClientRect();
    const midY = headerRect.top + headerRect.height / 2;
    const chip = chipSpanningRow(midY);
    if (chip) {
      const chipRect = chip.getBoundingClientRect();
      const hit = document.elementFromPoint(
        chipRect.left + chipRect.width / 2,
        midY
      );
      return {
        chipBehindHeader: true,
        hitIsHeader: hit !== null && headerRow.contains(hit),
        scrolled: scroller.scrollTop,
      };
    }
  }
  return {
    chipBehindHeader: false,
    hitIsHeader: false,
    scrolled: scroller.scrollTop,
  };
}
