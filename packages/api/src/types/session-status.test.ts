import { describe, expect, it } from "vitest";
import {
  DISPLAYED_SESSION_STATUS,
  isRecognizedSessionStatus,
  isSessionDisplayStale,
  normalizeDisplayedSessionStatus,
  normalizeSessionStatus,
  resolveDisplayedSessionStatus,
  resolveSessionDurationLifecycle,
  SESSION_STATUS,
  SessionDurationLifecycle,
  type SessionStatus,
  STALE_SESSION_DISPLAY_THRESHOLD_HOURS,
  TERMINAL_SESSION_STATUSES,
} from "./session-status.ts";
import { SESSION_STATUS_LABELS } from "./session-status-display.ts";

/**
 * Pins the canonical session-status string set (FEA-1718 / PLN-921 §8). These
 * exact values are the shared contract between `apps/api` (which writes the
 * value onto a SESSION-typed Artifact's `status` column), `packages/app`, and
 * the desktop main process. Changing a value here is a cross-package contract
 * change and must be deliberate — this test makes an accidental edit fail
 * loudly.
 *
 * `packages/design-system` is NOT one of those consumers: ISS-5592 gave it its
 * own independent copy, which this file deliberately does not constrain.
 *
 * ISS-4586: the canonical LIFECYCLE set is ACTIVE / INACTIVE / ERROR.
 * `completed` and `abandoned` are RETIRED (ISS-4654) and survive only as
 * inbound aliases that must fold through `normalizeSessionStatus`. `waiting` is
 * NOT a legacy alias — it is a current DISPLAY value on
 * `DISPLAYED_SESSION_STATUS`, projected per read from `awaitingInputSince`, and
 * the display fold preserves it.
 */
describe("SESSION_STATUS", () => {
  // ISS-5592: the LIFECYCLE set is exactly three. A member added here is a value
  // a producer can write, so this assertion is the guard on that claim.
  it("is exactly the three lifecycle values a row may store", () => {
    expect(SESSION_STATUS).toEqual({
      ACTIVE: "active",
      INACTIVE: "inactive",
      ERROR: "error",
    });
  });

  it("is a strict subset of the displayed vocabulary, sharing its values", () => {
    for (const [name, value] of Object.entries(SESSION_STATUS)) {
      expect(DISPLAYED_SESSION_STATUS).toHaveProperty(name, value);
    }
    expect(Object.keys(DISPLAYED_SESSION_STATUS).length).toBeGreaterThan(
      Object.keys(SESSION_STATUS).length
    );
  });
});

describe("DISPLAYED_SESSION_STATUS", () => {
  it("adds the three read-time derivations and nothing else", () => {
    expect(DISPLAYED_SESSION_STATUS).toEqual({
      ACTIVE: "active",
      INACTIVE: "inactive",
      ERROR: "error",
      // ISS-4654: `completed`/`abandoned` are RETIRED from both vocabularies.
      // They survive only as inbound aliases in the fold (asserted below).
      // `waiting` is a DISPLAY value backed by `awaitingInputSince`, never
      // stored.
      WAITING: "waiting",
      // ISS-4997: nothing persists it — it is where the display fold lands a
      // status it cannot classify, instead of ACTIVE.
      UNKNOWN: "unknown",
      // ISS-4998 (#4324 review): the OTHER display-only value — a liveness claim
      // that has expired. Deliberately NOT the same value as UNKNOWN: "we cannot
      // read this status" and "this run has been silent over a day" are
      // different facts, and only one of them is actionable.
      STALE: "stale",
    });
  });

  it("derives SessionStatus from the const values", () => {
    const values: readonly SessionStatus[] = Object.values(SESSION_STATUS);
    expect(new Set(values).size).toBe(Object.keys(SESSION_STATUS).length);
  });

  it("labels every value, including the new INACTIVE state", () => {
    expect(SESSION_STATUS_LABELS[SESSION_STATUS.INACTIVE]).toBe("Inactive");
    for (const value of Object.values(SESSION_STATUS)) {
      expect(SESSION_STATUS_LABELS[value]).toBeTruthy();
    }
  });

  it("treats INACTIVE and ERROR as the only terminals", () => {
    expect(TERMINAL_SESSION_STATUSES.has(SESSION_STATUS.INACTIVE)).toBe(true);
    expect(TERMINAL_SESSION_STATUSES.has(SESSION_STATUS.ERROR)).toBe(true);
    // ISS-4654: the legacy terminals are OUT of this set. The migration window
    // is closed — the cloud backfill collapsed those rows and the desktop's 0042
    // did the same locally — so nothing stores them any more. They still fold to
    // INACTIVE on the way in (asserted in the fold tests), which is what keeps a
    // straggler classified rather than resurrected as "running".
    expect(TERMINAL_SESSION_STATUSES.has("completed")).toBe(false);
    expect(TERMINAL_SESSION_STATUSES.has("abandoned")).toBe(false);
    expect(TERMINAL_SESSION_STATUSES.has(SESSION_STATUS.ACTIVE)).toBe(false);
    // ISS-4997: "we cannot say" is NOT an outcome. Treating it as terminal would
    // let the awaiting-input overlay and the terminal-state classifiers invent a
    // finish that never happened.
    expect(
      TERMINAL_SESSION_STATUSES.has(DISPLAYED_SESSION_STATUS.UNKNOWN)
    ).toBe(false);
    expect(
      TERMINAL_SESSION_STATUSES.has(DISPLAYED_SESSION_STATUS.WAITING)
    ).toBe(false);
  });
});

