"use client";

import { GRID_CELL_SELECTOR } from "@repo/design-system/lib/grid-table-navigation";
import {
  buildCellKey,
  LEAD_CELL_COLUMN_KEY,
} from "@repo/design-system/lib/grid-table-v2-rows";
import { type RefObject, useLayoutEffect, useRef, useState } from "react";

/**
 * The grid's single roving tab stop, whichever cell currently holds it — the
 * one cell `GridTableV2` has resolved as `effectiveActiveCellKey`. Asking the
 * DOM for it rather than composing a key here is what keeps this restore from
 * having a second opinion about where the entry point is.
 */
const ROVING_TAB_STOP_SELECTOR = `${GRID_CELL_SELECTOR}[tabindex="0"]`;

/**
 * The Sessions row a reader last opened, held across the route change that
 * unmounts the list.
 *
 * MODULE SCOPE, deliberately. Opening a session is a real route change on both
 * shells: the whole list surface unmounts, so a ref or component state cannot
 * carry the answer, and neither shell's session detail writes a referrer the
 * list could read back (`nav-referrer.ts` names a SURFACE, never a row). One
 * value, not a map — bounded by construction, and "the last row you opened" is
 * the whole question.
 *
 * READ-AND-CLEAR, so a resume is spent once. Without that, every later visit to
 * Sessions would keep resuming on a row the reader has long since finished with.
 * The read happens only once the gate has SETTLED OPEN: a closed gate, and the
 * window before the gate has answered at all, both leave the store untouched, so
 * the row survives to a visit that can actually honour it. A page turned before
 * the gate answers therefore carries its spend FORWARD to the moment the gate
 * settles open, which is where the clear actually happens.
 */
let lastOpenedSessionRowId: string | null = null;

/** Record that the reader opened this row's session from the Sessions list. */
export function rememberOpenedSessionRow(rowId: string): void {
  lastOpenedSessionRowId = rowId;
}

/** Consume the remembered row, leaving nothing behind for the next mount. */
export function takeOpenedSessionRow(): string | null {
  const rowId = lastOpenedSessionRowId;
  lastOpenedSessionRowId = null;
  return rowId;
}

/**
 * The three shapes ISS-9555's gate picks between, named rather than inlined so
 * the two closed ones are written down and cannot be read as each other.
 *
 * OFF says out loud that the flag-off surface is the pre-flag surface, where a
 * page turn drops the reader's focus on `<body>` and the roving tab stop always
 * resets to the first row.
 *
 * PENDING is NOT that surface. It is the window before PostHog has answered, in
 * which `useFeatureFlagEnabled*` reports `false` because nobody has been told
 * otherwise yet (FEA-1626). Collapsing the two is the defect this third shape
 * exists to stop: the resume is read from a module store exactly once per visit,
 * so consuming it against PENDING loses the reader's row for the whole visit
 * even after the flag flips on.
 */
export const SESSIONS_FOCUS_RESTORATION_PENDING = {
  gateSettled: false,
  restoreFocus: false,
} as const;
export const SESSIONS_FOCUS_RESTORATION_ON = {
  gateSettled: true,
  restoreFocus: true,
} as const;
export const SESSIONS_FOCUS_RESTORATION_OFF = {
  gateSettled: true,
  restoreFocus: false,
} as const;

/**
 * Keyboard focus restoration for the Sessions list (ISS-9555).
 *
 * Returns the cell key the grid should resume its roving tab stop on, or
 * `undefined` when there is nothing to resume — which is always, closed.
 *
 * TWO BEHAVIOURS, ONE GATE:
 *  - A PAGE TURN removes every cell. If the reader's focus was inside the grid
 *    it lands on `<body>`, so this takes it back to whichever cell the grid
 *    resolved as its tab stop. Guarded on the focus having actually fallen
 *    there: focus that is anywhere real is never moved, which is also what
 *    settles the race with `restoreEnteredCellFocus` — whichever of the two
 *    runs first, the other finds focus already somewhere and does nothing.
 *  - A RETURN to the list resumes the tab stop on the row that was opened, and
 *    only while the reader has not moved off the page they returned to. Turning
 *    a page SPENDS the resume — permanently, so coming back to that page does
 *    not re-offer a row the reader abandoned two pages ago — and the two
 *    behaviours therefore cannot disagree about where the stop belongs. Only a
 *    READER's turn counts: `pageSettled` is how the surface says its page index
 *    has stopped moving on its own, and a move before that is the surface's own
 *    clamp resolving, never a departure.
 *
 * `useLayoutEffect`, not `useEffect`: focus moves BEFORE paint, or the document
 * is announced with focus on `<body>` for a frame first — the reasoning shipped
 * with `use-import-splash-collapsed.ts`.
 *
 * THE SHARED GRID LAYOUT. PRD-727's narrow projection keeps the same body,
 * gridcells, and roving tab stop while hiding non-Name columns, so both restore
 * paths apply at wide and phone widths without a second layout-specific model.
 */
