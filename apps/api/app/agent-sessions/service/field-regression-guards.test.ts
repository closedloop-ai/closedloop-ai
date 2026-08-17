import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { describe, expect, it } from "vitest";
import {
  MAX_SESSION_UPDATED_AT_FUTURE_SKEW_MS,
  resolveGuardedStatus,
  resolveGuardedTimestampPatch,
  resolveSessionFreshnessGates,
  resolveTokenRollupColumns,
} from "./field-regression-guards";

const OLDER = new Date("2026-06-10T10:00:00.000Z");
const NEWER = new Date("2026-06-10T12:00:00.000Z");

const identityRound = (value: number): number => value;

const ZERO_TOTALS = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimatedCost: 0,
};

describe("resolveGuardedTimestampPatch (FEA-3477 D4)", () => {
  it("keeps the newer persisted timestamps when an older batch resyncs", () => {
    const patch = resolveGuardedTimestampPatch(
      {
        sessionStartedAt: NEWER,
        sessionUpdatedAt: NEWER,
        sessionEndedAt: NEWER,
      },
      {
        sessionStartedAt: OLDER,
        sessionUpdatedAt: OLDER,
        sessionEndedAt: OLDER,
      }
    );
    expect(patch.sessionStartedAt).toEqual(NEWER);
    expect(patch.sessionUpdatedAt).toEqual(NEWER);
    expect(patch.sessionEndedAt).toEqual(NEWER);
  });

  it("advances to the incoming timestamps when they are newer", () => {
    const patch = resolveGuardedTimestampPatch(
      {
        sessionStartedAt: OLDER,
        sessionUpdatedAt: OLDER,
        sessionEndedAt: OLDER,
      },
      {
        sessionStartedAt: NEWER,
        sessionUpdatedAt: NEWER,
        sessionEndedAt: NEWER,
      }
    );
    expect(patch.sessionStartedAt).toEqual(NEWER);
    expect(patch.sessionUpdatedAt).toEqual(NEWER);
    expect(patch.sessionEndedAt).toEqual(NEWER);
  });

  it("preserves a persisted sessionEndedAt when an older batch omits it (null)", () => {
    const patch = resolveGuardedTimestampPatch(
      {
        sessionStartedAt: NEWER,
        sessionUpdatedAt: NEWER,
        sessionEndedAt: NEWER,
      },
      {
        sessionStartedAt: OLDER,
        sessionUpdatedAt: OLDER,
        sessionEndedAt: null,
      }
    );
    // A stale batch with a null end must never null-out a recorded end.
    expect(patch.sessionEndedAt).toEqual(NEWER);
  });

  it("adopts the incoming sessionEndedAt when there was no persisted end", () => {
    const patch = resolveGuardedTimestampPatch(
      {
        sessionStartedAt: OLDER,
        sessionUpdatedAt: OLDER,
        sessionEndedAt: null,
      },
      {
        sessionStartedAt: NEWER,
        sessionUpdatedAt: NEWER,
        sessionEndedAt: NEWER,
      }
    );
    expect(patch.sessionEndedAt).toEqual(NEWER);
  });

  it("returns null end only when both persisted and incoming ends are null", () => {
    const patch = resolveGuardedTimestampPatch(
      {
        sessionStartedAt: OLDER,
        sessionUpdatedAt: OLDER,
        sessionEndedAt: null,
      },
      {
        sessionStartedAt: OLDER,
        sessionUpdatedAt: OLDER,
        sessionEndedAt: null,
      }
    );
    expect(patch.sessionEndedAt).toBeNull();
  });
});

describe("resolveGuardedStatus (FEA-3477 D4)", () => {
  it("never regresses a terminal status to a non-terminal one", () => {
    expect(
      resolveGuardedStatus(SESSION_STATUS.INACTIVE, SESSION_STATUS.ACTIVE)
    ).toBe(SESSION_STATUS.INACTIVE);
    expect(
      resolveGuardedStatus(
        SESSION_STATUS.ERROR,
        DISPLAYED_SESSION_STATUS.WAITING
      )
    ).toBe(SESSION_STATUS.ERROR);
    // NO INPUT CAN DISCRIMINATE THE FOLD ANY MORE, and that is worth stating
    // rather than papering over. This case used `failed`, the one spelling that
    // folded INTO a terminal value without being one — so a raw `has()` would
    // have let a non-terminal incoming status overwrite a failed run, and
    // deleting either `normalizeSessionStatus` call reddened here.
    //
    // ISS-5592 (2026-08-15) removed the alias map, so the fold is now the
    // identity on terminality: `normalize(x)` is terminal exactly when `x` is.
    // Both calls in `resolveGuardedStatus` are kept as defence against a future
    // alias, but nothing here can prove they are still wired. Do not add a case
    // that looks like it does.
  });

  it("allows terminal-to-terminal corrections", () => {
    expect(
      resolveGuardedStatus(SESSION_STATUS.ERROR, SESSION_STATUS.INACTIVE)
    ).toBe(SESSION_STATUS.INACTIVE);
  });

  it("advances a non-terminal status to any incoming status", () => {
    expect(
      resolveGuardedStatus(SESSION_STATUS.ACTIVE, SESSION_STATUS.INACTIVE)
    ).toBe(SESSION_STATUS.INACTIVE);
    expect(
      resolveGuardedStatus(
        SESSION_STATUS.ACTIVE,
        DISPLAYED_SESSION_STATUS.WAITING
      )
    ).toBe(DISPLAYED_SESSION_STATUS.WAITING);
  });

  it("writes the incoming status when there is no persisted status", () => {
    expect(resolveGuardedStatus(null, SESSION_STATUS.ACTIVE)).toBe(
      SESSION_STATUS.ACTIVE
    );
    expect(resolveGuardedStatus(undefined, SESSION_STATUS.INACTIVE)).toBe(
      SESSION_STATUS.INACTIVE
    );
  });
});