describe("normalizeSessionStatus (ISS-4586)", () => {
  it("passes the canonical values through unchanged", () => {
    expect(normalizeSessionStatus("active")).toBe(SESSION_STATUS.ACTIVE);
    expect(normalizeSessionStatus("inactive")).toBe(SESSION_STATUS.INACTIVE);
    expect(normalizeSessionStatus("error")).toBe(SESSION_STATUS.ERROR);
  });

  it("folds the display-only `waiting` into ACTIVE", () => {
    expect(normalizeSessionStatus("waiting")).toBe(SESSION_STATUS.ACTIVE);
  });

  it("no longer RECOGNIZES the retired `running`/`failed` aliases", () => {
    // ISS-5592 (owner ruling, 2026-08-15): the alias map is gone. `failed` was
    // manufactured by the desktop's own `canonicalSharedStatus` from a stored
    // `error`, and that rewrite went in the same change — so neither spelling
    // has a producer.
    //
    // Assert RECOGNITION, not the fold result. `normalizeSessionStatus` returned
    // ACTIVE for `running` BEFORE this change too (via the alias) and after it
    // (via fail-open), so asserting that alone is green either way — the shape
    // this review caught (#5120). Recognition is what actually changed.
    expect(isRecognizedSessionStatus("running")).toBe(false);
    expect(isRecognizedSessionStatus("failed")).toBe(false);
    expect(normalizeSessionStatus("running")).toBe(SESSION_STATUS.ACTIVE);
    expect(normalizeSessionStatus("failed")).toBe(SESSION_STATUS.ACTIVE);
  });

  it("treats an unknown / version-skewed value as ACTIVE (never invents a terminal outcome)", () => {
    // shafty023 P2: an unrecognized value must not fabricate a terminal-success
    // (INACTIVE) state; it surfaces as in-flight until a known value syncs.
    expect(normalizeSessionStatus("bogus")).toBe(SESSION_STATUS.ACTIVE);
    expect(normalizeSessionStatus("some_future_state")).toBe(
      SESSION_STATUS.ACTIVE
    );
  });
});

describe("normalizeDisplayedSessionStatus (ISS-4586)", () => {
  it("preserves waiting (the awaiting-input display sub-state), unlike the stored fold", () => {
    // The stored fold collapses waiting → active; the DISPLAY fold keeps it so
    // the Sessions list still renders a distinct "Waiting" badge.
    expect(normalizeDisplayedSessionStatus("waiting")).toBe(
      DISPLAYED_SESSION_STATUS.WAITING
    );
    expect(normalizeSessionStatus("waiting")).toBe(SESSION_STATUS.ACTIVE);
  });

  it("fails an unrecognized value open to active, the retired aliases included", () => {
    // Unknown → active (in-flight), never a fabricated terminal state. Since
    // ISS-5592 removed the alias map, `failed` is just another unrecognized
    // spelling and takes the same branch.
    expect(normalizeDisplayedSessionStatus("bogus")).toBe(
      SESSION_STATUS.ACTIVE
    );
    expect(normalizeDisplayedSessionStatus("failed")).toBe(
      SESSION_STATUS.ACTIVE
    );
  });
});

