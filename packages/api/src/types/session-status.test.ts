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

  it("equals the displayed vocabulary (ISS-10364 retired every read-time derivation)", () => {
    for (const [name, value] of Object.entries(SESSION_STATUS)) {
      expect(DISPLAYED_SESSION_STATUS).toHaveProperty(name, value);
    }
    expect(Object.keys(DISPLAYED_SESSION_STATUS).length).toBe(
      Object.keys(SESSION_STATUS).length
    );
  });
});

describe("DISPLAYED_SESSION_STATUS", () => {
  /*
   * ISS-10364 (operator ruling, Cosimo Corrigan, 2026-09-23/24): "Unparsable
   * status are already converted to Active on import. Don't distinguish
   * between active and stale", then "let's drop waiting as well". This used
   * to assert DISPLAYED_SESSION_STATUS added WAITING/UNKNOWN/STALE to the
   * lifecycle set; all three are retired, so it is now exactly SESSION_STATUS
   * under a second name.
   */
  it("is exactly the lifecycle set, with no read-time derivation left", () => {
    expect(DISPLAYED_SESSION_STATUS).toEqual({
      ACTIVE: "active",
      INACTIVE: "inactive",
      ERROR: "error",
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
    // davetho P2: an unrecognized value must not fabricate a terminal-success
    // (INACTIVE) state; it surfaces as in-flight until a known value syncs.
    expect(normalizeSessionStatus("bogus")).toBe(SESSION_STATUS.ACTIVE);
    expect(normalizeSessionStatus("some_future_state")).toBe(
      SESSION_STATUS.ACTIVE
    );
  });
});

describe("normalizeDisplayedSessionStatus (ISS-4586)", () => {
  /*
   * ISS-10364 (operator ruling, 2026-09-23/24): "let's drop waiting as well".
   * This used to assert the DISPLAY fold preserved `waiting`, distinct from
   * the stored fold collapsing it — the Sessions list rendered a distinct
   * "Waiting" badge. Kept as a counterfactual rather than deleted: the two
   * folds must still agree, just on ACTIVE now that neither produces a
   * display-only word.
   */
  it("ISS-10364: no longer preserves waiting — both folds agree on ACTIVE", () => {
    expect(normalizeDisplayedSessionStatus("waiting")).toBe(
      SESSION_STATUS.ACTIVE
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
describe("resolveDisplayedSessionStatus (ISS-10364)", () => {
  const NOW = new Date("2026-08-03T12:00:00.000Z");
  const FRESH = new Date("2026-08-03T11:00:00.000Z");
  // SES-78262's observed gap: 63.1 hours since last activity. It used to fold to
  // the display-only `stale`; the operator ruled on 2026-09-23 that active and
  // stale are not to be distinguished, so it must now change nothing.
  const STALE_63H = new Date("2026-08-01T00:54:00.000Z");

  /*
   * ISS-10364, Cosimo Corrigan 2026-09-23: "Unparsable status are already
   * converted to Active on import. Don't distinguish between active and stale",
   * then "let's drop waiting as well".
   *
   * The ISS-4997 and ISS-4998 assertions this block used to hold — an
   * unrecognized status resolving to `unknown`, a long-silent `active` resolving
   * to `stale`, a `waiting` passthrough — are obsoleted BY THAT RULING, not by a
   * regression. They are kept HERE as counterfactuals rather than deleted,
   * because the inputs still exercise something real: the resolver must now
   * answer ACTIVE for every one of them, and a future change that quietly
   * restores a silence cutoff or a version-skew word has to edit these.
   */
  it("ISS-10364: an unrecognized status resolves to ACTIVE, not a version-skew word", () => {
    for (const status of ["some_future_state", "bogus", "completed"]) {
      expect(
        resolveDisplayedSessionStatus({
          status,
          lastActivityAt: FRESH,
          now: NOW,
        })
      ).toBe(SESSION_STATUS.ACTIVE);
    }
  });

  it("ISS-10364: an `active` session silent for 63 hours still resolves to ACTIVE", () => {
    expect(
      resolveDisplayedSessionStatus({
        status: SESSION_STATUS.ACTIVE,
        lastActivityAt: STALE_63H,
        now: NOW,
      })
    ).toBe(SESSION_STATUS.ACTIVE);
  });

  it("ISS-10364: an incoming `waiting` resolves to ACTIVE, the lifecycle state it denotes", () => {
    // The awaiting-input FACT is not retired with the word — it lives on
    // `session_detail.awaitingInputSince`, which this resolver never read.
    expect(
      resolveDisplayedSessionStatus({
        status: "waiting",
        lastActivityAt: STALE_63H,
        now: NOW,
      })
    ).toBe(SESSION_STATUS.ACTIVE);
  });

  it("leaves a genuinely-live session alone", () => {
    expect(
      resolveDisplayedSessionStatus({
        status: SESSION_STATUS.ACTIVE,
        lastActivityAt: FRESH,
        now: NOW,
      })
    ).toBe(SESSION_STATUS.ACTIVE);
  });

  it("returns a TERMINAL status unchanged, whatever its age", () => {
    for (const status of [SESSION_STATUS.INACTIVE, SESSION_STATUS.ERROR]) {
      expect(
        resolveDisplayedSessionStatus({
          status,
          lastActivityAt: STALE_63H,
          now: NOW,
        })
      ).toBe(status);
    }
  });

  it("resolves an inherited Object key as unrecognized rather than a prototype member", () => {
    // `status` is external input, so a bare index read on the fold map would
    // otherwise resolve `constructor`/`__proto__` to a non-status value.
    for (const status of ["constructor", "__proto__", "toString"]) {
      expect(
        resolveDisplayedSessionStatus({
          status,
          lastActivityAt: FRESH,
          now: NOW,
        })
      ).toBe(SESSION_STATUS.ACTIVE);
    }
  });

  it("ISS-10364: reads NO timestamp, so the same status answers the same way with any of them", () => {
    // The counterfactual for the whole staleness apparatus: these three inputs
    // differ only in evidence the resolver used to consult, and they must now be
    // indistinguishable. `isSessionDisplayStale` still exists for the desktop
    // collector, and the describe below still pins it.
    const answers = [
      resolveDisplayedSessionStatus({ status: SESSION_STATUS.ACTIVE }),
      resolveDisplayedSessionStatus({
        status: SESSION_STATUS.ACTIVE,
        lastActivityAt: STALE_63H,
        startedAt: STALE_63H,
        now: NOW,
      }),
      resolveDisplayedSessionStatus({
        status: SESSION_STATUS.ACTIVE,
        lastActivityAt: "not-a-date",
        startedAt: null,
        now: NOW,
      }),
    ];
    expect(new Set(answers)).toEqual(new Set([SESSION_STATUS.ACTIVE]));
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
  it("classifies an absent status as indeterminate", () => {
    expect(resolveSessionDurationLifecycle(undefined)).toBe(
      SessionDurationLifecycle.Indeterminate
    );
  });

  /*
   * ISS-10364 (operator ruling, 2026-09-23/24): "Unparsable status are already
   * converted to Active on import. Don't distinguish between active and
   * stale." This used to classify an unrecognized PRESENT status (a future
   * producer's spelling) as Indeterminate, on the stated invariant that
   * Duration must agree with the badge — and the badge for an unrecognized
   * value is now Active, not a disclaiming "Unknown". Measuring it as Running
   * is what keeps that invariant, not a regression of it.
   */
  it("ISS-10364: classifies an unrecognized PRESENT status as Running, agreeing with its ACTIVE badge", () => {
    expect(resolveSessionDurationLifecycle("future_status")).toBe(
      SessionDurationLifecycle.Running
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

  it("ISS-10364: classifies every retired spelling as Running, agreeing with its ACTIVE badge", () => {
    // Pre-ISS-10364 these were Indeterminate — the same reasoning as the
    // unrecognized-status case above applies identically to a RETIRED one:
    // `normalizeSessionStatus` cannot tell "never modelled" from "modelled and
    // then retired" apart, so both fail open to ACTIVE and Duration must match.
    for (const status of ["running", "failed", "completed", "abandoned"]) {
      expect(resolveSessionDurationLifecycle(status)).toBe(
        SessionDurationLifecycle.Running
      );
    }
  });

  it("folds active and the waiting sub-state to running", () => {
    for (const status of [SESSION_STATUS.ACTIVE, "waiting"]) {
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
 * would render a finished run as still running. Cosimo removed that tolerance on
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

  it("ISS-10364: classifies them Running for Duration, not Ended — they fail open to ACTIVE", () => {
    for (const value of retired) {
      expect(resolveSessionDurationLifecycle(value)).toBe(
        SessionDurationLifecycle.Running
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
    expect(normalizeSessionStatus("waiting")).toBe(SESSION_STATUS.ACTIVE);
    // ISS-5592: `running`/`failed` are no longer recognized spellings; the
    // canonical members and the display-only `waiting` are the whole set.
    expect(normalizeSessionStatus(SESSION_STATUS.ERROR)).toBe(
      SESSION_STATUS.ERROR
    );
  });

  it("fails an UNRECOGNIZED value open to ACTIVE rather than storing it", () => {
    // Cosimo's call on ISS-5592: an unmodelled spelling is not a terminal claim,
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