describe("resolveTokenRollupColumns (FEA-3477 D5)", () => {
  it("omits the rollup columns when there is no token usage", () => {
    const columns = resolveTokenRollupColumns(
      false,
      ZERO_TOTALS,
      identityRound
    );
    expect(columns).toEqual({});
  });

  it("writes the rollup columns when token usage is present", () => {
    const columns = resolveTokenRollupColumns(
      true,
      {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 40,
        estimatedCost: 1.234_567_89,
      },
      (value) => Number(value.toFixed(6))
    );
    expect(columns).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
      estimatedCost: 1.234_568,
    });
  });
});

describe("resolveGuardedTimestampPatch — poisoned-watermark repair (ISS-4946)", () => {
  const POISONED = new Date("2031-06-10T12:00:00.000Z");
  const INCOMING = {
    sessionStartedAt: OLDER,
    sessionUpdatedAt: NEWER,
    sessionEndedAt: null,
  };

  // Max-wins alone can never heal a far-future watermark: the stored value wins
  // forever and the freshness gate stays shut on that row.
  it("keeps max-wins on sessionUpdatedAt when the repair option is absent", () => {
    const patch = resolveGuardedTimestampPatch(
      {
        sessionStartedAt: OLDER,
        sessionUpdatedAt: POISONED,
        sessionEndedAt: null,
      },
      INCOMING
    );
    expect(patch.sessionUpdatedAt).toBe(POISONED);
  });

  it("replaces a poisoned sessionUpdatedAt outright when repairing", () => {
    const patch = resolveGuardedTimestampPatch(
      {
        sessionStartedAt: OLDER,
        sessionUpdatedAt: POISONED,
        sessionEndedAt: null,
      },
      INCOMING,
      { repairImplausibleUpdatedAt: true }
    );
    expect(patch.sessionUpdatedAt).toBe(NEWER);
  });

  // The repair is scoped to the watermark. Rewinding the start or clearing a
  // recorded end would be destructive, so those stay max-wins even here.
  it("leaves sessionStartedAt and sessionEndedAt max-wins while repairing", () => {
    const storedEnd = new Date("2031-06-10T13:00:00.000Z");
    const patch = resolveGuardedTimestampPatch(
      {
        sessionStartedAt: POISONED,
        sessionUpdatedAt: POISONED,
        sessionEndedAt: storedEnd,
      },
      INCOMING,
      { repairImplausibleUpdatedAt: true }
    );
    expect(patch.sessionStartedAt).toBe(POISONED);
    expect(patch.sessionEndedAt).toBe(storedEnd);
  });
});

const RECEIVED_AT = new Date("2026-06-10T12:00:00.000Z");
const POISONED_WATERMARK = new Date("2031-06-10T12:00:00.000Z");

function gates(
  overrides: Partial<Parameters<typeof resolveSessionFreshnessGates>[0]> = {}
) {
  return resolveSessionFreshnessGates({
    existingSessionUpdatedAt: OLDER,
    incomingSessionUpdatedAt: NEWER,
    receivedAt: RECEIVED_AT,
    hasPullRequestBlobEvidence: false,
    hasPullRequestLinkEvidence: false,
    // The default snapshot carries both shapes (an empty `prs` and an empty
    // `prRefs`), so both lanes do have a write to suppress; the no-write case is
    // covered explicitly below.
    hasPullRequestBlobWrite: true,
    hasPullRequestLinkWrite: true,
    ...overrides,
  });
}

