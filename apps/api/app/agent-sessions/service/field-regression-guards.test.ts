import {
  LEGACY_WAITING_WIRE_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { WEB_SEARCH_COST_PER_REQUEST_USD } from "@repo/cost/harness-cost-parity";
import { describe, expect, it } from "vitest";
import {
  didDropContradictorySessionEnd,
  MAX_SESSION_UPDATED_AT_FUTURE_SKEW_MS,
  resolveGuardedStatus,
  resolveGuardedTimestampPatch,
  resolveNameOverridePatch,
  resolveSessionEndForStatus,
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
      resolveGuardedStatus(SESSION_STATUS.ERROR, LEGACY_WAITING_WIRE_STATUS)
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
      resolveGuardedStatus(SESSION_STATUS.ACTIVE, LEGACY_WAITING_WIRE_STATUS)
    ).toBe(LEGACY_WAITING_WIRE_STATUS);
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
    const columns = resolveTokenRollupColumns({
      hasTokenUsage: false,
      totals: ZERO_TOTALS,
      roundCost: identityRound,
      anyRowPriced: false,
    });
    expect(columns).toEqual({});
  });

  it("writes the rollup columns when token usage is present", () => {
    const columns = resolveTokenRollupColumns({
      hasTokenUsage: true,
      totals: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 40,
        estimatedCost: 1.234_567_89,
      },
      roundCost: (value) => Number(value.toFixed(6)),
      // ISS-8515: a priced payload — the arm that sums tokens + web search.
      anyRowPriced: true,
    });
    expect(columns).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
      estimatedCost: 1.234_568,
    });
  });
});

