import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
  STALE_SESSION_DISPLAY_THRESHOLD_HOURS,
} from "@repo/api/src/types/session-status";
import { resolveDisplayedSessionStatusWithWaiting } from "@repo/app/agents/lib/session-displayed-status-with-waiting";
import { describe, expect, it } from "vitest";

/**
 * ISS-6455 (wongk, #5099 review): the resolver reads `awaitingInputSince` and
 * `endedAt` as THREE states each — absent, valid, unreadable — and the three
 * must stay apart.
 *
 * The truthiness test this replaces collapsed two of them: a malformed
 * `awaitingInputSince` passed as present, and a malformed `endedAt` read as "no
 * end recorded". Together they projected Waiting, which makes the Duration
 * window `running` and starts a clock against `now()` for a run this build
 * cannot show is still live. The Sessions LIST and the session DETAIL both
 * derive here, so the wrong answer lands on both surfaces at once.
 *
 * Wiring for each surface is asserted where that surface is mapped
 * (`session-table-row.test.ts`, `session-detail-duration-window.test.ts`); this
 * file pins the matrix those two share.
 */

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date("2026-06-17T12:00:00.000Z");
const STARTED_AT = new Date(NOW.getTime() - 60 * HOUR_MS);
/** Comfortably past the display cutoff, so the fold is not a boundary accident. */
const SILENT_SINCE = new Date(
  NOW.getTime() - (STALE_SESSION_DISPLAY_THRESHOLD_HOURS + 6) * HOUR_MS
);
const AWAITING_SINCE = new Date(NOW.getTime() - 30 * HOUR_MS);
/** What `new Date(...)` yields for a malformed value from a skewed producer. */
const UNPARSEABLE = new Date("not-a-date");

function resolveFor(
  overrides: Partial<
    Parameters<typeof resolveDisplayedSessionStatusWithWaiting>[0]
  > = {}
) {
  return resolveDisplayedSessionStatusWithWaiting({
    endedAt: null,
    lastActivityAt: SILENT_SINCE,
    now: NOW,
    startedAt: STARTED_AT,
    status: SESSION_STATUS.ACTIVE,
    ...overrides,
  });
}

describe("resolveDisplayedSessionStatusWithWaiting — instant evidence", () => {
  it("projects Waiting from a VALID awaiting-input instant on a silent live run", () => {
    // The control for everything below: this is the population the projection
    // exists for, and it must keep reading Waiting rather than folding to Stale.
    expect(resolveFor({ awaitingInputSince: AWAITING_SINCE })).toBe(
      DISPLAYED_SESSION_STATUS.WAITING
    );
  });

  it("takes the ordinary fold when the awaiting-input instant is ABSENT", () => {
    expect(resolveFor({ awaitingInputSince: null })).toBe(
      DISPLAYED_SESSION_STATUS.STALE
    );
  });

  it.each([
    ["alongside a valid awaiting-input instant", AWAITING_SINCE],
    // Independent of the other field, deliberately: an earlier cut only looked
    // at `endedAt` once `awaitingInputSince` happened to be populated, so one
    // corrupt end instant was fatal on one row and invisible on its twin.
    ["with no awaiting-input instant at all", null],
    ["alongside a malformed awaiting-input instant", UNPARSEABLE],
  ])("disclaims the state on an unreadable END instant, %s", (_case, awaitingInputSince) => {
    // `endedAt` is the field that decides whether the run is OVER. Unreadable,
    // this build cannot tell — and `unknown` is the load-bearing answer, not
    // just the honest one: its Duration window is `unmeasurable`, so the cell
    // renders the em-dash instead of a span still growing against `now()` for
    // a run that may well have finished (the ISS-4979 rule).
    expect(resolveFor({ awaitingInputSince, endedAt: UNPARSEABLE })).toBe(
      DISPLAYED_SESSION_STATUS.UNKNOWN
    );
  });

  it("takes the ordinary fold on an unreadable AWAITING-INPUT instant, without disclaiming the row", () => {
    // That field decides only whether the run is EXEMPT from the staleness fold.
    // Unreadable, there is no exemption to grant — but `status`, `startedAt` and
    // `lastActivityAt` are all still intact, so the row is folded, not
    // disclaimed. This one has been silent for 30 hours, so it folds.
    expect(resolveFor({ awaitingInputSince: UNPARSEABLE })).toBe(
      DISPLAYED_SESSION_STATUS.STALE
    );
  });

  it("keeps a LIVE run measurable when only its awaiting-input instant is unreadable", () => {
    // The regression that makes the case above load-bearing rather than
    // cosmetic: this run said something a minute ago and its span is perfectly
    // computable. Answering `unknown` would replace a real Duration with an
    // em-dash because ONE unrelated field is corrupt — the same over-claim as
    // the fabricated number, pointing the other way.
    expect(
      resolveFor({
        awaitingInputSince: UNPARSEABLE,
        lastActivityAt: new Date(NOW.getTime() - 60 * 1000),
      })
    ).toBe(SESSION_STATUS.ACTIVE);
  });

  it("lets a VALID end instant settle it before the awaiting-input test runs", () => {
    // ISS-4654: the run is over, so a straggler timestamp beside it is not a
    // claim that anyone is still waiting — and its span is bounded by its own
    // end instant either way.
    expect(
      resolveFor({
        awaitingInputSince: UNPARSEABLE,
        endedAt: new Date(NOW.getTime() - HOUR_MS),
      })
    ).toBe(DISPLAYED_SESSION_STATUS.STALE);
  });

  it("reads an empty-string instant as absent rather than as corrupt", () => {
    // A producer that serializes a missing timestamp as `""` is OMITTING it.
    // The truthiness test this replaces read it that way, and folding it into
    // the corrupt bucket would newly disclaim a state we can read perfectly
    // well.
    expect(resolveFor({ endedAt: "" })).toBe(DISPLAYED_SESSION_STATUS.STALE);
  });

  it("never projects from a status this build does not recognize", () => {
    // The fail-open the module is narrowed against: an unrecognized spelling
    // carrying `awaitingInputSince` stays Unknown rather than being timed.
    expect(
      resolveFor({
        awaitingInputSince: AWAITING_SINCE,
        status: "quantum-flux",
      })
    ).toBe(DISPLAYED_SESSION_STATUS.UNKNOWN);
  });

  it("keeps a TERMINAL status verbatim even when its end instant is unreadable", () => {
    // The recognized-live gate covers the unreadable verdict too. `inactive`
    // says the run is over whatever its end INSTANT parses to, so disclaiming it
    // would throw away the one fact this row does carry.
    expect(
      resolveFor({
        endedAt: UNPARSEABLE,
        status: SESSION_STATUS.INACTIVE,
      })
    ).toBe(SESSION_STATUS.INACTIVE);
  });
});