describe("resolveSessionFreshnessGates — shared watermark (ISS-4946)", () => {
  it("admits a create", () => {
    const result = gates({ existingSessionUpdatedAt: null });
    expect(result.shouldUpdateGuardedColumns).toBe(true);
    expect(result.shouldUpdatePullRequestsBlob).toBe(true);
    expect(result.didRepairPoisonedWatermark).toBe(false);
  });

  it("admits a strictly fresher batch", () => {
    expect(gates().shouldUpdateGuardedColumns).toBe(true);
  });

  it("admits an equal watermark (the FEA-3419 `>=` contract)", () => {
    expect(
      gates({ incomingSessionUpdatedAt: new Date(OLDER) })
        .shouldUpdateGuardedColumns
    ).toBe(true);
  });

  it("rejects a stale redelivery", () => {
    expect(
      gates({
        existingSessionUpdatedAt: NEWER,
        incomingSessionUpdatedAt: OLDER,
      }).shouldUpdateGuardedColumns
    ).toBe(false);
  });
});

describe("resolveSessionFreshnessGates — PR tie-breaker (ISS-4946)", () => {
  it("admits a strictly fresher batch with no PR evidence (a genuine retraction still clears)", () => {
    expect(gates().shouldUpdatePullRequestsBlob).toBe(true);
  });

  it("rejects a stale redelivery even when it carries PR evidence", () => {
    expect(
      gates({
        existingSessionUpdatedAt: NEWER,
        incomingSessionUpdatedAt: OLDER,
        hasPullRequestBlobEvidence: true,
        hasPullRequestLinkEvidence: true,
      }).shouldUpdatePullRequestsBlob
    ).toBe(false);
  });

  // The tie wongk raised: pre-3bc26f527 Desktop builds commit the session row and
  // the PR/link phases separately under one `updatedAt`, so the empty pre-link
  // snapshot and the populated post-link snapshot compare equal and delivery
  // order decides which wins. The populated one has to.
  it("rejects an equal-watermark snapshot carrying no PR evidence", () => {
    const result = gates({ incomingSessionUpdatedAt: new Date(OLDER) });
    expect(result.shouldUpdateGuardedColumns).toBe(true);
    expect(result.shouldUpdatePullRequestsBlob).toBe(false);
    // This is the branch that can silently drop a genuine retraction, so it must
    // report itself; the caller routes it to a monitor.
    expect(result.didPreservePullRequestsOnTie).toBe(true);
  });

  it("admits an equal-watermark snapshot carrying PR evidence", () => {
    const result = gates({
      incomingSessionUpdatedAt: new Date(OLDER),
      hasPullRequestBlobEvidence: true,
      hasPullRequestLinkEvidence: true,
    });
    expect(result.shouldUpdatePullRequestsBlob).toBe(true);
    expect(result.didPreservePullRequestsOnTie).toBe(false);
  });

  // The signal has to be precise or it is noise: an ordinary stale redelivery is
  // the regression this issue FIXES, not an accepted loss, and it is by far the
  // commoner event. Reporting it would bury the tie case it exists to surface.
  it("does not report a tie-preserve for an ordinary stale redelivery", () => {
    expect(
      gates({
        existingSessionUpdatedAt: NEWER,
        incomingSessionUpdatedAt: OLDER,
      }).didPreservePullRequestsOnTie
    ).toBe(false);
  });

  it("does not report a tie-preserve for a strictly fresher batch", () => {
    expect(gates().didPreservePullRequestsOnTie).toBe(false);
  });

  // The two desktop producers have independent caps and different admission
  // predicates, so one shape can be populated while the other is empty. Deriving
  // one shared boolean from their union let whichever shape had data authorize
  // the OTHER lane's destructive replacement — which is how a populated blob
  // ended up next to zero links, the split state this gate exists to prevent.
  it("resolves each lane from its own evidence at an equal watermark", () => {
    const blobOnly = gates({
      incomingSessionUpdatedAt: new Date(OLDER),
      hasPullRequestBlobEvidence: true,
      hasPullRequestLinkEvidence: false,
    });
    expect(blobOnly.shouldUpdatePullRequestsBlob).toBe(true);
    expect(blobOnly.shouldUpdatePullRequestLinks).toBe(false);

    const linksOnly = gates({
      incomingSessionUpdatedAt: new Date(OLDER),
      hasPullRequestBlobEvidence: false,
      hasPullRequestLinkEvidence: true,
    });
    expect(linksOnly.shouldUpdatePullRequestsBlob).toBe(false);
    expect(linksOnly.shouldUpdatePullRequestLinks).toBe(true);

    // Either lane preserving is worth reporting — the dropped retraction the
    // signal exists for can be on either side.
    expect(blobOnly.didPreservePullRequestsOnTie).toBe(true);
    expect(linksOnly.didPreservePullRequestsOnTie).toBe(true);
  });

  // The counter's population has to be ties that COST something, or the measure
  // it exists to provide is dominated by no-ops. A pre-link-extraction snapshot
  // sends neither shape, so at a tie the blob patch omits the column and the link
  // lane early-returns — nothing was preserved, and nothing is reported.
  it("does not report a tie-preserve when neither lane had a write to lose", () => {
    const result = gates({
      incomingSessionUpdatedAt: new Date(OLDER),
      hasPullRequestBlobWrite: false,
      hasPullRequestLinkWrite: false,
    });
    expect(result.shouldUpdatePullRequestsBlob).toBe(false);
    expect(result.shouldUpdatePullRequestLinks).toBe(false);
    expect(result.didPreservePullRequestsOnTie).toBe(false);
  });

  it("still reports a tie-preserve when only one lane had a write to lose", () => {
    expect(
      gates({
        incomingSessionUpdatedAt: new Date(OLDER),
        hasPullRequestBlobWrite: false,
      }).didPreservePullRequestsOnTie
    ).toBe(true);
  });

  // A pending write is only a tie-counter input; it must never widen who may
  // write, or it would hand the blob lane back the destructive clear at a tie.
  it("does not let a pending write authorize the skipped lane", () => {
    const result = gates({
      incomingSessionUpdatedAt: new Date(OLDER),
      hasPullRequestBlobWrite: true,
      hasPullRequestLinkWrite: true,
    });
    expect(result.shouldUpdatePullRequestsBlob).toBe(false);
    expect(result.shouldUpdatePullRequestLinks).toBe(false);
  });

  // Away from the tie the lanes must NOT diverge: evidence is only a tie-break,
  // so a strictly fresher batch still clears both (a genuine retraction lands)
  // and a stale one still skips both.
  it("keeps both lanes together away from the tie regardless of evidence", () => {
    const fresher = gates({ hasPullRequestBlobEvidence: true });
    expect(fresher.shouldUpdatePullRequestsBlob).toBe(true);
    expect(fresher.shouldUpdatePullRequestLinks).toBe(true);

    const stale = gates({
      existingSessionUpdatedAt: NEWER,
      incomingSessionUpdatedAt: OLDER,
      hasPullRequestBlobEvidence: true,
    });
    expect(stale.shouldUpdatePullRequestsBlob).toBe(false);
    expect(stale.shouldUpdatePullRequestLinks).toBe(false);
  });
});

