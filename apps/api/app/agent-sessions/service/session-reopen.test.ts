import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { describe, expect, it, vi } from "vitest";
import {
  maybeReopenTerminalSession,
  type ReopenInput,
  shouldReopenSession,
} from "./session-reopen";
import { projectDisplayedSessionStatus } from "./session-status-projection";

const T1 = new Date("2026-07-20T10:00:00.000Z");
const T2 = new Date("2026-07-20T11:00:00.000Z");
/**
 * Ten days past {@link T2} — comfortably beyond
 * `STALE_SESSION_DISPLAY_THRESHOLD_HOURS`, so a reopened row that kept no
 * awaiting-input anchor is judged Stale rather than merely Active. Pinned as an
 * instant (not a clock read) so the staleness verdict is deterministic.
 */
const T_PAST_STALE_CUTOFF = new Date("2026-07-30T00:00:00.000Z");

describe("shouldReopenSession", () => {
  function input(overrides: Partial<ReopenInput> = {}): ReopenInput {
    return {
      persistedStatus: SESSION_STATUS.INACTIVE,
      incomingStatus: SESSION_STATUS.ACTIVE,
      maxEventCreatedAt: T2,
      persistedSessionEndedAt: T1,
      ...overrides,
    };
  }

  it("fires when a strictly newer event exists beyond the persisted endedAt", () => {
    expect(shouldReopenSession(input())).toBe(true);
  });

  it("fires for an incoming waiting status", () => {
    expect(
      shouldReopenSession(
        input({ incomingStatus: DISPLAYED_SESSION_STATUS.WAITING })
      )
    ).toBe(true);
  });

  it("fires when the persisted status is inactive (ISS-4586 canonical terminal-not-failed)", () => {
    expect(
      shouldReopenSession(input({ persistedStatus: SESSION_STATUS.INACTIVE }))
    ).toBe(true);
  });

  it("denies when maxEventCreatedAt is null (no events)", () => {
    expect(shouldReopenSession(input({ maxEventCreatedAt: null }))).toBe(false);
  });

  it("denies when persistedSessionEndedAt is null (never ended)", () => {
    expect(shouldReopenSession(input({ persistedSessionEndedAt: null }))).toBe(
      false
    );
  });

  it("denies when timestamps are equal", () => {
    expect(
      shouldReopenSession(
        input({ maxEventCreatedAt: T1, persistedSessionEndedAt: T1 })
      )
    ).toBe(false);
  });

  it("denies when maxEventCreatedAt is older than persistedSessionEndedAt", () => {
    expect(
      shouldReopenSession(
        input({ maxEventCreatedAt: T1, persistedSessionEndedAt: T2 })
      )
    ).toBe(false);
  });

  // An unrecognized STORED spelling has no case here any more, and that is the
  // point of normalizing at the read boundary: the caller folds the column, so
  // an unmodelled value arrives as `active` — non-terminal, refused by the gate
  // below — and feeding the raw word to this field is now a compile error.
  //
  // The fold is covered in `service.upsert-awaiting.test.ts`, by the case named
  // "does NOT reopen when the STORED status is one this build cannot read".
  // An earlier draft of this note asserted that coverage before it existed
  // (code review #5156 caught it): every `buildExistingRow` in that suite passed
  // a canonical member, so deleting the case here left the axis untested under a
  // comment claiming otherwise. Do not delete a case on the strength of a
  // sentence like this one without opening the suite it names.

  it("denies when there is no stored row at all (the create arm)", () => {
    expect(shouldReopenSession(input({ persistedStatus: null }))).toBe(false);
  });

  it("denies an active row — there is nothing to reopen", () => {
    expect(
      shouldReopenSession(input({ persistedStatus: SESSION_STATUS.ACTIVE }))
    ).toBe(false);
  });

  it("REOPENS a failed run when genuinely newer activity arrives", () => {
    // Chris, 2026-08-16 — a deliberate behaviour change, and the expectation
    // this file previously asserted the opposite of ("denies when persisted
    // status is error"). A run that ended in error and then produced work
    // beyond its recorded end has resumed, and pinning it terminal made the
    // Sessions list disagree with the events under it.
    //
    // It also un-diverges the surfaces. The old refusal cited desktop parity —
    // "mirrors `maybeReactivate`, which never revives a failed run" — which was
    // untrue of that function: its `isUserActivity` arm short-circuits and
    // revives an `error` session on any UserPromptSubmit/PreToolUse. Only its
    // Stop-like arm refuses one. Cloud was stricter than the code it named.
    expect(
      shouldReopenSession(input({ persistedStatus: SESSION_STATUS.ERROR }))
    ).toBe(true);
  });

  it("still refuses a failed run without newer activity", () => {
    // The evidence bar is what does the work, not the status. No event beyond
    // the recorded end means nothing resumed, so a resync of already-known work
    // cannot revive a failed run.
    expect(
      shouldReopenSession(
        input({
          persistedStatus: SESSION_STATUS.ERROR,
          maxEventCreatedAt: T1,
          persistedSessionEndedAt: T1,
        })
      )
    ).toBe(false);
    expect(
      shouldReopenSession(
        input({
          persistedStatus: SESSION_STATUS.ERROR,
          maxEventCreatedAt: null,
        })
      )
    ).toBe(false);
  });

  it("refuses a failed run when the incoming status is itself terminal", () => {
    // The incoming claim still has to be a live one. `inactive` arriving for an
    // errored row is a terminal-to-terminal correction, not a resumption.
    expect(
      shouldReopenSession(
        input({
          persistedStatus: SESSION_STATUS.ERROR,
          incomingStatus: SESSION_STATUS.INACTIVE,
        })
      )
    ).toBe(false);
  });

  it("denies when incoming status is an unknown non-terminal value", () => {
    expect(shouldReopenSession(input({ incomingStatus: "failed" }))).toBe(
      false
    );
  });

  it("denies when incoming status is terminal (completed)", () => {
    expect(shouldReopenSession(input({ incomingStatus: "completed" }))).toBe(
      false
    );
  });

  it("denies when incoming status is terminal (error)", () => {
    expect(
      shouldReopenSession(input({ incomingStatus: SESSION_STATUS.ERROR }))
    ).toBe(false);
  });

  it("denies when incoming status is terminal (abandoned)", () => {
    expect(
      shouldReopenSession(input({ incomingStatus: SESSION_STATUS.INACTIVE }))
    ).toBe(false);
  });
});

