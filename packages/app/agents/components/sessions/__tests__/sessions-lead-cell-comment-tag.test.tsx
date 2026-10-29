import { SESSIONS_COMMENT_COUNT_TAG_FLAG_KEY } from "@repo/api/src/types/sessions-comment-count-tag-flag";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createAgentSessionListItemFixture } from "../session-list-fixtures";
import { SyncedSessionsTable } from "../synced-sessions-table";
import {
  getGridCellForSessionName,
  renderWithFlags,
} from "./synced-sessions-table.test-helpers";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

/**
 * FEA-4204 — the Sessions lead cell's comment-count tag.
 *
 * One fixture set drives every case, so no assertion here can be satisfied by an
 * implementation that always renders (or never does): the same table holds a
 * discussed row, a counted-zero row, an uncounted row, and a corrupt row, and
 * each is asserted against its neighbours.
 *
 * The counts are independent literals stated in this file. Nothing re-derives
 * them from the fixture, so a renderer that summed, doubled, or read the wrong
 * field disagrees with the test rather than agreeing with itself.
 */

/** Three separate discussions on one session — replies do NOT add to this. */
const DISCUSSED_COMMENT_COUNT = 3;
const DISCUSSED_TAG_TEXT = "3 comments";
/** A count of exactly one, to pin the singular the plural rule must not eat. */
const SINGLE_TAG_TEXT = "1 comment";

/** The lead column's header label — child 0 of every row. */
const LEAD_COLUMN_HEADER = "Session";
const DISCUSSED_NAME = "Discussed Session";
const SINGLE_COMMENT_NAME = "Single Comment Session";
const COUNTED_ZERO_NAME = "Counted Zero Session";
const UNCOUNTED_NAME = "Uncounted Session";

function buildRows() {
  return [
    createAgentSessionListItemFixture({
      id: "session-discussed",
      name: DISCUSSED_NAME,
      commentCount: DISCUSSED_COMMENT_COUNT,
    }),
    createAgentSessionListItemFixture({
      id: "session-single",
      name: SINGLE_COMMENT_NAME,
      commentCount: 1,
    }),
    // Counted, and the answer was none.
    createAgentSessionListItemFixture({
      id: "session-counted-zero",
      name: COUNTED_ZERO_NAME,
      commentCount: 0,
    }),
    // NEVER counted — the key is absent, which is what the desktop local read
    // and any version-skewed producer emit. Deliberately not `commentCount:
    // undefined` written out, because that is a present key and would not
    // exercise the absent case the wire actually produces.
    createAgentSessionListItemFixture({
      id: "session-uncounted",
      name: UNCOUNTED_NAME,
    }),
  ];
}

function renderTable(enabled: boolean) {
  renderWithFlags(
    <SyncedSessionsTable
      getSessionHref={(item) => `/sessions/${item.id}`}
      items={buildRows()}
      mode="expanded"
    />,
    enabled ? [SESSIONS_COMMENT_COUNT_TAG_FLAG_KEY] : []
  );
}

describe("Sessions lead cell comment-count tag", () => {
  it("tags only the rows that have comments, and names the number for a screen reader", () => {
    renderTable(true);

    // The tag is IN the lead cell, not merely somewhere on the page — a chip
    // that rendered into an adjacent column would still satisfy a bare
    // `getByText`.
    const discussedLead = getGridCellForSessionName(
      DISCUSSED_NAME,
      LEAD_COLUMN_HEADER
    );
    expect(within(discussedLead).getByText(DISCUSSED_TAG_TEXT)).toBeVisible();
    // The digits alone are not the contract. `CountCell` hides them from the
    // accessibility tree and carries the meaning in the `sr-only` sibling
    // asserted above, so a reader hears "3 comments" and never a bare "3" next
    // to an unlabelled speech bubble.
    expect(discussedLead.textContent).toContain(
      String(DISCUSSED_COMMENT_COUNT)
    );
    expect(
      within(
        getGridCellForSessionName(SINGLE_COMMENT_NAME, LEAD_COLUMN_HEADER)
      ).getByText(SINGLE_TAG_TEXT)
    ).toBeVisible();

    // A counted zero renders NO tag. The positive half of the pair is the row's
    // own name, so the negative assertion cannot pass by the row being absent.
    expect(leadCellText(COUNTED_ZERO_NAME)).toBe(COUNTED_ZERO_NAME);

    // ABSENT IS NOT ZERO. An uncounted row must render nothing — never the "0"
    // that would claim we looked and found none.
    expect(leadCellText(UNCOUNTED_NAME)).toBe(UNCOUNTED_NAME);
  });

  it("renders no tag on any row with the gate closed", () => {
    renderTable(false);

    // Same discussed row, same count, gate off: the lead cell is the session
    // name and nothing else, exactly as it ships today. Without this the whole
    // suite would pass against an ungated tag.
    expect(leadCellText(DISCUSSED_NAME)).toBe(DISCUSSED_NAME);
    expect(screen.queryByText(SINGLE_TAG_TEXT)).not.toBeInTheDocument();
  });

  it("renders no tag for a count that cannot be a cardinality", () => {
    // A negative, fractional, or non-finite count is corrupt data, not a small
    // count. Rendering "-2" or "1.5" beside a speech bubble would be the UI
    // lying about the record; browser code cannot log here, so the honest
    // outcome is the same silence an uncounted row gets.
    for (const badCount of [-2, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      const { unmount } = renderWithFlags(
        <SyncedSessionsTable
          getSessionHref={(item) => `/sessions/${item.id}`}
          items={[
            createAgentSessionListItemFixture({
              id: "session-corrupt",
              name: DISCUSSED_NAME,
              commentCount: badCount,
            }),
          ]}
          mode="expanded"
        />,
        [SESSIONS_COMMENT_COUNT_TAG_FLAG_KEY]
      );

      expect(leadCellText(DISCUSSED_NAME)).toBe(DISCUSSED_NAME);
      unmount();
    }
  });
});

/**
 * The whole text of a row's lead cell, for an EXACT match against the session
 * name — the "nothing else is in this cell" assertion.
 *
 * Exact text, not a `queryByText` miss, because the failures worth catching are
 * not absences but the WRONG presence. `CountCell` answers an unrenderable count
 * with the shared em-dash and an "unavailable" `sr-only` phrase, so a gate that
 * let a fractional or negative count reach the cell would hang a dash beside the
 * session name while every "is the tag text missing?" assertion stayed green. It
 * did: a `count > 0` gate survived the first version of this suite. Reading the
 * whole cell is the only check that fails on every way of putting something
 * there, and it doubles as the positive half — a row that never rendered has no
 * lead cell to read.
 */
function leadCellText(sessionName: string): string {
  return (
    getGridCellForSessionName(sessionName, LEAD_COLUMN_HEADER).textContent ?? ""
  ).trim();
}
