/**
 * ISS-9567 — the production wiring for the Sessions width axis, on the ONE
 * component both Sessions hosts mount.
 *
 * `use-sessions-view-state-column-widths.test.tsx` proves the hook hands the
 * axis back. Only this file proves the half that actually
 * reaches a reader: that a supplied width map becomes the grid's TRACK, and that
 * a resize is reported to the host instead of being swallowed into state that
 * dies with the mount. Delete the pass-through and the hook suite stays green
 * while every Sessions column renders at its declared default.
 *
 * Both Sessions hosts — `apps/app`'s `SessionsListV2Host` and the desktop
 * renderer's `sessions-v2-view` — mount THIS component and pass the props from
 * the same hook, so one wiring assertion covers both shells. What differs by
 * shell is the `persistKey` (`sessions:web` / `sessions:desktop`), not the seam.
 */

import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { pinSessionFixtureClock } from "@repo/app/test/mocks/session-fixture-clock";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createSessionCustomFieldFixture,
  createSessionTableRowFixture,
} from "../session-list-fixtures";
import {
  SESSION_CUSTOM_FIELD_WIDTH_PX,
  sessionsCustomFieldColumnId,
} from "../sessions-list-custom-fields";
import { SessionsListSurfaceV2 } from "../sessions-list-surface-v2";
import type { SessionsListViewState } from "../sessions-list-view-state";

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

const ROW = createSessionTableRowFixture({
  id: "session-column-widths",
  name: "agent/column-widths",
  status: "Active",
});

const WIDENED_COLUMN_ID = "status";
/**
 * The v2 handle interpolates the CURRENT width into its own accessible name, so
 * this matches the stem rather than the whole sentence — pinning the width here
 * would assert the same fact twice and break on a clamp change.
 */
const WIDENED_COLUMN_RESIZE_HANDLE = /^Resize Status column,/;
const PERSISTED_WIDTH_PX = 321;
const DRAG_DELTA_PX = 80;
const UNTOUCHED_COLUMN_ID = "model";

/**
 * A custom-field column exists on this surface and resizes like any other, and
 * since ISS-10356 its width is part of the saved view like any other.
 */
const CUSTOM_FIELD = createSessionCustomFieldFixture();
const CUSTOM_FIELD_COLUMN_ID = sessionsCustomFieldColumnId(CUSTOM_FIELD.id);
const CUSTOM_FIELD_RESIZE_HANDLE = /^Resize Summary column,/;
const CUSTOM_FIELDS = {
  fields: [CUSTOM_FIELD],
  valuesBySessionId: new Map(),
};

const VIEW: SessionsListViewState = {
  dateRange: DEFAULT_DATE_RANGE,
  facets: DEFAULT_SESSION_FACET_FILTERS,
  grouping: EMPTY_TABLE_GROUPING,
  page: 0,
  scopeUserId: null,
  sortBy: null,
  sortDir: "asc",
  visibleColumnIds: new Set([
    WIDENED_COLUMN_ID,
    UNTOUCHED_COLUMN_ID,
    CUSTOM_FIELD_COLUMN_ID,
    "repo",
    "updated",
  ]),
};

let restoreContainerWidth: (() => void) | null = null;

// jsdom implements no pointer capture; the drag path calls it (FEA-4168's own
// suite stubs it the same way).
beforeAll(() => {
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {
      // no-op
    };
    Element.prototype.releasePointerCapture = () => {
      // no-op
    };
  }
});

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

pinSessionFixtureClock();

function renderSurface(
  props: Partial<
    Pick<
      Parameters<typeof SessionsListSurfaceV2>[0],
      "columnWidths" | "customFields" | "onColumnWidthChange"
    >
  >
) {
  restoreContainerWidth = stubContainerWidthPx(1800);
  return render(
    <SessionsListSurfaceV2
      controlledView={{
        onChange: () => undefined,
        totalRows: 1,
        value: VIEW,
      }}
      rows={[ROW]}
      usage={undefined}
      {...props}
    />
  );
}

/**
 * The grid's own track string. `GridTableV2` puts it on every `role="row"`, so
 * a data row is where the resolved tracks are actually legible.
 */
function gridTemplateColumnsOf(container: HTMLElement): string {
  const row = container.querySelector<HTMLElement>("[data-grid-row-id]");
  if (!row) {
    throw new Error("the grid never rendered a row");
  }
  return row.style.gridTemplateColumns;
}

