import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { SESSIONS_TOGGLEABLE_COLUMNS } from "@repo/app/agents/hooks/use-sessions-view-state";
import { SESSIONS_LEAD_COLUMN_MIN_WIDTH_PX } from "@repo/app/agents/lib/sessions-table-columns";
import {
  columnBoundariesPx as boundariesForTemplate,
  trackWidthsPx as widthsForTemplate,
} from "@repo/app/test/grid-track-geometry";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSIONS_CONTENT_WIDTH } from "../../../../shared/window-defaults";
import { SessionsTableBody } from "../sessions-table-body";

/**
 * ISS-4889 on the DESKTOP adapter. The Sessions list is shared through
 * `packages/app`, but the two surfaces compose it differently — desktop mounts
 * it `hostScroll` inside its own bounded fixed-footer scroll region, web inside
 * the route's scroll region — and the clipped-column report was filed against
 * the Electron window. So the fold fit is asserted through the desktop's own
 * `SessionsTableBody` → `AgentSessionsListContent` → shared `SessionsTable`
 * chain, with the real table rendering, rather than assumed from the web test.
 *
 * The renderer suite has no `ResizeObserver`, so the measured container width is
 * stubbed explicitly — which is also what makes this fail on the unfitted layout
 * instead of silently passing on an unmeasured container.
 */

// The session name is a navigation-port `Link`; stub it to a plain anchor so the
// real table renders without standing up the desktop navigation adapter.
vi.mock("@repo/navigation/link", () => ({
  Link: (props: { href?: string; children?: ReactNode }) => (
    <a href={props.href}>{props.children}</a>
  ),
}));

/**
 * The desktop Sessions content area a FRESH window gives the grid, imported from
 * the default rather than re-declared so it cannot drift from the shipped width.
 * `DEFAULT_WINDOW_WIDTH` minus the 256px rail minus the inset gutter.
 */
const DESKTOP_CONTENT_WIDTH_PX = SESSIONS_CONTENT_WIDTH;

/**
 * The content area the clipping was originally REPORTED at, from the pre-widening
 * 1380px window. Kept as a second case rather than replaced (#4445 review): this
 * suite's whole premise is that desktop composes the list differently — the table
 * `hostScroll` sits inside its own bounded fixed-footer scroll region — and that
 * the fold fit is therefore asserted through the desktop `SessionsTableBody`
 * chain rather than assumed from the web test. Swapping 1108 out for the new
 * default would have left NO desktop-adapter assertion at the width ISS-4889 was
 * actually filed at, which is the one thing this file said it was for.
 *
 * Both widths sit in the same failing regime: the unfitted boundaries are
 * 300/480/612/712/892/1072/1220/…, so 1108 and 1128 alike fall inside the PR
 * track.
 */
const REPORTED_CONTENT_WIDTH_PX = 1108;

/**
 * The lead track's declared minimum, imported from the column geometry rather
 * than re-typed, so a change to the shipped minimum cannot leave this suite
 * asserting a width the grid no longer declares.
 *
 * ISS-5666 DOES reach this suite. `SessionsTableBody` composes
 * `SyncedSessionsTable`, which wires the `renderQualifiers` seam, so retiring
 * the `sessions-row-qualifiers-column` gate turned the `Signals` track on here
 * and dropped the lead to its chip-free floor. Both halves ride that seam, and
 * this chain has it — so unlike the ISS-5282 flag-off era, the shipped desktop
 * geometry is now the with-Signals one and that is what the numbers below pin.
 */
// ISS-5770: the `Signals` column is gone, so the narrower chip-free lead floor
// that paid for its track is gone with it and the lead has ONE floor again.
const LEAD_TRACK_BASE_PX = SESSIONS_LEAD_COLUMN_MIN_WIDTH_PX;

const DEFAULT_VISIBLE_COLUMNS = new Set<string>(
  SESSIONS_TOGGLEABLE_COLUMNS.map((column) => column.id)
);

let restoreContainerWidth: (() => void) | null = null;

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

function renderDesktopSessionsTableAt(containerWidthPx: number) {
  restoreContainerWidth = stubContainerWidthPx(containerWidthPx);
  render(
    <SessionsTableBody
      emptySignals={{ isUnavailable: false, hasActiveFilters: false }}
      hasData
      hostScroll
      isLoading={false}
      onClearFilters={() => {
        // not exercised here
      }}
      onRetry={() => {
        // not exercised here
      }}
      onSort={() => {
        // not exercised here
      }}
      sessions={[
        createAgentSessionListItemFixture({
          id: "ses-1",
          name: "agent/refactor-auth-guard",
        }),
      ]}
      sortBy={null}
      sortDir="desc"
      stallPhase="none"
      visibleColumns={DEFAULT_VISIBLE_COLUMNS}
    />
  );
}

function headerTemplate(): string {
  const headerRow = screen.getByText("Session").closest(".grid");
  if (!(headerRow instanceof HTMLElement)) {
    throw new Error("Could not find the sessions table header row");
  }
  return headerRow.style.gridTemplateColumns;
}

/**
 * Rendered track widths and their right edges, via the shared
 * `@repo/app/test/grid-track-geometry` helpers — the same derivation the web
 * adapter's suite uses, so the two surfaces cannot measure the grid differently.
 */