/**
 * ISS-4997 + ISS-4998 are one defect — a displayed status that fails OPEN to
 * "running" — so they are pinned against the one derivation that resolves both.
 */
describe("resolveDisplayedSessionStatus (ISS-4997 / ISS-4998)", () => {
  const NOW = new Date("2026-08-03T12:00:00.000Z");
  const FRESH = new Date("2026-08-03T11:00:00.000Z");
  // SES-78262's observed gap: 63.1 hours since last activity, still rendering
  // "Active" against a 24-hour reaper cutoff.
  const STALE_63H = new Date("2026-08-01T00:54:00.000Z");

  it("ISS-4997: an unrecognized status is UNKNOWN, never the live ACTIVE", () => {
    expect(
      resolveDisplayedSessionStatus({
        status: "some_future_state",
        lastActivityAt: FRESH,
        now: NOW,
      })
    ).toBe(DISPLAYED_SESSION_STATUS.UNKNOWN);
    expect(
      resolveDisplayedSessionStatus({
        status: "bogus",
        lastActivityAt: FRESH,
        now: NOW,
      })
    ).toBe(DISPLAYED_SESSION_STATUS.UNKNOWN);
  });

  it("ISS-4998: an `active` session silent for 63 hours is STALE, not ACTIVE", () => {
    // The observed SES-78262 gap. #4324 review: it resolves to STALE rather than
    // UNKNOWN — the session said nothing for 63 hours, which is a fact about the
    // run the reader can act on, not a gap in our vocabulary.
    expect(
      resolveDisplayedSessionStatus({
        status: SESSION_STATUS.ACTIVE,
        lastActivityAt: STALE_63H,
        now: NOW,
      })
    ).toBe(DISPLAYED_SESSION_STATUS.STALE);
  });

  it("ISS-4998: a `waiting` session past the cutoff STAYS Waiting — it is a stored fact, not an inference", () => {
    // `waiting` is projected from `awaitingInputSince` (a durable column), and
    // the WAITING facet predicate keys on that same column with no staleness
    // cutoff. Expiring it would both destroy the surface's most actionable
    // signal and make `Status = Waiting` return a page of "Unknown" badges —
    // manufacturing the exact list-vs-filter contradiction this batch removes.
    expect(
      resolveDisplayedSessionStatus({
        status: DISPLAYED_SESSION_STATUS.WAITING,
        lastActivityAt: STALE_63H,
        now: NOW,
      })
    ).toBe(DISPLAYED_SESSION_STATUS.WAITING);
  });

  it("leaves a genuinely-live session alone", () => {
    expect(
      resolveDisplayedSessionStatus({
        status: SESSION_STATUS.ACTIVE,
        lastActivityAt: FRESH,
        now: NOW,
      })
    ).toBe(SESSION_STATUS.ACTIVE);
    expect(
      resolveDisplayedSessionStatus({
        status: DISPLAYED_SESSION_STATUS.WAITING,
        lastActivityAt: FRESH,
        now: NOW,
      })
    ).toBe(DISPLAYED_SESSION_STATUS.WAITING);
  });

  it("does not expire a TERMINAL status — age does not make a reached conclusion less true", () => {
    expect(
      resolveDisplayedSessionStatus({
        status: SESSION_STATUS.ERROR,
        lastActivityAt: STALE_63H,
        now: NOW,
      })
    ).toBe(SESSION_STATUS.ERROR);
    // ISS-5592: `completed` is unrecognized now, so it displays Unknown rather
    // than Inactive. It still does not expire — the staleness fold only applies
    // to a value that resolved to ACTIVE, and Unknown asserts nothing either way.
    expect(
      resolveDisplayedSessionStatus({
        status: "completed",
        lastActivityAt: STALE_63H,
        now: NOW,
      })
    ).toBe(DISPLAYED_SESSION_STATUS.UNKNOWN);
  });

  it("treats a missing timestamp as absence of evidence, not evidence of staleness", () => {
    expect(
      resolveDisplayedSessionStatus({
        status: SESSION_STATUS.ACTIVE,
        lastActivityAt: null,
        now: NOW,
      })
    ).toBe(SESSION_STATUS.ACTIVE);
    expect(
      resolveDisplayedSessionStatus({
        status: SESSION_STATUS.ACTIVE,
        lastActivityAt: "not-a-date",
        now: NOW,
      })
    ).toBe(SESSION_STATUS.ACTIVE);
  });

  it("accepts the ISO string the API actually serializes", () => {
    expect(
      resolveDisplayedSessionStatus({
        status: SESSION_STATUS.ACTIVE,
        lastActivityAt: "2026-08-01T01:51:03.898Z",
        now: NOW,
      })
    ).toBe(DISPLAYED_SESSION_STATUS.STALE);
  });

  it("does not fire one minute inside the cutoff, and does one minute outside it", () => {
    const insideCutoff = new Date(
      NOW.getTime() - (STALE_SESSION_DISPLAY_THRESHOLD_HOURS * 60 - 1) * 60_000
    );
    const outsideCutoff = new Date(
      NOW.getTime() - (STALE_SESSION_DISPLAY_THRESHOLD_HOURS * 60 + 1) * 60_000
    );
    expect(
      resolveDisplayedSessionStatus({
        status: SESSION_STATUS.ACTIVE,
        lastActivityAt: insideCutoff,
        now: NOW,
      })
    ).toBe(SESSION_STATUS.ACTIVE);
    expect(
      resolveDisplayedSessionStatus({
        status: SESSION_STATUS.ACTIVE,
        lastActivityAt: outsideCutoff,
        now: NOW,
      })
    ).toBe(DISPLAYED_SESSION_STATUS.STALE);
  });

  it("resolves an inherited Object key as unrecognized rather than a prototype member", () => {
    // The fold is a lookup on an object literal and `status` is external input.
    for (const key of ["constructor", "toString", "__proto__"]) {
      expect(
        resolveDisplayedSessionStatus({
          status: key,
          lastActivityAt: FRESH,
          now: NOW,
        })
      ).toBe(DISPLAYED_SESSION_STATUS.UNKNOWN);
    }
  });

  it("keeps the legacy fail-open contract on the flag-off normalizers", () => {
    // The flag-off path must be byte-for-byte what it was: an unrecognized value
    // still folds to ACTIVE there. That is the behavior this batch dark-launches
    // a replacement for, not one it changes in place.
    expect(normalizeSessionStatus("some_future_state")).toBe(
      SESSION_STATUS.ACTIVE
    );
    expect(normalizeDisplayedSessionStatus("some_future_state")).toBe(
      SESSION_STATUS.ACTIVE
    );
    // wongk (#4324): the DISPLAY-ONLY members must ALSO take the fail-open
    // branch here, so the dark launch is inert for every consumer of these
    // normalizers — `status` is a free-form external column, so a producer
    // really can send either literal. The Documents table row registry is the
    // consumer that proved it matters: `sessionStatusToIcon` has no branch for
    // either value, so recognizing them here paired the label "Unknown"/"Stale"
    // with the in-progress icon, flag OFF.
    for (const displayOnly of [
      DISPLAYED_SESSION_STATUS.UNKNOWN,
      DISPLAYED_SESSION_STATUS.STALE,
    ]) {
      expect(normalizeSessionStatus(displayOnly)).toBe(SESSION_STATUS.ACTIVE);
      expect(normalizeDisplayedSessionStatus(displayOnly)).toBe(
        SESSION_STATUS.ACTIVE
      );
    }
  });

  it("distinguishes an unreadable status from a silent one (#4324)", () => {
    // The two conditions this batch exists to stop conflating. Both refuse to
    // claim liveness; they are NOT the same answer.
    expect(
      resolveDisplayedSessionStatus({
        status: "some_future_state",
        lastActivityAt: FRESH,
        now: NOW,
      })
    ).toBe(DISPLAYED_SESSION_STATUS.UNKNOWN);
    expect(
      resolveDisplayedSessionStatus({
        status: SESSION_STATUS.ACTIVE,
        lastActivityAt: new Date(NOW.getTime() - 63 * 60 * 60 * 1000),
        now: NOW,
      })
    ).toBe(DISPLAYED_SESSION_STATUS.STALE);
  });

  it("falls back to startedAt when the activity timestamp is absent or malformed (wongk, #4324)", () => {
    const longAgo = new Date(NOW.getTime() - 63 * 60 * 60 * 1000);
    // The reaper anchors on `lastActivityAt ?? sessionStartedAt`; the display
    // path must agree, or the LEAST-evidenced rows are the ones exempted from
    // the fold and read "Active" forever.
    for (const lastActivityAt of [null, undefined, "not-a-date"]) {
      expect(
        resolveDisplayedSessionStatus({
          status: SESSION_STATUS.ACTIVE,
          lastActivityAt,
          startedAt: longAgo,
          now: NOW,
        })
      ).toBe(DISPLAYED_SESSION_STATUS.STALE);
    }
    // A fresh start time is still evidence of life, so no fold.
    expect(
      resolveDisplayedSessionStatus({
        status: SESSION_STATUS.ACTIVE,
        lastActivityAt: null,
        startedAt: FRESH,
        now: NOW,
      })
    ).toBe(SESSION_STATUS.ACTIVE);
    // NEITHER timestamp is an absence of evidence, not evidence of staleness.
    expect(
      resolveDisplayedSessionStatus({
        status: SESSION_STATUS.ACTIVE,
        lastActivityAt: null,
        startedAt: null,
        now: NOW,
      })
    ).toBe(SESSION_STATUS.ACTIVE);
  });
});