describe("resolveSessionFreshnessGates — poisoned-clock repair (ISS-4946)", () => {
  // Ordinary drift must NOT trip the repair: a merely-fast clock still orders its
  // own snapshots correctly, and treating its rows as garbage would throw that
  // ordering away and degrade the guards to last-arrival-wins.
  it("leaves a modestly fast stored watermark alone", () => {
    const slightlyAhead = new Date(RECEIVED_AT.getTime() + 60_000);
    const result = gates({
      existingSessionUpdatedAt: slightlyAhead,
      incomingSessionUpdatedAt: OLDER,
    });
    expect(result.didRepairPoisonedWatermark).toBe(false);
    expect(result.shouldUpdateGuardedColumns).toBe(false);
  });

  it("leaves a stored watermark exactly at the skew bound alone", () => {
    const atBound = new Date(
      RECEIVED_AT.getTime() + MAX_SESSION_UPDATED_AT_FUTURE_SKEW_MS
    );
    expect(
      gates({
        existingSessionUpdatedAt: atBound,
        incomingSessionUpdatedAt: OLDER,
      }).didRepairPoisonedWatermark
    ).toBe(false);
  });

  // The bug: max-wins pins a far-future watermark, so every legitimate sync after
  // it compares older and the guarded columns can never be corrected again.
  it("admits and repairs a plausible batch against a poisoned watermark", () => {
    const result = gates({
      existingSessionUpdatedAt: POISONED_WATERMARK,
      incomingSessionUpdatedAt: OLDER,
    });
    expect(result.didRepairPoisonedWatermark).toBe(true);
    expect(result.shouldUpdateGuardedColumns).toBe(true);
    // PR state must unstick too — a poisoned watermark adjudicates nothing, so
    // the PR gate is handed the same "no prior row" state a create sees.
    expect(result.shouldUpdatePullRequestsBlob).toBe(true);
  });

  // Both sides implausible = the clock is still wrong. Raw comparison then keeps
  // that device's OWN snapshot ordering intact instead of collapsing it.
  it("does not repair while the incoming batch is also implausible", () => {
    const laterBadClock = new Date("2031-06-11T12:00:00.000Z");
    const result = gates({
      existingSessionUpdatedAt: laterBadClock,
      incomingSessionUpdatedAt: POISONED_WATERMARK,
    });
    expect(result.didRepairPoisonedWatermark).toBe(false);
    expect(result.shouldUpdateGuardedColumns).toBe(false);
  });
});
