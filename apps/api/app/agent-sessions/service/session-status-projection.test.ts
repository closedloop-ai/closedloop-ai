import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { describe, expect, it } from "vitest";
import {
  displayedStatusRank,
  projectDisplayedSessionStatus,
} from "./session-status-projection";

const AWAITING = new Date("2026-05-20T17:05:00.000Z");
const ENDED = new Date("2026-05-20T17:10:00.000Z");

describe("projectDisplayedSessionStatus (FEA-4301)", () => {
  it("projects an awaiting-input, non-ended, non-terminal row to Waiting even though it stores active", () => {
    expect(
      projectDisplayedSessionStatus({
        status: SESSION_STATUS.ACTIVE,
        awaitingInputSince: AWAITING,
        sessionEndedAt: null,
      })
    ).toBe(DISPLAYED_SESSION_STATUS.WAITING);
  });

  it("keeps the raw active status when the row is not awaiting input", () => {
    expect(
      projectDisplayedSessionStatus({
        status: SESSION_STATUS.ACTIVE,
        awaitingInputSince: null,
        sessionEndedAt: null,
      })
    ).toBe(SESSION_STATUS.ACTIVE);
  });

  it("does NOT project Waiting once the session has ended (mirrors the facet sessionEndedAt guard)", () => {
    expect(
      projectDisplayedSessionStatus({
        status: SESSION_STATUS.ACTIVE,
        awaitingInputSince: AWAITING,
        sessionEndedAt: ENDED,
      })
    ).toBe(SESSION_STATUS.ACTIVE);
  });

  it("does NOT project Waiting for a terminal status even with awaitingInputSince set", () => {
    for (const terminal of [SESSION_STATUS.INACTIVE, SESSION_STATUS.ERROR]) {
      expect(
        projectDisplayedSessionStatus({
          status: terminal,
          awaitingInputSince: AWAITING,
          sessionEndedAt: null,
        })
      ).toBe(terminal);
    }
  });
});

describe("projectDisplayedSessionStatus staleness + unknown folds (ISS-5366)", () => {
  const NOW = new Date("2026-05-20T17:00:00.000Z");
  /** Comfortably past STALE_SESSION_DISPLAY_THRESHOLD_HOURS (24). */
  const LONG_AGO = new Date("2026-05-15T17:00:00.000Z");
  const RECENT = new Date("2026-05-20T16:00:00.000Z");

  it("folds a long-silent active row to Stale, so the served status matches the badge", () => {
    // The defect this closes: the client mapper badged this row "Stale" while
    // the server served the raw `active`, so the Active facet returned a page
    // whose badges said Stale.
    expect(
      projectDisplayedSessionStatus(
        {
          status: SESSION_STATUS.ACTIVE,
          awaitingInputSince: null,
          sessionEndedAt: null,
          lastActivityAt: LONG_AGO,
          sessionStartedAt: LONG_AGO,
        },
        NOW
      )
    ).toBe(DISPLAYED_SESSION_STATUS.STALE);
  });

  it("keeps a recently-active row Active", () => {
    expect(
      projectDisplayedSessionStatus(
        {
          status: SESSION_STATUS.ACTIVE,
          awaitingInputSince: null,
          sessionEndedAt: null,
          lastActivityAt: RECENT,
          sessionStartedAt: LONG_AGO,
        },
        NOW
      )
    ).toBe(SESSION_STATUS.ACTIVE);
  });

  it("falls back to sessionStartedAt as the staleness anchor when lastActivityAt is null", () => {
    // wongk (#4324): reading only lastActivityAt would exempt precisely the
    // least-evidenced rows from the fold.
    expect(
      projectDisplayedSessionStatus(
        {
          status: SESSION_STATUS.ACTIVE,
          awaitingInputSince: null,
          sessionEndedAt: null,
          lastActivityAt: null,
          sessionStartedAt: LONG_AGO,
        },
        NOW
      )
    ).toBe(DISPLAYED_SESSION_STATUS.STALE);
  });

  it("does NOT fold to Stale when no timestamp is available at all", () => {
    // Absence of evidence is not evidence of staleness.
    expect(
      projectDisplayedSessionStatus(
        {
          status: SESSION_STATUS.ACTIVE,
          awaitingInputSince: null,
          sessionEndedAt: null,
          lastActivityAt: null,
          sessionStartedAt: null,
        },
        NOW
      )
    ).toBe(SESSION_STATUS.ACTIVE);
  });

  it("exempts an awaiting-input row from the staleness fold — Waiting is a stored fact, not an inference", () => {
    // A run blocked on a human for three days genuinely IS still awaiting input,
    // and the WAITING facet keys on awaitingInputSince with no cutoff.
    expect(
      projectDisplayedSessionStatus(
        {
          status: SESSION_STATUS.ACTIVE,
          awaitingInputSince: LONG_AGO,
          sessionEndedAt: null,
          lastActivityAt: LONG_AGO,
          sessionStartedAt: LONG_AGO,
        },
        NOW
      )
    ).toBe(DISPLAYED_SESSION_STATUS.WAITING);
  });

  it("exempts terminal statuses from the staleness fold — age does not expire a reached conclusion", () => {
    for (const terminal of [SESSION_STATUS.INACTIVE, SESSION_STATUS.ERROR]) {
      expect(
        projectDisplayedSessionStatus(
          {
            status: terminal,
            awaitingInputSince: null,
            sessionEndedAt: LONG_AGO,
            lastActivityAt: LONG_AGO,
            sessionStartedAt: LONG_AGO,
          },
          NOW
        )
      ).toBe(terminal);
    }
  });

  it("folds an unrecognized status to Unknown rather than fail-open Active", () => {
    expect(
      projectDisplayedSessionStatus(
        {
          status: "some-future-status",
          awaitingInputSince: null,
          sessionEndedAt: null,
          lastActivityAt: RECENT,
          sessionStartedAt: RECENT,
        },
        NOW
      )
    ).toBe(DISPLAYED_SESSION_STATUS.UNKNOWN);
  });

  it("is unchanged for callers that pass no staleness anchor (back-compat)", () => {
    // The FEA-4301 call shape keeps working: without timestamps only the
    // unrecognized-status fold applies.
    expect(
      projectDisplayedSessionStatus({
        status: SESSION_STATUS.ACTIVE,
        awaitingInputSince: null,
        sessionEndedAt: null,
      })
    ).toBe(SESSION_STATUS.ACTIVE);
  });
});

describe("displayedStatusRank (FEA-4301 / ISS-4586)", () => {
  it("ranks statuses in the lifecycle order Active < Waiting < Inactive < Error", () => {
    const order = [
      SESSION_STATUS.ACTIVE,
      DISPLAYED_SESSION_STATUS.WAITING,
      SESSION_STATUS.INACTIVE,
      SESSION_STATUS.ERROR,
    ];
    const ranks = order.map(displayedStatusRank);
    // Strictly increasing.
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThan(ranks[i - 1]);
    }
  });

  it("ranks an unknown status AFTER every known status so it degrades to the end", () => {
    const maxKnown = Math.max(
      ...[
        SESSION_STATUS.ACTIVE,
        DISPLAYED_SESSION_STATUS.WAITING,
        SESSION_STATUS.INACTIVE,
        SESSION_STATUS.ERROR,
      ].map(displayedStatusRank)
    );
    expect(displayedStatusRank("some-future-status")).toBeGreaterThan(maxKnown);
  });
});