function trackWidthsPx(): number[] {
  return widthsForTemplate(headerTemplate());
}

function columnBoundariesPx(): number[] {
  return boundariesForTemplate(headerTemplate());
}

/**
 * Header labels in render order, so a column can be located by NAME rather than
 * by a hardcoded track index — an index silently points at a different column
 * the moment the order changes, which is exactly how the ISS-5315 reorder slipped
 * past this suite once already.
 */
function headerLabelsInOrder(): string[] {
  const headerRow = screen.getByText("Session").closest(".grid");
  if (!(headerRow instanceof HTMLElement)) {
    throw new Error("Could not find the sessions table header row");
  }
  return [...headerRow.children]
    .map((cell) => cell.textContent?.trim() ?? "")
    .filter((label) => label.length > 0);
}

/** Distance from the table's left edge to the LEFT edge of `label`'s column. */
function columnLeftEdgePx(label: string): number {
  const index = headerLabelsInOrder().indexOf(label);
  if (index < 0) {
    throw new Error(`No "${label}" column is rendered`);
  }
  return columnBoundariesPx()[index] - trackWidthsPx()[index];
}

describe("desktop Sessions table whole-column fold (ISS-4889)", () => {
  /**
   * Both the width a fresh window gives the grid AND the width the defect was
   * reported at, because the two answer different questions and neither covers
   * the other (#4445 review).
   *
   * `lastFittedBoundaryPx` is the rightmost UNFITTED column boundary at or
   * before the content width — the boundary the fold snaps to, and therefore the
   * point from which the lead absorbs the leftover.
   *
   * ISS-5770 moved these back: the lead floor is 300px again and the `Signals`
   * track sits between Status and Owner, so the unfitted boundaries are
   * 200/332/472/652/792/972/1152/1276/…. Both widths now fall inside Linked
   * branches and snap to the SAME boundary (972, the right edge of Repository);
   * they still differ in how much leftover the lead absorbs, which is the thing
   * this case measures.
   */
  const contentWidths = [
    {
      label: "the fresh-window content width",
      widthPx: DESKTOP_CONTENT_WIDTH_PX,
      // 1128 falls inside Linked branches, so Repository (972) is the last
      // ISS-5770: with the 140px Signals track gone the boundaries shift left —
      // lead 300, Status 432, Owner 612, Autonomy 752, Repository 932, Linked
      // branches 1112. 1128 falls inside Harness, so Linked branches (1112) is
      // the last whole boundary and the lead absorbs 16px.
      lastFittedBoundaryPx: 1112,
    },
    {
      label: "the reported ISS-4889 content width",
      widthPx: REPORTED_CONTENT_WIDTH_PX,
      // 1108 still falls inside Linked branches, so Repository (932) is the
      // last whole boundary and the lead absorbs 176px.
      lastFittedBoundaryPx: 932,
    },
  ];

  for (const { label, widthPx, lastFittedBoundaryPx } of contentWidths) {
    it(`renders no partially-visible column at ${label} (${widthPx}px)`, () => {
      renderDesktopSessionsTableAt(widthPx);

      // The container's right edge lands ON a column boundary, so no track
      // starts before the fold and ends after it. Fails on the unfitted layout,
      // where both widths land inside a track rather than on a boundary.
      expect(columnBoundariesPx()).toContain(widthPx);
    });

    it(`absorbs the leftover into the lead at ${label} (${widthPx}px), leaving the columns inside the fold at their declared widths`, () => {
      renderDesktopSessionsTableAt(widthPx);

      const widths = trackWidthsPx();
      // This is the assertion that moves; on the unfitted layout the lead is
      // still its declared minimum. It mirrors the web adapter's
      // `sessions-table-columns.test.tsx`, so the two surfaces cannot measure
      // the same grid differently.
      expect(widths[0]).toBe(
        LEAD_TRACK_BASE_PX + (widthPx - lastFittedBoundaryPx)
      );
      // Status / Owner / Autonomy keep their declared widths — the fit never
      // rewrites a data column, so a persisted resize is never overwritten.
      // ISS-5770 removed the 140px Signals track ISS-5666 had inserted between
      // Status and Owner, so Autonomy is the third data track again.
      expect(widths.slice(1, 4)).toEqual([132, 180, 140]);
    });

    // ISS-5315's own consequence on this surface, pinned rather than left to be
    // rediscovered as a regression. The prototype order puts Cost tenth, past
    // both content widths, so it is not on the first screen at rest. That is
    // acceptable ONLY because the ISS-4889 fold keeps the column whole: Cost
    // BEGINS at or after the fold boundary rather than straddling it, so the
    // figure is scrolled-to, never truncated into the `$772.3`-for-`$772.39`
    // lie ISS-4788 was filed against. Located by NAME rather than by a
    // hardcoded track index — an index silently points at a different column
    // the moment the order changes, which is exactly how the ISS-5315 reorder
    // slipped past this suite once already.
    it(`starts Cost at or after the fold at ${label} (${widthPx}px) rather than straddling it`, () => {
      renderDesktopSessionsTableAt(widthPx);

      expect(columnLeftEdgePx("Cost")).toBeGreaterThanOrEqual(widthPx);
    });
  }
});
