/**
 * ISS-9555 — the hook's own two guards: WHEN the page-turn restore must not
 * run, and WHEN the remembered row may be consumed.
 *
 * The page-turn restore itself is one line; every case in the first block is
 * about when it must NOT run, because a focus move the reader did not ask for is
 * worse than the `<body>` it replaces. The named failure mode is the race with
 * `restoreEnteredCellFocus`, which hands focus to a surviving cell when an
 * ENTERED cell is removed — a page turn removes every cell, so both want to act
 * on the same commit. "Focus is already somewhere real" is what settles it in
 * either order, and the second case below is that assertion.
 *
 * The second block is the module store: the gate has THREE answers, and the two
 * closed ones are not the same answer. A resume consumed while PostHog has not
 * replied is a resume lost for the whole visit, so these cases drive the gate
 * settling AFTER the first render, which is what every real web load does.
 *
 * The wiring these guards sit behind — the flag reader, the grid, the recorded
 * row — is `sessions-list-surface-v2-focus-restoration.test.tsx`.
 */

import {
  buildCellKey,
  LEAD_CELL_COLUMN_KEY,
} from "@repo/design-system/lib/grid-table-v2-rows";
import { render } from "@testing-library/react";
import { useRef } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  rememberOpenedSessionRow,
  SESSIONS_FOCUS_RESTORATION_OFF,
  SESSIONS_FOCUS_RESTORATION_ON,
  SESSIONS_FOCUS_RESTORATION_PENDING,
  takeOpenedSessionRow,
  useSessionsFocusRestoration,
} from "../use-sessions-focus-restoration";

const TAB_STOP_TEST_ID = "tab-stop";
const OTHER_CELL_TEST_ID = "other-cell";
const OUTSIDE_TEST_ID = "outside";
const RESUME_PROBE_TEST_ID = "resume-probe";
/** What the probe renders when the hook offers no key, so `""` stays readable. */
const NO_RESUME = "none";
const OPENED_ROW_ID = "ses-opened";

type GateShape = { gateSettled: boolean; restoreFocus: boolean };

function Harness({
  gateSettled,
  pageIndex,
  pageSettled,
  restoreFocus,
}: {
  gateSettled: boolean;
  pageIndex: number;
  pageSettled: boolean;
  restoreFocus: boolean;
}) {
  const regionRef = useRef<HTMLDivElement>(null);
  const resumeCellKey = useSessionsFocusRestoration({
    gateSettled,
    pageIndex,
    pageSettled,
    regionRef,
    restoreFocus,
  });
  return (
    <div>
      <div data-testid={RESUME_PROBE_TEST_ID}>{resumeCellKey ?? NO_RESUME}</div>
      <div ref={regionRef}>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: standing in for a
            grid cell, which carries exactly this roving tabindex. */}
        <div data-grid-cell="" data-testid={TAB_STOP_TEST_ID} tabIndex={0} />
        <div data-grid-cell="" data-testid={OTHER_CELL_TEST_ID} tabIndex={-1} />
      </div>
      <button data-testid={OUTSIDE_TEST_ID} type="button">
        Next page
      </button>
    </div>
  );
}

/**
 * `pageSettled` defaults TRUE because every case but the cold-return one below
 * is about a surface that has already stopped moving its own page index — which
 * is what makes a change to `pageIndex` there a reader's page turn.
 */
function renderHarness(gate: GateShape, pageIndex = 0, pageSettled = true) {
  const result = render(
    <Harness {...gate} pageIndex={pageIndex} pageSettled={pageSettled} />
  );
  const show = (
    next: GateShape,
    nextPageIndex: number,
    nextPageSettled = true
  ) =>
    result.rerender(
      <Harness
        {...next}
        pageIndex={nextPageIndex}
        pageSettled={nextPageSettled}
      />
    );
  return {
    ...result,
    show,
    turnPage: () => show(gate, 1),
  };
}

/** The key the hook is currently offering the grid, or {@link NO_RESUME}. */
function offeredResumeKey(): string {
  const probe = document.querySelector(
    `[data-testid="${RESUME_PROBE_TEST_ID}"]`
  );
  if (!probe) {
    throw new Error("the harness rendered no resume probe");
  }
  return probe.textContent ?? "";
}