describe("isSessionDisplayStale (ISS-4998)", () => {
  const NOW = new Date("2026-08-03T12:00:00.000Z");

  it("is exported so a surface can explain WHY a status reads Unknown", () => {
    expect(isSessionDisplayStale("2026-08-01T01:51:03.898Z", NOW)).toBe(true);
    expect(isSessionDisplayStale("2026-08-03T11:00:00.000Z", NOW)).toBe(false);
    expect(isSessionDisplayStale(null, NOW)).toBe(false);
  });

  it("does not treat an invalid timestamp as stale", () => {
    expect(isSessionDisplayStale("not-a-date", NOW)).toBe(false);
  });
});

describe("resolveSessionDurationLifecycle", () => {
  it("classifies absent and future statuses as indeterminate", () => {
    expect(resolveSessionDurationLifecycle(undefined)).toBe(
      SessionDurationLifecycle.Indeterminate
    );
    expect(resolveSessionDurationLifecycle("future_status")).toBe(
      SessionDurationLifecycle.Indeterminate
    );
  });

  it("folds canonical and legacy terminal statuses to ended", () => {
    for (const status of [
      SESSION_STATUS.INACTIVE,
      SESSION_STATUS.ERROR,
      // ISS-5592: `completed`/`abandoned` and then the `failed` alias left this
      // list as they left the vocabulary. Case folding is NOT an alias and stays.
      "Error",
    ]) {
      expect(resolveSessionDurationLifecycle(status)).toBe(
        SessionDurationLifecycle.Ended
      );
    }
  });

  it("classifies every retired spelling as Indeterminate for Duration", () => {
    // The claim a comment above used to make and nothing asserted (#5120 review).
    // A spelling this build cannot read is not evidence the run ended, so the
    // Duration cell must blank rather than measure.
    for (const status of ["running", "failed", "completed", "abandoned"]) {
      expect(resolveSessionDurationLifecycle(status)).toBe(
        SessionDurationLifecycle.Indeterminate
      );
    }
  });

  it("folds active and the waiting sub-state to running", () => {
    for (const status of [
      SESSION_STATUS.ACTIVE,
      DISPLAYED_SESSION_STATUS.WAITING,
    ]) {
      expect(resolveSessionDurationLifecycle(status)).toBe(
        SessionDurationLifecycle.Running
      );
    }
  });
});