describe("SessionsListSurfaceV2 persisted column widths", () => {
  it("lays a supplied width over the declared default, for that column only", () => {
    const { container } = renderSurface({
      columnWidths: { [WIDENED_COLUMN_ID]: PERSISTED_WIDTH_PX },
    });

    const tracks = gridTemplateColumnsOf(container);
    expect(tracks).toContain(`${PERSISTED_WIDTH_PX}px`);
    // The other columns keep their declared tracks: the persisted record carries
    // only the widths a reader actually dragged, so replacing the seed with it
    // rather than laying it over would leave every untouched column with no
    // width at all.
    expect(tracks).not.toContain("undefinedpx");
    expect(tracks.split(" ").length).toBeGreaterThan(2);
  });

  it("renders the declared defaults when the host supplies no width map", () => {
    // The positive control for the case above: with no controlled map the
    // surface keeps its own state, as a host that persists no widths (the agent
    // invocations grid) mounts it.
    const { container } = renderSurface({});

    const tracks = gridTemplateColumnsOf(container);
    expect(tracks).not.toContain(`${PERSISTED_WIDTH_PX}px`);
    expect(tracks).not.toContain("undefinedpx");
  });

  it("reports a resize to the host instead of swallowing it into mount state", () => {
    const onColumnWidthChange = vi.fn();
    renderSurface({
      columnWidths: { [WIDENED_COLUMN_ID]: PERSISTED_WIDTH_PX },
      onColumnWidthChange,
    });

    const handle = screen.getByRole("button", {
      name: WIDENED_COLUMN_RESIZE_HANDLE,
    });
    fireEvent.pointerDown(handle, { button: 0, clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(handle, {
      clientX: 300 + DRAG_DELTA_PX,
      pointerId: 1,
    });
    fireEvent.pointerUp(handle, { pointerId: 1 });

    // The handler is what carries the drag into the saved view, and the exact
    // width is what proves WHICH base it measured from: `321 + 80`. A surface
    // that ignored the supplied map and resized its seeded default would report
    // the declared width plus the delta instead, so an `isGreaterThan` here
    // would pass against the very bug this file exists to catch.
    expect(onColumnWidthChange).toHaveBeenLastCalledWith(
      WIDENED_COLUMN_ID,
      PERSISTED_WIDTH_PX + DRAG_DELTA_PX
    );
  });

  it("reports a CUSTOM-FIELD resize to the host, and draws the width it hands back", () => {
    // ISS-10356 (Perrin, confirmed with Marisol): custom-field WIDTHS belong to the
    // saved view, so the drag reaches the host's setter like a built-in one.
    // Before it, these ids stayed in mount-local state and never reached it.
    const onColumnWidthChange = vi.fn();
    const { container } = renderSurface({
      columnWidths: { [CUSTOM_FIELD_COLUMN_ID]: PERSISTED_WIDTH_PX },
      customFields: CUSTOM_FIELDS,
      onColumnWidthChange,
    });

    expect(gridTemplateColumnsOf(container)).toContain(
      `${PERSISTED_WIDTH_PX}px`
    );

    const handle = screen.getByRole("button", {
      name: CUSTOM_FIELD_RESIZE_HANDLE,
    });
    fireEvent.pointerDown(handle, { button: 0, clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(handle, {
      clientX: 300 + DRAG_DELTA_PX,
      pointerId: 1,
    });
    fireEvent.pointerUp(handle, { pointerId: 1 });

    // Measured from the SUPPLIED width, which is what proves the drag started
    // from the saved view's value rather than the seed.
    expect(onColumnWidthChange).toHaveBeenLastCalledWith(
      CUSTOM_FIELD_COLUMN_ID,
      PERSISTED_WIDTH_PX + DRAG_DELTA_PX
    );
  });

  it("still resizes a CUSTOM-FIELD column when the host supplies no setter", () => {
    // marisolashgrove, PR #8117: with no setter from the host, the mount-local
    // seed is the only thing that moves the column.
    const { container } = renderSurface({ customFields: CUSTOM_FIELDS });
    const draggedTrack = `${SESSION_CUSTOM_FIELD_WIDTH_PX + DRAG_DELTA_PX}px`;
    expect(gridTemplateColumnsOf(container)).not.toContain(draggedTrack);

    const handle = screen.getByRole("button", {
      name: CUSTOM_FIELD_RESIZE_HANDLE,
    });
    fireEvent.pointerDown(handle, { button: 0, clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(handle, {
      clientX: 300 + DRAG_DELTA_PX,
      pointerId: 1,
    });
    fireEvent.pointerUp(handle, { pointerId: 1 });

    expect(gridTemplateColumnsOf(container)).toContain(draggedTrack);
  });
});