beforeEach(() => {
  // The remembered row is module state, so a case that primed it would
  // otherwise decide the next one's result.
  takeOpenedSessionRow();
});

describe("useSessionsFocusRestoration page turn", () => {
  it("takes focus back to the grid's tab stop when it fell to the body", () => {
    const { getByTestId, turnPage } = renderHarness(
      SESSIONS_FOCUS_RESTORATION_ON
    );
    getByTestId(OTHER_CELL_TEST_ID).focus();
    getByTestId(OTHER_CELL_TEST_ID).blur();
    expect(document.activeElement).toBe(document.body);

    turnPage();

    expect(document.activeElement).toBe(getByTestId(TAB_STOP_TEST_ID));
  });

  it("leaves focus alone when something else already holds it", () => {
    const { getByTestId, turnPage } = renderHarness(
      SESSIONS_FOCUS_RESTORATION_ON
    );
    const survivor = getByTestId(OTHER_CELL_TEST_ID);
    survivor.focus();

    turnPage();

    // The `restoreEnteredCellFocus` race: whichever of the two ran first, the
    // other must find focus somewhere real and do nothing. Two `.focus()` calls
    // landing on one page turn is the defect.
    expect(document.activeElement).toBe(survivor);
  });

  it("does not take focus that was never in the grid", () => {
    const { getByTestId, turnPage } = renderHarness(
      SESSIONS_FOCUS_RESTORATION_ON
    );
    expect(document.activeElement).toBe(document.body);

    turnPage();

    // A clamp correcting the page on a fresh load turns the page with nobody in
    // the grid. Restoring there would be a steal, not a restore.
    expect(document.activeElement).toBe(document.body);
    expect(getByTestId(TAB_STOP_TEST_ID)).not.toBe(document.activeElement);
  });

  it("does not take focus back after the reader has left the grid", () => {
    const { getByTestId, turnPage } = renderHarness(
      SESSIONS_FOCUS_RESTORATION_ON
    );
    getByTestId(OTHER_CELL_TEST_ID).focus();
    getByTestId(OUTSIDE_TEST_ID).focus();
    getByTestId(OUTSIDE_TEST_ID).blur();

    turnPage();

    expect(document.activeElement).toBe(document.body);
  });

  it("takes focus back on the first page turn after the gate opens mid-visit", () => {
    const { getByTestId, show } = renderHarness(
      SESSIONS_FOCUS_RESTORATION_PENDING
    );
    // The reader is already in the grid while PostHog is silent — the window
    // every web load spends in, and the one the desktop adapter reports out
    // loud. `restoreFocus` is false here, exactly as it is when the gate is
    // settled closed.
    getByTestId(OTHER_CELL_TEST_ID).focus();
    getByTestId(OTHER_CELL_TEST_ID).blur();
    expect(document.activeElement).toBe(document.body);

    show(SESSIONS_FOCUS_RESTORATION_ON, 1);

    // TRACKING cannot be gated on the RESTORE. Listeners attached only once
    // `restoreFocus` turns true never saw this reader enter, so the first turn
    // after the flip reads as "focus was never inside" and abandons them on
    // `<body>` — the exact loss the feature exists to prevent.
    expect(document.activeElement).toBe(getByTestId(TAB_STOP_TEST_ID));
  });

  it("restores nothing while the gate is closed", () => {
    const { getByTestId, turnPage } = renderHarness(
      SESSIONS_FOCUS_RESTORATION_OFF
    );
    getByTestId(OTHER_CELL_TEST_ID).focus();
    getByTestId(OTHER_CELL_TEST_ID).blur();

    turnPage();

    expect(document.activeElement).toBe(document.body);
  });
});