export function useSessionsFocusRestoration({
  gateSettled,
  pageIndex,
  pageSettled,
  regionRef,
  restoreFocus,
}: {
  gateSettled: boolean;
  pageIndex: number;
  pageSettled: boolean;
  regionRef: RefObject<HTMLElement | null>;
  restoreFocus: boolean;
}): string | undefined {
  const resumeRowId = useResumedRowId({
    gateSettled,
    pageIndex,
    pageSettled,
    restoreFocus,
  });
  const renderedPageRef = useRef(pageIndex);
  const focusWasInsideRef = useRef(false);
  // TRACKING is not gated on the RESTORE. `restoreFocus` is false throughout the
  // PENDING window too, so listeners gated on it are absent exactly while the
  // reader can already be entering the grid: the first page turn after the gate
  // opens then reads `focusWasInsideRef` as false and leaves focus on `<body>` —
  // the defect this hook exists to fix. Attached unless the gate has SETTLED
  // CLOSED, which is what keeps the flag-off surface the pre-flag surface.
  const trackFocus = restoreFocus || !gateSettled;

  useLayoutEffect(() => {
    const region = regionRef.current;
    if (!(region && trackFocus)) {
      return;
    }
    const markInside = () => {
      focusWasInsideRef.current = true;
    };
    const markLeft = (event: FocusEvent) => {
      const next = event.relatedTarget;
      // Focus MOVED to something real outside the grid. A removal reports no
      // `relatedTarget`, and must not clear this, because that removal is
      // precisely what the restore below exists to answer.
      if (next instanceof Node && !region.contains(next)) {
        focusWasInsideRef.current = false;
      }
    };
    region.addEventListener("focusin", markInside);
    region.addEventListener("focusout", markLeft);
    return () => {
      region.removeEventListener("focusin", markInside);
      region.removeEventListener("focusout", markLeft);
    };
  }, [regionRef, trackFocus]);

  useLayoutEffect(() => {
    const turnedFrom = renderedPageRef.current;
    renderedPageRef.current = pageIndex;
    const region = regionRef.current;
    if (!(region && restoreFocus) || turnedFrom === pageIndex) {
      return;
    }
    if (!focusWasInsideRef.current) {
      return;
    }
    const owner = region.ownerDocument;
    const active = owner.activeElement;
    // Focus is somewhere real — the paginator button that turned the page, or a
    // cell something else already restored. Never take it from there.
    if (active !== null && active !== owner.body) {
      return;
    }
    // No `preventScroll`, matching `focusCellFromRowClick`: a restore bringing
    // its cell into view is the intended behaviour on this grid, not a defect
    // to paper over here.
    region.querySelector<HTMLElement>(ROVING_TAB_STOP_SELECTOR)?.focus();
  }, [pageIndex, regionRef, restoreFocus]);

  if (resumeRowId === null) {
    return;
  }
  return buildCellKey(resumeRowId, LEAD_CELL_COLUMN_KEY);
}

/** One of the three shapes {@link resolveSessionsFocusRestoration} picks. */
export type SessionsFocusRestorationGate =
  | typeof SESSIONS_FOCUS_RESTORATION_OFF
  | typeof SESSIONS_FOCUS_RESTORATION_ON
  | typeof SESSIONS_FOCUS_RESTORATION_PENDING;

/**
 * The gate shape a `useFeatureFlagGateOptional` reading stands for.
 *
 * A helper rather than a ternary at the read site because there are THREE
 * answers and a nested ternary is not written in this repo — and because naming
 * the mapping in one place is what keeps "has not answered" from silently
 * becoming "answered no" at some future call site.
 */
export function resolveSessionsFocusRestoration({
  enabled,
  isReady,
}: {
  enabled: boolean;
  isReady: boolean;
}): SessionsFocusRestorationGate {
  if (!isReady) {
    return SESSIONS_FOCUS_RESTORATION_PENDING;
  }
  if (enabled) {
    return SESSIONS_FOCUS_RESTORATION_ON;
  }
  return SESSIONS_FOCUS_RESTORATION_OFF;
}