/*
 * ISS-5592: the retired spellings are no longer RECOGNIZED at all.
 *
 * ISS-4654 kept `completed`/`abandoned` as inbound aliases folding to
 * `inactive`, on the argument that an unrecognized status resolves to ACTIVE and
 * would render a finished run as still running. Chris removed that tolerance on
 * 2026-08-14 and accepted exactly that consequence: the pair now takes the
 * fail-open branch like any other unmodelled spelling.
 *
 * These pin the new behavior rather than deleting the coverage, so a silent
 * reintroduction of either alias fails here.
 */
describe("ISS-5592: retired statuses are ordinary unrecognized values", () => {
  const retired = ["completed", "abandoned"];

  it("keeps them OUT of every vocabulary and label map", () => {
    for (const value of retired) {
      expect(Object.values(SESSION_STATUS)).not.toContain(value);
      expect(Object.values(DISPLAYED_SESSION_STATUS)).not.toContain(value);
      expect(TERMINAL_SESSION_STATUSES.has(value)).toBe(false);
      expect(Object.hasOwn(SESSION_STATUS_LABELS, value)).toBe(false);
    }
  });

  it("no longer folds them to INACTIVE — they fail open to ACTIVE", () => {
    // The accepted cost. A skewed producer that still sends `completed` now has
    // a FINISHED run stored as `active`, where it used to store `inactive`.
    for (const value of retired) {
      expect(normalizeSessionStatus(value)).toBe(SESSION_STATUS.ACTIVE);
      expect(normalizeDisplayedSessionStatus(value)).toBe(
        SESSION_STATUS.ACTIVE
      );
      expect(isRecognizedSessionStatus(value)).toBe(false);
    }
  });

  it("classifies them Indeterminate for Duration, not Ended", () => {
    for (const value of retired) {
      expect(resolveSessionDurationLifecycle(value)).toBe(
        SessionDurationLifecycle.Indeterminate
      );
    }
  });
});