describe("useSessionsFocusRestoration resume consumption", () => {
  it("offers the remembered row once the gate settles open after the first render", () => {
    rememberOpenedSessionRow(OPENED_ROW_ID);

    const { show } = renderHarness(SESSIONS_FOCUS_RESTORATION_PENDING);

    // PostHog has not answered. The flag READS closed here, and consuming
    // against that reading is what silently dropped the resume for the whole
    // visit — the bug this case exists to keep fixed.
    expect(offeredResumeKey()).toBe(NO_RESUME);

    show(SESSIONS_FOCUS_RESTORATION_ON, 0);

    expect(offeredResumeKey()).toBe(
      buildCellKey(OPENED_ROW_ID, LEAD_CELL_COLUMN_KEY)
    );
  });

  it("leaves the remembered row in the store while the gate is settled closed", () => {
    rememberOpenedSessionRow(OPENED_ROW_ID);

    renderHarness(SESSIONS_FOCUS_RESTORATION_OFF);

    expect(offeredResumeKey()).toBe(NO_RESUME);
    // A closed gate must not SPEND the row: the reader opened it, and a visit
    // that can honour the resume is still entitled to.
    expect(takeOpenedSessionRow()).toBe(OPENED_ROW_ID);
  });

  it("spends the resume on a page turn taken before the gate answers", () => {
    rememberOpenedSessionRow(OPENED_ROW_ID);

    const first = renderHarness(SESSIONS_FOCUS_RESTORATION_PENDING);
    // A SETTLED surface — its page index has stopped moving on its own — so this
    // is the reader working the paginator well inside the flag's resolution
    // deadline: the one path that marks the resume spent without ever reaching
    // the read.
    first.show(SESSIONS_FOCUS_RESTORATION_PENDING, 1);
    first.show(SESSIONS_FOCUS_RESTORATION_ON, 1);
    expect(offeredResumeKey()).toBe(NO_RESUME);
    first.unmount();

    renderHarness(SESSIONS_FOCUS_RESTORATION_ON);

    // A LATER visit, on the page the row belongs to. The spend has to have
    // EMPTIED the store, or this mount is handed a row the reader abandoned
    // pages ago and never asked to return to.
    expect(offeredResumeKey()).toBe(NO_RESUME);
  });

  it("keeps the resume when the page index moves before the surface settles", () => {
    rememberOpenedSessionRow(OPENED_ROW_ID);

    // A cold return to a deep page. The surface reports 0 while it has nothing
    // to clamp against, then the read lands and its page index moves to the one
    // the reader actually asked for — and the row they opened is painted there.
    // Counting that move as a departure spends the resume on the exact return
    // this feature exists for, so the mount page FOLLOWS the index until
    // `pageSettled` says it has stopped moving.
    const { show } = renderHarness(
      SESSIONS_FOCUS_RESTORATION_PENDING,
      0,
      false
    );
    show(SESSIONS_FOCUS_RESTORATION_PENDING, 3, false);
    show(SESSIONS_FOCUS_RESTORATION_PENDING, 3, true);

    show(SESSIONS_FOCUS_RESTORATION_ON, 3, true);

    expect(offeredResumeKey()).toBe(
      buildCellKey(OPENED_ROW_ID, LEAD_CELL_COLUMN_KEY)
    );
  });

  it("still spends the resume on a turn taken after the surface settles", () => {
    rememberOpenedSessionRow(OPENED_ROW_ID);

    const { show } = renderHarness(SESSIONS_FOCUS_RESTORATION_ON, 0, false);
    show(SESSIONS_FOCUS_RESTORATION_ON, 3, true);
    expect(offeredResumeKey()).toBe(
      buildCellKey(OPENED_ROW_ID, LEAD_CELL_COLUMN_KEY)
    );

    // The twin of the case above, on the same fixture: once the index has
    // settled, the NEXT move is the reader's. A fix that simply stopped
    // counting moves would keep the case above green and lose this one.
    show(SESSIONS_FOCUS_RESTORATION_ON, 4, true);

    expect(offeredResumeKey()).toBe(NO_RESUME);
  });

  it("spends the resume on a page turn and does not re-offer it on the way back", () => {
    rememberOpenedSessionRow(OPENED_ROW_ID);

    const { show } = renderHarness(SESSIONS_FOCUS_RESTORATION_ON);
    expect(offeredResumeKey()).toBe(
      buildCellKey(OPENED_ROW_ID, LEAD_CELL_COLUMN_KEY)
    );

    show(SESSIONS_FOCUS_RESTORATION_ON, 1);
    expect(offeredResumeKey()).toBe(NO_RESUME);

    show(SESSIONS_FOCUS_RESTORATION_ON, 0);

    // "Spent", which the hook's contract promises — not merely withheld while
    // the reader is elsewhere. A mouse-only paginator round trip must not put
    // the tab stop back on a row abandoned two pages ago.
    expect(offeredResumeKey()).toBe(NO_RESUME);
  });
});
