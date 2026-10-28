import {
  DISPLAYED_SESSION_STATUS,
  type DisplayedSessionStatus,
  SESSION_STATUS,
  type SessionStatus,
} from "@repo/api/src/types/session-status";
import { describe, expect, it } from "vitest";
import { projectDisplayedSessionStatus } from "./session-status-projection";

const AWAITING = new Date("2026-05-20T17:05:00.000Z");
const ENDED = new Date("2026-05-20T17:10:00.000Z");

describe("projectDisplayedSessionStatus (FEA-4301)", () => {
  it("ISS-10364: no longer projects Waiting for an awaiting-input, non-ended, non-terminal row — it reads the raw active status", () => {
    expect(
      projectDisplayedSessionStatus({
        status: SESSION_STATUS.ACTIVE,
        awaitingInputSince: AWAITING,
        sessionEndedAt: null,
      })
    ).toBe(SESSION_STATUS.ACTIVE);
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
    // ISS-4559's fall-through: a row that cannot project Waiting falls through
    // to the raw `active` status, same as any other non-Waiting row. ISS-12430
    // retired the reconciliation that used to answer this one differently.
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

  it("ISS-10364: no longer folds a long-silent active row to Stale — it stays Active", () => {
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
    ).toBe(SESSION_STATUS.ACTIVE);
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

  it("ISS-10364: a null lastActivityAt with a long-ago sessionStartedAt still displays Active — the staleness fold that fed on this fallback is gone", () => {
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
    ).toBe(SESSION_STATUS.ACTIVE);
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

  it("ISS-10364: a long-silent awaiting-input row now displays Active — both the Waiting projection and the staleness fold are gone", () => {
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
    ).toBe(SESSION_STATUS.ACTIVE);
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

  it("ISS-10364: an unrecognized status now fails OPEN to Active, matching the version-skew compatibility path", () => {
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
    ).toBe(SESSION_STATUS.ACTIVE);
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

/**
 * ISS-7019: ported from `projections.session-state.test.ts`, which covered the
 * same contract against the deleted `toAgentSessionState`. The subject moved —
 * the detail Status row now derives from this projection — so the coverage
 * follows it rather than being dropped with the function.
 */
describe("projectDisplayedSessionStatus — exhaustive lifecycle mapping", () => {
  // ISS-8485: a pinned instant, not `new Date()`. The projection folds a
  // long-silent row to Stale, so a fixture whose anchor is "now" was asserting
  // against a clock the assertion could not name — and the freshness rule in the
  // root AGENTS.md requires the cutoff be pinned.
  const NOW = new Date("2026-05-20T17:00:00.000Z");

  it("maps EVERY lifecycle status to the exact status it displays", () => {
    // ISS-8485: this asserted `toBeDefined()` and `not.toBe("")` — which every
    // legal value satisfies, and so does every ILLEGAL one that is a non-empty
    // string. Measured: stubbing `projectDisplayedSessionStatus` to return
    // `unknown` for every input left this case green, so the whole mapping it
    // claims to cover was unpinned.
    //
    // A total `Record<SessionStatus, …>` rather than a loop over the const: it
    // keeps the "a member added to SESSION_STATUS is covered the moment it
    // exists" property (a widened union fails `tsc` here), and unlike the loop
    // it also has to say what each member MEANS.
    const expected: Record<SessionStatus, DisplayedSessionStatus> = {
      [SESSION_STATUS.ACTIVE]: DISPLAYED_SESSION_STATUS.ACTIVE,
      [SESSION_STATUS.INACTIVE]: DISPLAYED_SESSION_STATUS.INACTIVE,
      [SESSION_STATUS.ERROR]: DISPLAYED_SESSION_STATUS.ERROR,
    };

    const projected = Object.fromEntries(
      Object.values(SESSION_STATUS).map((status) => [
        status,
        projectDisplayedSessionStatus(
          {
            status,
            awaitingInputSince: null,
            sessionEndedAt: null,
            lastActivityAt: NOW,
            sessionStartedAt: NOW,
          },
          NOW
        ),
      ])
    );
    expect(projected).toEqual(expected);
  });

  it("lands every lifecycle status on a value the displayed vocabulary declares", () => {
    // The weaker claim the deleted assertions were reaching for, stated so it
    // can actually fail: a projection that invented a spelling no badge, facet,
    // or rank models would pass `toBeDefined()` and reds here.
    const displayedVocabulary = new Set<string>(
      Object.values(DISPLAYED_SESSION_STATUS)
    );
    for (const status of Object.values(SESSION_STATUS)) {
      expect(
        displayedVocabulary.has(
          projectDisplayedSessionStatus(
            {
              status,
              awaitingInputSince: null,
              sessionEndedAt: null,
              lastActivityAt: NOW,
              sessionStartedAt: NOW,
            },
            NOW
          )
        )
      ).toBe(true);
    }
  });
});