/*
 * ISS-5981: the WRITE-side half of that asymmetry.
 *
 * ISS-4654 collapsed the stored rows with a one-shot backfill, but accepting a
 * retired spelling and STORING it are different things — and the ingest stored
 * it verbatim, so a version-skewed producer regrew the population the backfill
 * had just emptied. The ingest now folds through `normalizeSessionStatus`,
 * whose return is typed `SessionStatus`, so the type states what a comment used
 * to assert: only a lifecycle value can reach the column.
 */
describe("normalizeSessionStatus as the cloud persist fold (ISS-5981)", () => {
  it("is TOTAL — every input lands on a lifecycle value", () => {
    const lifecycle = new Set<string>(Object.values(SESSION_STATUS));
    const inputs = [
      ...Object.values(DISPLAYED_SESSION_STATUS),
      "completed",
      "abandoned",
      "running",
      "failed",
      "brand-new-status",
      "",
      "constructor",
      "__proto__",
    ];
    for (const value of inputs) {
      expect(lifecycle.has(normalizeSessionStatus(value))).toBe(true);
    }
  });

  it("folds each recognized spelling to what it MEANS", () => {
    // Non-terminal: the run is going.
    expect(normalizeSessionStatus(DISPLAYED_SESSION_STATUS.WAITING)).toBe(
      SESSION_STATUS.ACTIVE
    );
    // ISS-5592: `running`/`failed` are no longer recognized spellings; the
    // canonical members and the display-only `waiting` are the whole set.
    expect(normalizeSessionStatus(SESSION_STATUS.ERROR)).toBe(
      SESSION_STATUS.ERROR
    );
  });

  it("fails an UNRECOGNIZED value open to ACTIVE rather than storing it", () => {
    // Chris's call on ISS-5592: an unmodelled spelling is not a terminal claim,
    // so the row stays live and the reaper plus the display staleness cutoff
    // decide whether it is really still running. Coercing to `inactive` would
    // invent an outcome the producer never reported.
    expect(normalizeSessionStatus("brand-new-status")).toBe(
      SESSION_STATUS.ACTIVE
    );
  });

  it("does not resolve inherited object keys", () => {
    // `status` is free-form external input, so a bare index read would resolve
    // `constructor`/`__proto__` off the fold map's prototype.
    expect(normalizeSessionStatus("constructor")).toBe(SESSION_STATUS.ACTIVE);
    expect(normalizeSessionStatus("__proto__")).toBe(SESSION_STATUS.ACTIVE);
  });
});