describe("maybeReopenTerminalSession", () => {
  function buildTx() {
    return {
      artifact: { update: vi.fn().mockResolvedValue({}) },
      sessionDetail: { update: vi.fn().mockResolvedValue({}) },
    };
  }

  it("updates artifact status and forces sessionEndedAt null on reopen", async () => {
    const tx = buildTx();
    const awaitingSince = new Date("2026-07-20T10:30:00.000Z");

    await maybeReopenTerminalSession(
      tx as never,
      {
        persistedStatus: SESSION_STATUS.INACTIVE,
        incomingStatus: SESSION_STATUS.ACTIVE,
        maxEventCreatedAt: T2,
        persistedSessionEndedAt: T1,
      },
      {
        artifactId: "art-1",
        incomingStatus: SESSION_STATUS.ACTIVE,
        incomingAwaitingInputSince: awaitingSince,
      }
    );

    expect(tx.artifact.update).toHaveBeenCalledWith({
      where: { id: "art-1" },
      data: { status: SESSION_STATUS.ACTIVE },
    });
    expect(tx.sessionDetail.update).toHaveBeenCalledWith({
      where: { artifactId: "art-1" },
      data: {
        sessionEndedAt: null,
        // ISS-5592: cleared on every reopen, so the stale-session reaper cannot
        // re-declare a revived run ERROR from the flag of the run that ended.
        //
        // NULL, not `false` (code review #5156). `false` asserts the run ended
        // clean; `null` reports no verdict recorded, which is the true state of
        // a run that has just resumed. The reaper reads both as not-error, so
        // the hazard stays closed while insights stops counting a failed run as
        // healthy work.
        endsWithError: null,
        awaitingInputSince: awaitingSince,
      },
    });
  });

  // ISS-5974: `waiting` is a CALCULATED display term and is never persisted. The
  // reopen path still ACCEPTS it (a version-skewed desktop build sends it), so
  // this drives the real write seam and asserts the FOLD: the artifact row lands
  // on `active`, while `awaitingInputSince` — the actual awaiting-input signal
  // the Waiting badge is re-derived from at read time — is preserved untouched.
  // Delete the fold in `maybeReopenTerminalSession` and this fails.
  it("persists an incoming waiting status as active while preserving awaitingInputSince", async () => {
    const tx = buildTx();
    const awaitingSince = new Date("2026-07-20T10:45:00.000Z");

    await maybeReopenTerminalSession(
      tx as never,
      {
        persistedStatus: SESSION_STATUS.INACTIVE,
        incomingStatus: DISPLAYED_SESSION_STATUS.WAITING,
        maxEventCreatedAt: T2,
        persistedSessionEndedAt: T1,
      },
      {
        artifactId: "art-waiting",
        incomingStatus: DISPLAYED_SESSION_STATUS.WAITING,
        incomingAwaitingInputSince: awaitingSince,
      }
    );

    expect(tx.artifact.update).toHaveBeenCalledWith({
      where: { id: "art-waiting" },
      data: { status: SESSION_STATUS.ACTIVE },
    });
    // The awaiting-input signal survives the fold — nothing is lost.
    expect(tx.sessionDetail.update).toHaveBeenCalledWith({
      where: { artifactId: "art-waiting" },
      data: {
        sessionEndedAt: null,
        endsWithError: null,
        awaitingInputSince: awaitingSince,
      },
    });
  });

  // A non-waiting reopen carries no awaiting-input claim, so a null incoming
  // value is the honest write: the run is live, not blocked on a human. Only the
  // `waiting` spelling asserts otherwise, and only that spelling gets an anchor
  // synthesized (see the case below).
  it("restores null awaitingInputSince when a non-waiting incoming value is null", async () => {
    const tx = buildTx();

    await maybeReopenTerminalSession(
      tx as never,
      {
        persistedStatus: SESSION_STATUS.INACTIVE,
        incomingStatus: SESSION_STATUS.ACTIVE,
        maxEventCreatedAt: T2,
        persistedSessionEndedAt: T1,
      },
      {
        artifactId: "art-2",
        incomingStatus: SESSION_STATUS.ACTIVE,
        incomingAwaitingInputSince: null,
      }
    );

    expect(tx.sessionDetail.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ awaitingInputSince: null }),
      })
    );
  });

  // ISS-5974 (wongk, #4810): the wire schema declares `awaitingInputSince` as
  // `.nullable().optional()` (`desktop-agent-sessions-schema.ts`), so a
  // version-skewed desktop build can send `waiting` with NO timestamp at all —
  // and `toDate(undefined)` lands it here as null, indistinguishable from an
  // explicit one.
  //
  // Before the ISS-5974 fold, the STORED `waiting` string was itself the
  // awaiting-input signal: `resolveDisplayedSessionStatus` returns WAITING from
  // the raw value before consulting any timestamp, so such a row rendered
  // Waiting with a null anchor. Folding the status to `active` without
  // supplying an anchor would therefore destroy the only signal the payload
  // carried, and the reopened run would read Active — then Stale once it aged
  // past the cutoff. The fold synthesizes the anchor from `maxEventCreatedAt`,
  // the event the reopen predicate has already proven exists and is strictly
  // newer than the persisted end.
  it("synthesizes an awaiting-input anchor when an incoming waiting status omits awaitingInputSince", async () => {
    const tx = buildTx();

    await maybeReopenTerminalSession(
      tx as never,
      {
        persistedStatus: SESSION_STATUS.INACTIVE,
        incomingStatus: DISPLAYED_SESSION_STATUS.WAITING,
        maxEventCreatedAt: T2,
        persistedSessionEndedAt: T1,
      },
      {
        artifactId: "art-waiting-no-anchor",
        incomingStatus: DISPLAYED_SESSION_STATUS.WAITING,
        incomingAwaitingInputSince: null,
      }
    );

    // The contract still holds: `waiting` is never the persisted status.
    expect(tx.artifact.update).toHaveBeenCalledWith({
      where: { id: "art-waiting-no-anchor" },
      data: { status: SESSION_STATUS.ACTIVE },
    });
    // ...and the awaiting-input signal survives it, anchored to the reopening
    // event rather than dropped.
    expect(tx.sessionDetail.update).toHaveBeenCalledWith({
      where: { artifactId: "art-waiting-no-anchor" },
      data: {
        sessionEndedAt: null,
        endsWithError: null,
        awaitingInputSince: T2,
      },
    });

    // End-to-end: the row that write produces still reads Waiting long past the
    // staleness cutoff, because the Waiting branch precedes the staleness fold.
    expect(
      projectDisplayedSessionStatus(
        {
          status: SESSION_STATUS.ACTIVE,
          awaitingInputSince: T2,
          sessionEndedAt: null,
          lastActivityAt: T2,
        },
        T_PAST_STALE_CUTOFF
      )
    ).toBe(DISPLAYED_SESSION_STATUS.WAITING);
    // The regression being guarded, stated as behavior: the pre-fix write
    // (`active` + a null anchor) is reported by this same projection as Stale.
    expect(
      projectDisplayedSessionStatus(
        {
          status: SESSION_STATUS.ACTIVE,
          awaitingInputSince: null,
          sessionEndedAt: null,
          lastActivityAt: T2,
        },
        T_PAST_STALE_CUTOFF
      )
    ).toBe(DISPLAYED_SESSION_STATUS.STALE);
  });

  it("does not write when the predicate denies", async () => {
    const tx = buildTx();

    await maybeReopenTerminalSession(
      tx as never,
      {
        // ISS-5592: this used a persisted `error` to force a denial, which no
        // longer denies — a failed run is reopenable on newer activity. The
        // case is about the WRITE being skipped, not about which status
        // refuses, so it now withholds the evidence instead: no event beyond
        // the recorded end means nothing resumed.
        persistedStatus: SESSION_STATUS.ERROR,
        incomingStatus: SESSION_STATUS.ACTIVE,
        maxEventCreatedAt: null,
        persistedSessionEndedAt: T1,
      },
      {
        artifactId: "art-3",
        incomingStatus: SESSION_STATUS.ACTIVE,
        incomingAwaitingInputSince: null,
      }
    );

    expect(tx.artifact.update).not.toHaveBeenCalled();
    expect(tx.sessionDetail.update).not.toHaveBeenCalled();
  });
});
