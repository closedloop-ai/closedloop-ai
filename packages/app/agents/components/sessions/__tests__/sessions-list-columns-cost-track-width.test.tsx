import type { SessionsSeamCellRenderer } from "@repo/app/agents/lib/session-list-row";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  SESSIONS_COLUMN_WIDTH_PX,
  SESSIONS_COST_COLUMN_ID,
} from "../../../lib/sessions-table-columns";
import { TOTAL_ESTIMATED_COST_SESSIONS_COST_COLUMN_WIDTH_PX } from "../../../lib/sessions-total-estimated-cost-columns";
import { useSessionsListColumns } from "../use-sessions-list-columns";

/**
 * ISS-9971's Cost track, ISS-10636's version of the question.
 *
 * The original contract was about a PostHog assignment resolving AFTER mount:
 * both adapters read an unresolved flag as CLOSED, so the track seeded at the
 * narrow 124px and the longer header truncated in it. That transition no longer
 * exists — the gate is retired and the widened track is the only seed — so what
 * is pinned now is the end state the reader actually gets, with NO flag seeded
 * (ISS-10636 AC-5), plus the drag precedence that outlived the gate.
 */

const EMPTY_SEAM_RENDERERS: ReadonlyMap<string, SessionsSeamCellRenderer> =
  new Map();
const VISIBLE_COLUMN_IDS: ReadonlySet<string> = new Set([
  SESSIONS_COST_COLUMN_ID,
]);
/**
 * The track the header used to truncate in. Distinct from the widened one, so a
 * seed that regressed to it fails the first case rather than passing by accident.
 */
const NARROW_COST_WIDTH_PX = SESSIONS_COLUMN_WIDTH_PX[SESSIONS_COST_COLUMN_ID];
/** A width no seed map carries, so only a reader's drag can produce it. */
const DRAGGED_COST_WIDTH_PX = 321;

function CostTrackProbe() {
  const { columnWidths, handleColumnWidthChange } = useSessionsListColumns({
    customFieldColumns: [],
    favoritesEnabled: false,
    isServerDriven: false,
    seamRenderers: EMPTY_SEAM_RENDERERS,
    showAddField: false,
    visibleColumnIds: VISIBLE_COLUMN_IDS,
  });
  return (
    <>
      <p>{`cost-track:${columnWidths[SESSIONS_COST_COLUMN_ID]}`}</p>
      <button
        onClick={() =>
          handleColumnWidthChange(
            SESSIONS_COST_COLUMN_ID,
            DRAGGED_COST_WIDTH_PX
          )
        }
        type="button"
      >
        resize
      </button>
    </>
  );
}

describe("the Cost track with no flag seeded (ISS-10636 AC-5)", () => {
  it("seeds the widened track the canonical header needs", () => {
    render(<CostTrackProbe />);

    expect(
      screen.getByText(
        `cost-track:${TOTAL_ESTIMATED_COST_SESSIONS_COST_COLUMN_WIDTH_PX}`
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(`cost-track:${NARROW_COST_WIDTH_PX}`)).toBeNull();
  });

  it("keeps a width the reader dragged across a re-render", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<CostTrackProbe />);

    await user.click(screen.getByRole("button", { name: "resize" }));
    rerender(<CostTrackProbe />);

    expect(
      screen.getByText(`cost-track:${DRAGGED_COST_WIDTH_PX}`)
    ).toBeInTheDocument();
  });
});