/**
 * The row this mount resumes on, or `null` — read from the module store at the
 * moment the gate SETTLES, not at first render.
 *
 * A `useState` initializer runs once and only once, so reading the store there
 * pinned the answer to whatever the flag said at that instant. On web PostHog
 * answers AFTER mount, so that instant reports the closed default for every real
 * load: the row was never consumed, `resumeRowId` stayed `null` for the whole
 * visit, and the flip that followed changed nothing. Both halves below are
 * load-bearing, and they are the same pair `EditorBodyStatusRegion` latches on:
 *
 *  - SETTLED, not first render. `gateSettled` is the FEA-1626 distinction
 *    between "closed" and "has not answered", carried in from the surface's one
 *    read of `useFeatureFlagGateOptional` — whose deadline is why an unreachable
 *    flag service still settles, closed, instead of leaving this armed forever.
 *  - CONSUMED ONCE, and only OPEN. A settled-closed gate latches without
 *    touching the store, so the reader's row is still theirs on a later visit;
 *    a later render cannot resurrect a resume the grid already honoured. An
 *    open gate consumes on BOTH ways out — honoured, or spent by a page turn —
 *    because a spend that left the store full is a row resumed on a later visit.
 *
 * `pageSettled` is the THIRD latch, and it guards the departure test rather than
 * the store. `pageIndex` is a derived index: it moves when the surface's clamp
 * resolves against a total that has only just arrived, and again when an
 * out-of-range request is written back down to the last real page. Both land
 * ON the page the reader is looking at, and both used to read as the reader
 * leaving it — so a cold return to a deep page spent the resume and cleared the
 * row that was painted right there. The mount page therefore FOLLOWS the index
 * until the surface says it has settled, and only then does a move mean a turn.
 *
 * The store is read in an effect rather than during render, so this hook is pure
 * — a render React discards before commit no longer spends the resume.
 */
function useResumedRowId({
  gateSettled,
  pageIndex,
  pageSettled,
  restoreFocus,
}: {
  gateSettled: boolean;
  pageIndex: number;
  pageSettled: boolean;
  restoreFocus: boolean;
}): string | null {
  const [resumeRowId, setResumeRowId] = useState<string | null>(null);
  const mountPageRef = useRef(pageIndex);
  // The mount page is latched from the first index the surface can HONESTLY
  // claim to be rendering, which on a cold return is not the first one it
  // offers. Until then the page moving is the surface's own clamp settling, and
  // reading that as the reader turning away spends their resume on the exact
  // return the feature exists for.
  const mountPageLatchedRef = useRef(pageSettled);
  const leftMountPageRef = useRef(false);
  const settledRef = useRef(false);
  const spentRef = useRef(false);
  // A mirror of the offered key, not a second source of truth: the effect below
  // has to know whether anything is CURRENTLY offered without listing
  // `resumeRowId` as a dependency, which would re-run it on the very commit the
  // offer causes. Every write below moves both together.
  const offeredRowIdRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (spentRef.current) {
      return;
    }
    if (mountPageLatchedRef.current) {
      if (pageIndex !== mountPageRef.current) {
        // The reader moved off the page the resume belongs to. Sticky, because
        // returning to that page must not re-offer a row they left behind, which
        // is what a bare `pageIndex === mountPage` guard did.
        leftMountPageRef.current = true;
      }
    } else {
      // Still unsettled: follow the index rather than judge it. A page the host
      // asked for that the clamp has not agreed with yet is not a page the
      // reader left.
      mountPageRef.current = pageIndex;
      mountPageLatchedRef.current = pageSettled;
    }
    if (!gateSettled) {
      // Nothing may touch the store while PostHog has not answered — including
      // a spend, which is why the turn above is only REMEMBERED here.
      return;
    }
    if (leftMountPageRef.current) {
      // SPENT, and a spend CLEARS. A page turned while the gate was still
      // pending reaches this branch with the store untouched, and leaving it
      // full would resume that abandoned row on some later, unrelated visit.
      spentRef.current = true;
      if (restoreFocus) {
        takeOpenedSessionRow();
      }
      // Withdraw only an offer that EXISTS. Setting state to the value it already
      // holds still costs React a pass over this surface — and nothing below it
      // is memoized, so that pass re-renders every row and cell (ISS-9556's
      // render budget). The common page turn offered nothing, so it must spend
      // no state update at all.
      if (offeredRowIdRef.current !== null) {
        offeredRowIdRef.current = null;
        setResumeRowId(null);
      }
      return;
    }
    if (settledRef.current) {
      return;
    }
    settledRef.current = true;
    const resumed = restoreFocus ? takeOpenedSessionRow() : null;
    if (resumed !== null) {
      offeredRowIdRef.current = resumed;
      setResumeRowId(resumed);
    }
  }, [gateSettled, pageIndex, pageSettled, restoreFocus]);

  return resumeRowId;
}
