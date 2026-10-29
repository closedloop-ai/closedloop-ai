// FEA-4275 / ISS-5131: the Duration VALUE — the figure the Properties row
// draws and the Details tab (M3) will. Moved here from the row's test by
// PLN-2169 M2; the row's test now proves only that the row mounts this
// derivation.
//
// The #4409 review is what most of this file exists for: the value prints ONE
// measure, so it can never print a component larger than its own total, and a
// RUNNING session's number has to actually advance rather than freeze at mount.

import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SESSION_DURATION_TICK_MS } from "@repo/app/agents/lib/session-duration";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SessionDurationValue,
  type SessionDurationValueSession,
} from "../session-duration-value";

const VALUE_TEST_ID = "duration-value";
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

/** Render the value and return its flattened text content. */
function renderValue(session: SessionDurationValueSession): string {
  render(
    <span data-testid={VALUE_TEST_ID}>
      <SessionDurationValue session={session} />
    </span>
  );
  return valueText();
}

/** The value's current flattened text, re-read after a timer advance. */
function valueText(): string {
  return screen.getByTestId(VALUE_TEST_ID).textContent ?? "";
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionDurationValue: one measure, no decomposition (#4409)", () => {
  it("prints the corrected headline alone — no sub-facts, no qualifier", () => {
    const text = renderValue({
      status: SESSION_STATUS.INACTIVE,
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
    });

    expect(text).toContain("4h 54m");
    expect(text).not.toMatch(RETIRED_QUALIFIER);
    expect(text).not.toMatch(RETIRED_SUB_FACT_LABELS);
  });

  it("REGRESSION: cannot render a component larger than the total beside it", () => {
    // The ISS-5131 session verbatim (`019fb3e3`): activity ran ~170h past the
    // start while `endedAt` bounds a 31h 4m run, and the collector clamped
    // `activeAgent`/`waitingUser` to that SAME 170h activity window. Nothing
    // here may come from that other window, so the only safe assertion is that
    // none of its values appear at all.
    const text = renderValue({
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
    const text = renderValue({
      status: SESSION_STATUS.INACTIVE,
      startedAt: STARTED_AT,
      endedAt: null,
    });

    expect(text).toBe(EM_DASH);
  });

  it("keeps timing a legacy raw 'stale' status now that it folds to Active (ISS-10364)", () => {
    // ISS-10364 (operator ruling, 2026-09-23): `resolveDisplayedSessionStatus`
    // stopped treating the literal `"stale"` as a display-only sentinel — it
    // folds to `active` like the rest, so it times like an ordinary running
    // session, matching the Status cell beside it.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T12:00:00.000Z"));
    const text = renderValue({
      status: "stale",
      startedAt: STARTED_AT,
      endedAt: null,
    });

    // STARTED_AT 10:00, system time set to 12:00 — a 2h span.
    expect(text).toContain("2h 0m");
    expect(text).not.toContain(EM_DASH);
  });

  it("renders the em-dash for a terminal row with no end instant (whitlockk)", () => {
    // Driven by the canonical `error` so the assertion means what its name
    // says (the desktop `failed` alias ISS-5592 retired passed for the wrong
    // reason: unrecognized, not ended).
    expect(
      renderValue({ status: "error", startedAt: STARTED_AT, endedAt: null })
    ).toBe(EM_DASH);
  });
});

describe("SessionDurationValue: a running session's number advances (#4409)", () => {
  it("re-reads the clock on the shared tick instead of freezing at mount", () => {
    // The resolver takes `nowMs` and never reads the ambient clock, so a value
    // that did not tick would render a figure frozen at mount under a measure
    // that claims to reach `now` — false, not merely stale.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T12:00:00.000Z"));
    renderValue({
      status: SESSION_STATUS.ACTIVE,
      startedAt: STARTED_AT,
      endedAt: null,
    });
    expect(valueText()).toContain("2h 0m");

    act(() => {
      vi.advanceTimersByTime(SESSION_DURATION_TICK_MS * 2);
    });
    expect(valueText()).toContain("2h 1m");
  });

  it("keeps ticking for a run that is waiting on a human", () => {
    // ISS-5575 (#review, review-soul BLOCKING): the tick gate is the raw
    // status's duration lifecycle, not "can the displayed STATUS still change"
    // — that predicate answers false for an awaiting-input run while the run's
    // DURATION window is still `running`, which froze the figure at mount on
    // the cloud's common case (the server serves `waiting` on the wire).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T12:00:00.000Z"));
    renderValue({
      endedAt: null,
      startedAt: STARTED_AT,
      status: "waiting",
    });
    expect(valueText()).toContain("2h 0m");

    act(() => {
      vi.advanceTimersByTime(SESSION_DURATION_TICK_MS * 2);
    });
    expect(valueText()).toContain("2h 1m");
  });

  it("ignores a stale endedAt while the session is still running", () => {
    // ISS-5182 clears `endedAt` when an inactive session resumes; until then a
    // leftover value must not freeze the measure.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T13:00:00.000Z"));
    expect(
      renderValue({
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
    renderValue({
      status: SESSION_STATUS.INACTIVE,
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