describe("resolveTokenRollupColumns — the web-search-only session (ISS-7821)", () => {
  const WEB_SEARCH_METADATA = { usageExtras: { web_search_requests: 3 } };
  const THREE_REQUESTS_USD = 3 * WEB_SEARCH_COST_PER_REQUEST_USD;
  const NO_STORED_TOKENS = {
    inputTokens: 0n,
    outputTokens: 0n,
    cacheReadTokens: 0n,
    cacheWriteTokens: 0n,
  };

  it("prices a session whose only cost is web search, with no token rows", () => {
    // The create arm: no token usage in the payload and none stored, but a
    // billable count in metadata. This used to return `{}` and let the column's
    // `@default(0)` report $0 for a session the desktop prices at the line item.
    const columns = resolveTokenRollupColumns({
      hasTokenUsage: false,
      totals: ZERO_TOTALS,
      roundCost: identityRound,
      metadata: WEB_SEARCH_METADATA,
      existingTokenRollup: null,
      anyRowPriced: false,
    });
    expect(columns).toEqual({ estimatedCost: THREE_REQUESTS_USD });
  });

  it("writes ONLY the cost column, never zeroed token columns", () => {
    // The reason the early return exists: `persistSessionChildren` skips the
    // token delete+recreate on an empty payload, so emitting `inputTokens: 0`
    // here would desync the rollup from a per-model table that still has rows.
    const columns = resolveTokenRollupColumns({
      hasTokenUsage: false,
      totals: ZERO_TOTALS,
      roundCost: identityRound,
      metadata: WEB_SEARCH_METADATA,
      existingTokenRollup: null,
      anyRowPriced: false,
    });
    expect(columns).not.toHaveProperty("inputTokens");
    expect(columns).not.toHaveProperty("outputTokens");
    expect(columns).not.toHaveProperty("cacheReadTokens");
    expect(columns).not.toHaveProperty("cacheWriteTokens");
  });

  it("keeps updating a stored web-search-only session as its count grows", () => {
    // A Desktop build predating the ISS-7813 cost writer sends metadata with no
    // token rollup on EVERY sync, so all but the first are updates. A fix that
    // only covered the create arm would freeze this session at its first count.
    const columns = resolveTokenRollupColumns({
      hasTokenUsage: false,
      totals: ZERO_TOTALS,
      roundCost: identityRound,
      metadata: { usageExtras: { web_search_requests: 9 } },
      existingTokenRollup: NO_STORED_TOKENS,
      anyRowPriced: false,
    });
    expect(columns).toEqual({
      estimatedCost: 9 * WEB_SEARCH_COST_PER_REQUEST_USD,
    });
  });

  it("never overwrites a stored cost that already carries token spend", () => {
    // The clobber this patch is gated to prevent. `estimatedCost` is one column
    // holding `tokens + web search`, and on a payload with no token rows this
    // fold cannot recompute the token half — writing the line item alone would
    // delete a real token cost, trading a small under-report for a large one.
    const columns = resolveTokenRollupColumns({
      hasTokenUsage: false,
      totals: ZERO_TOTALS,
      roundCost: identityRound,
      metadata: WEB_SEARCH_METADATA,
      existingTokenRollup: { ...NO_STORED_TOKENS, inputTokens: 1000n },
      anyRowPriced: false,
    });
    expect(columns).toEqual({});
  });

  // ISS-8515 (Phase 6.5 mutation lock, written BEFORE the behaviour change):
  // `hasStoredTokenCost` ORs four columns, and only `inputTokens` was pinned —
  // Stryker leaves the `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`
  // arms alive (survivors at the two `hasStoredTokenCost` OR arms, on a 95.31%
  // baseline). ISS-8515 makes this helper more load-bearing, so each arm gets a
  // case whose ONLY non-zero column is that one. Each asserts the web-search
  // patch STAYS SUPPRESSED, which is the behaviour the arm exists to produce.
  it.each([
    ["outputTokens", { ...NO_STORED_TOKENS, outputTokens: 1000n }],
    ["cacheReadTokens", { ...NO_STORED_TOKENS, cacheReadTokens: 1000n }],
    ["cacheWriteTokens", { ...NO_STORED_TOKENS, cacheWriteTokens: 1000n }],
  ])(
    "suppresses the web-search patch when only %s is stored",
    (_column, storedRollup) => {
      expect(
        resolveTokenRollupColumns({
          hasTokenUsage: false,
          totals: ZERO_TOTALS,
          roundCost: identityRound,
          metadata: WEB_SEARCH_METADATA,
          existingTokenRollup: storedRollup,
          anyRowPriced: false,
        })
      ).toEqual({});
    }
  );

  it("stays out of the way of a session that never used web search", () => {
    // The negative sibling: without it, "returns a cost patch" is satisfied by a
    // build that emits one for every token-less session, including the ordinary
    // omission this early return has always been for.
    expect(
      resolveTokenRollupColumns({
        hasTokenUsage: false,
        totals: ZERO_TOTALS,
        roundCost: identityRound,
        metadata: {},
        existingTokenRollup: null,
        anyRowPriced: false,
      })
    ).toEqual({});
    expect(
      resolveTokenRollupColumns({
        hasTokenUsage: false,
        totals: ZERO_TOTALS,
        roundCost: identityRound,
        metadata: { usageExtras: { web_search_requests: 0 } },
        existingTokenRollup: null,
        anyRowPriced: false,
      })
    ).toEqual({});
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

  // The tie whitlockk raised: pre-3bc26f527 Desktop builds commit the session row and
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

describe("resolveSessionEndForStatus (ISS-8552)", () => {
  const END = new Date("2026-06-10T12:00:00.000Z");

  // The whole defect in one assertion: max-wins had already resolved an end,
  // and the status this write resolves says the run is live. The row must not
  // be allowed to assert both.
  it("drops an end when the resolved status is active", () => {
    expect(resolveSessionEndForStatus(END, SESSION_STATUS.ACTIVE)).toBeNull();
  });

  // AC 2 — the regression resistance max-wins exists for is untouched, because
  // this gate only ever fires on a NON-terminal resolution. Both terminal
  // members are covered: `error` is a terminal state whose end is as real as
  // `inactive`'s, and folding it into the active branch would clear the end of
  // every failed run.
  it("preserves the end for each terminal status", () => {
    expect(resolveSessionEndForStatus(END, SESSION_STATUS.INACTIVE)).toBe(END);
    expect(resolveSessionEndForStatus(END, SESSION_STATUS.ERROR)).toBe(END);
  });

  // A live row with no end is the ordinary case and must stay a plain null
  // rather than acquiring one.
  it("leaves an absent end absent on either side of the gate", () => {
    expect(resolveSessionEndForStatus(null, SESSION_STATUS.ACTIVE)).toBeNull();
    expect(
      resolveSessionEndForStatus(null, SESSION_STATUS.INACTIVE)
    ).toBeNull();
  });

  // NO `waiting` CASE HERE, deliberately. The parameter is typed
  // `SessionStatus`, and both call sites hand it `normalizeSessionStatus(...)`
  // output, so the display term cannot reach this function — `tsc` rejects the
  // test that tries. An incoming `waiting` payload is covered where it IS
  // reachable, at the ingest boundary, by the fold: it normalizes to `active`
  // and takes the branch above.
});

describe("didDropContradictorySessionEnd (ISS-8552, PR #6284 review)", () => {
  const END = new Date("2026-06-10T12:00:00.000Z");

  // The metric's whole claim: THIS delivery sent an end, and the row this write
  // committed does not carry it.
  it("reports a drop when the payload's end did not survive the write", () => {
    expect(didDropContradictorySessionEnd(END, null)).toBe(true);
  });

  // whitlockk / chatgpt-codex-connector, PR #6284. The repair case, which is the
  // ordinary shape a stranded row is fixed by: the payload carries NO end, and
  // max-wins hands the write the stored one, which the gate then drops. The
  // producer sent nothing contradictory, so nothing may be counted against it —
  // reading the max-wins resolution here reported every repair as a bad payload.
  it("stays silent when the payload carried no end at all", () => {
    expect(didDropContradictorySessionEnd(null, null)).toBe(false);
  });

  // The end was sent and kept. Not a refusal. Distinguishes the predicate from
  // "the payload carried an end", which would count every terminal sync.
  it("stays silent when the committed row kept the end", () => {
    expect(didDropContradictorySessionEnd(END, END)).toBe(false);
  });

  // NO CREATE-ARM-RACE CASE HERE, and deliberately not a simulated one. whitlockk's
  // second point (PR #6284) is that the arm is the DATABASE's decision, so it
  // cannot be read off the slice's pre-upsert `existing`. The answer is
  // structural rather than conditional: this predicate has no arm parameter and
  // no pre-upsert input, so a create that landed because a sweep deleted the row
  // after that read reaches these same two arguments and is counted identically.
  // A test passing a third argument that no longer exists would assert nothing;
  // the guarantee is the parameter's absence, which `tsc` holds.
});

describe("resolveNameOverridePatch (ISS-8733, review: davetho)", () => {
  const OWNER_RENAME = "Q3 billing spike";
  const COLLECTED_OVERRIDE = "auth refactor";

  // THE CONFLICT REGRESSION. The desktop's at-least-once retry redelivers the
  // batch the rename raced, and the rename does not move `sessionUpdatedAt`, so
  // that replay arrives at an EQUAL watermark — which the freshness gate admits.
  // Only seeding-only keeps the owner's choice.
  it("refuses a replayed override on a row the owner has renamed", () => {
    expect(resolveNameOverridePatch(COLLECTED_OVERRIDE, OWNER_RENAME)).toEqual(
      {}
    );
  });

  it("seeds an override onto a row that holds none", () => {
    expect(resolveNameOverridePatch(COLLECTED_OVERRIDE, null)).toEqual({
      nameOverride: COLLECTED_OVERRIDE,
    });
  });

  // The create arm: no stored row at all, so `existing?.nameOverride` is
  // `undefined` rather than `null`. Both must seed, or a first delivery loses a
  // desktop-declared override.
  it("seeds on create, where there is no stored row to read", () => {
    expect(resolveNameOverridePatch(COLLECTED_OVERRIDE, undefined)).toEqual({
      nameOverride: COLLECTED_OVERRIDE,
    });
  });

  // ISS-8717's original refusal, still standing: an omitted override states no
  // opinion, and the key must stay ABSENT rather than carry an explicit null
  // into the spread — the update arm would otherwise clear the column.
  it("omits the key entirely when the payload claims no override", () => {
    const patch = resolveNameOverridePatch(undefined, OWNER_RENAME);
    expect(patch).toEqual({});
    expect("nameOverride" in patch).toBe(false);
    expect("nameOverride" in resolveNameOverridePatch(undefined, null)).toBe(
      false
    );
  });

  // An empty override is not a rename request. It must not seed, and it must not
  // be read as a clear either.
  it("treats an empty override as no claim, not as a clear", () => {
    expect(resolveNameOverridePatch("", OWNER_RENAME)).toEqual({});
    expect(resolveNameOverridePatch("", null)).toEqual({});
  });

  // The wire field is nullable, so an EXPLICIT null is reachable — and it is
  // still "no claim", never a clear. A producer that wants the collector's name
  // back does not get there by nulling this column, because nothing reads the
  // override as a delete instruction.
  it("reads an explicit wire null as no claim, on a renamed row and a bare one", () => {
    expect("nameOverride" in resolveNameOverridePatch(null, OWNER_RENAME)).toBe(
      false
    );
    expect("nameOverride" in resolveNameOverridePatch(null, null)).toBe(false);
  });
});
