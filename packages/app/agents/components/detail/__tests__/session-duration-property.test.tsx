// FEA-4275 / ISS-5131: focused unit tests for the extracted
// SessionDurationProperty — the Properties-pane "Duration" row. Rendering the
// component (rather than only the resolver) pins the row through its real render
// path, and keeps this coverage out of the grandfathered
// agent-session-detail-view.test.tsx.
//
// The #4409 review is what most of this file exists for: the row prints ONE
// measure, so it can never print a component larger than its own total, and a
// RUNNING session's number has to actually advance rather than freeze at mount.

import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { SESSION_DURATION_TICK_MS } from "@repo/app/agents/lib/session-duration";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SessionDurationProperty,
  type SessionDurationPropertySession,
} from "../session-duration-property";

/** The Duration row's label column. */
const DURATION_LABEL = "Duration";
/** The em-dash the shared `GridEmptyValue` renders for an absent value. */
const EM_DASH = "—";
/**
 * The retired sub-fact labels. Asserted ABSENT: they were the collector's
 * turn-gap projection, clamped to a window anchored on last activity, so beside
 * the corrected headline they could exceed the number they qualified.
 */
const RETIRED_SUB_FACT_LABELS = /active|waiting on you|idle/i;
/** The retired measure qualifier — the row is already labelled "Duration". */
const RETIRED_QUALIFIER = /wall/i;

/** Bounds spanning 4h 54m — the ISS-4631 SES-74818 reported span. */
const STARTED_AT = "2026-07-30T10:00:00.000Z";
const ENDED_AT = "2026-07-30T14:54:00.000Z";

/** Render the row and return its flattened text content. */
function renderRow(session: SessionDurationPropertySession): string {
  render(<SessionDurationProperty session={session} />);
  return rowText();
}

/** The row's current flattened text, re-read after a timer advance. */
function rowText(): string {
  return (
    screen.getByText(DURATION_LABEL).closest(".prd-prop")?.textContent ?? ""
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionDurationProperty: one measure, no decomposition (#4409)", () => {
  it("prints the corrected headline alone — no sub-facts, no qualifier", () => {
    const text = renderRow({
      status: SESSION_STATUS.INACTIVE,
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
    });

    expect(text).toContain("4h 54m");
    // The row is already labelled Duration; "wall" separated nothing once
    // Duration became a plain start-to-end clock span, and the timeline axis on
    // the same screen says "calendar span" precisely to stay out of its way.
    expect(text).not.toMatch(RETIRED_QUALIFIER);
    expect(text).not.toMatch(RETIRED_SUB_FACT_LABELS);
  });

  it("REGRESSION: cannot render a component larger than the total beside it", () => {
    // The ISS-5131 session verbatim (`019fb3e3`): activity ran ~170h past the
    // start while `endedAt` bounds a 31h 4m run, and the collector clamped
    // `activeAgent`/`waitingUser` to that SAME 170h activity window
    // (`session-trace-duration.ts`, FEA-3582). Printing the corrected 31h
    // headline beside a 40h "active" is a component exceeding its total, in a
    // pipe-separated list that reads as a sum. Nothing on this row may come from
    // that other window, so the only safe assertion is that none of its values
    // appear at all.
    const text = renderRow({
      status: SESSION_STATUS.INACTIVE,
      startedAt: "2026-07-28T14:58:31.028Z",
      endedAt: "2026-07-29T22:02:53.365Z",
    });

    expect(text).toContain("31h 4m");
    expect(text).not.toContain("170h");
    expect(text).not.toContain("40h");
    expect(text).not.toMatch(RETIRED_SUB_FACT_LABELS);
  });

  it("renders the shared em-dash when the span is unmeasurable, never a fabricated 0s", () => {
    // Terminal with no end instant. One instant is not a span.
    const text = renderRow({
      status: SESSION_STATUS.INACTIVE,
      startedAt: STARTED_AT,
      endedAt: null,
    });

    expect(text).toContain(EM_DASH);
    expect(text).not.toContain("0s");
  });

  it("renders the em-dash for a STALE row, matching the Status cell beside it", () => {
    // A row whose Status reads "Unknown" must not sit next to a Duration
    // confidently climbing against the clock.
    const text = renderRow({
      status: DISPLAYED_SESSION_STATUS.STALE,
      startedAt: STARTED_AT,
      endedAt: null,
    });

    expect(text).toContain(EM_DASH);
  });

  it("renders the em-dash for a terminal row with no end instant (wongk)", () => {
    // Was pinned through the desktop `failed` alias, which ISS-5592 retired —
    // and which passed for the wrong reason afterwards (unrecognized, not
    // ended). Driven by the canonical `error` so the assertion means what its
    // name says.
    expect(
      renderRow({ status: "error", startedAt: STARTED_AT, endedAt: null })
    ).toContain(EM_DASH);
  });
});

describe("SessionDurationProperty: a running session's number advances (#4409)", () => {
  it("re-reads the clock on the shared tick instead of freezing at mount", () => {
    // The resolver takes `nowMs` and never reads the ambient clock, so a row
    // that did not tick would render a value frozen at mount under a measure
    // that claims to reach `now` — false, not merely stale.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T12:00:00.000Z"));
    render(
      <SessionDurationProperty
        session={{
          status: SESSION_STATUS.ACTIVE,
          startedAt: STARTED_AT,
          endedAt: null,
        }}
      />
    );
    expect(rowText()).toContain("2h 0m");

    act(() => {
      vi.advanceTimersByTime(SESSION_DURATION_TICK_MS * 2);
    });
    expect(rowText()).toContain("2h 1m");
  });

  it("keeps ticking for a run that is waiting on a human", () => {
    // ISS-5575 (#review, review-soul BLOCKING): the tick gate moved off the
    // window (which is now downstream of `now`) and onto the raw status. Gating
    // it on "can the displayed STATUS still change" looked equivalent and was
    // not: that predicate answers false for an awaiting-input run — the
    // staleness fold deliberately exempts one — while the run's DURATION window
    // is still `running`. The row then froze at mount under a "Start to now"
    // caption, on the cloud's common case, since the server serves `waiting` on
    // the wire for every awaiting-input session.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T12:00:00.000Z"));
    render(
      <SessionDurationProperty
        session={{
          endedAt: null,
          startedAt: STARTED_AT,
          status: DISPLAYED_SESSION_STATUS.WAITING,
        }}
      />
    );
    expect(rowText()).toContain("2h 0m");

    act(() => {
      vi.advanceTimersByTime(SESSION_DURATION_TICK_MS * 2);
    });
    expect(rowText()).toContain("2h 1m");
  });

  it("ignores a stale endedAt while the session is still running", () => {
    // ISS-5182 clears `endedAt` when an inactive session resumes; until then a
    // leftover value must not freeze the measure.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T13:00:00.000Z"));
    expect(
      renderRow({
        status: SESSION_STATUS.ACTIVE,
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
      })
    ).toContain("3h 0m");
  });

  it("runs NO timer once the window is bounded", () => {
    // A terminal span cannot change, so a detail page left open on one must not
    // re-render on a timer forever.
    vi.useFakeTimers();
    render(
      <SessionDurationProperty
        session={{
          status: SESSION_STATUS.INACTIVE,
          startedAt: STARTED_AT,
          endedAt: ENDED_AT,
        }}
      />
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
