/**
 * ISS-11427: the wall-clock ceiling that stops a monitored-activity hold
 * terminating in silent loss.
 *
 * The production-path cases drive `persistMonitoredSessionActivity` — the same
 * entry point the ingest slice calls — with the exact held shape the sibling
 * retention suite pins, and move only the DELIVERY CLOCK across the ceiling. So
 * each pair is a counterfactual on the one input this ticket changed the meaning
 * of: inside the ceiling the hold stands (which is what would keep these green
 * if the gate were simply off), past it the hold resolves, the evidence is filed,
 * and the session is acknowledged.
 */

import { MonitoredTargetDisposition } from "@repo/api/src/types/monitored-activity-target";
import { log } from "@repo/observability/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  candidate,
  heldDelivery,
  PAST_CEILING,
  SESSION_ARTIFACT_ID,
  unresolvableTx,
  WITHIN_CEILING,
} from "@/__tests__/support/agent-sessions/monitored-activity-hold-ceiling.test-fixtures";
import {
  branchRef,
  EVENT,
  LONG_STANDING_HOLD_START,
  ORGANIZATION_ID,
  persistenceTx,
  pullRequestRef,
} from "@/__tests__/support/agent-sessions/monitored-session-activity.test-fixtures";
import {
  isRetainedMonitoredActivityRowsQuery,
  retainedRowsQueryTargets,
} from "@/__tests__/support/agent-sessions/retained-monitored-activity-rows.test-fixtures";
import {
  collectExpiredMonitoredActivityHolds,
  MONITORED_ACTIVITY_HOLD_CEILING_MS,
  recordMonitoredActivityHoldStart,
  reportAbandonedMonitoredActivityHolds,
  resetAbandonedMonitoredActivityHoldThrottle,
} from "./monitored-activity-hold-ceiling";
import { persistMonitoredSessionActivity } from "./monitored-session-activity";
import { MonitoredActivityOutcome } from "./monitored-session-activity-persistence";
import { monitoredActivityCandidateIdentity } from "./monitored-session-activity-shared";

describe("monitored-activity hold ceiling (ISS-11427)", () => {
  it("keeps holding a retry-owned target inside the ceiling", async () => {
    const { tx, retained } = unresolvableTx();

    const result = await persistMonitoredSessionActivity(
      tx as never,
      heldDelivery(WITHIN_CEILING)
    );

    // The gate's OFF arm. Without this the sibling case below would also pass
    // with the ceiling set to zero, which would be a different (and lossy)
    // change wearing this ticket's name.
    expect(result.retryRequired).toBe(true);
    expect(
      result.outcomeCounts[MonitoredActivityOutcome.TargetRetryRequired]
    ).toBe(1);
    expect(
      result.outcomeCounts[MonitoredActivityOutcome.TargetHoldExpired]
    ).toBe(0);
    expect(retained()).toHaveLength(0);
  });

  it("resolves the hold past the ceiling, files the evidence, and acknowledges the session", async () => {
    const { tx, retained } = unresolvableTx();

    const result = await persistMonitoredSessionActivity(
      tx as never,
      heldDelivery(PAST_CEILING)
    );

    // THE defect this ticket exists for: `retryRequired` is what withholds the
    // id from `acceptedSessionIds`, which is what burns the desktop's bounded
    // `ack_omitted` budget until the row is abandoned. Before this change this
    // assertion read `true` forever.
    expect(result.retryRequired).toBe(false);
    // And the resolution is NOT a discard: the evidence is filed on the session
    // artifact, the shape PLN-2061's operator ruling requires.
    expect(retained()).toHaveLength(1);
    expect(retained()[0].after.disposition).toBe(
      MonitoredTargetDisposition.HoldExpired
    );
    expect(
      result.outcomeCounts[MonitoredActivityOutcome.TargetHoldExpired]
    ).toBe(1);
    expect(
      result.outcomeCounts[MonitoredActivityOutcome.TargetRetryRequired]
    ).toBe(0);
    // The classified reason still lands in its own breakdown member, so
    // "classified not-materialized, abandoned at the ceiling" stays readable.
    expect(
      result.outcomeCounts[MonitoredActivityOutcome.TargetNotMaterialized]
    ).toBe(1);
  });

  it("keeps holding on the delivery that OPENS the hold, however old the session", async () => {
    const { tx, retained } = unresolvableTx();

    // #8064 review (whitlockk, tamsinb, Codex P1): the session row is old — synced
    // yesterday, back after two hours offline — and its catch-up activity is far
    // past the ceiling. What is NOT past the ceiling is the hold, because this
    // delivery is the one opening it. Measured from `SessionDetail.createdAt`,
    // as this shipped before the review, every candidate here expired with ZERO
    // retries on the first delivery and the warn fired on ordinary catch-up.
    const result = await persistMonitoredSessionActivity(
      tx as never,
      heldDelivery(PAST_CEILING, null)
    );

    expect(result.retryRequired).toBe(true);
    expect(
      result.outcomeCounts[MonitoredActivityOutcome.TargetHoldExpired]
    ).toBe(0);
    expect(retained()).toHaveLength(0);
  });

  it("keeps holding while the session itself is younger than the ceiling", async () => {
    const { tx, retained } = unresolvableTx();

    // The second delivery, moments after the first. The event is ancient; the
    // HOLD is seconds old, and it is the hold this ceiling bounds.
    const result = await persistMonitoredSessionActivity(
      tx as never,
      heldDelivery(PAST_CEILING, new Date(PAST_CEILING.getTime() - 1000))
    );

    expect(result.retryRequired).toBe(true);
    expect(
      result.outcomeCounts[MonitoredActivityOutcome.TargetHoldExpired]
    ).toBe(0);
    expect(retained()).toHaveLength(0);
  });

  it("expires the session's whole hold once ANY candidate is past the ceiling", async () => {
    const { tx, retained } = unresolvableTx();
    const stale = pullRequestRef({
      ...EVENT,
      sourceEventId: "monitored_session_v1:stale",
    });
    const fresh = pullRequestRef({
      ...EVENT,
      sourceEventId: "monitored_session_v1:fresh",
      occurredAt: new Date(PAST_CEILING.getTime() - 60_000).toISOString(),
    });

    const result = await persistMonitoredSessionActivity(tx as never, {
      ...heldDelivery(PAST_CEILING),
      artifactRefs: [stale, fresh],
    });

    // `retryRequired` is ONE boolean for the session, so a fresher sibling
    // withholds the id just as effectively — and a live session on a repository
    // nothing will materialize keeps producing them, which is how per-candidate
    // expiry alone still ends in an abandoned session.
    expect(result.retryRequired).toBe(false);
    expect(retained()).toHaveLength(2);
  });

  it("sweeps rather than settles a forward-skewed occurredAt once the hold has stood past the ceiling", () => {
    // #8064 review (tamsinb): `isWithinTrustedFutureBoundary` TRUSTS 24h of
    // forward skew, so a desktop only seconds fast stamps every event it has
    // just recorded ahead of the delivery instant, and expiring it on its OWN
    // age would abandon a brand-new candidate with zero retries. #8737, operator
    // ruling 2026-10-12: it may no longer hold the session past the ceiling
    // either, so the hold's own age sweeps it — not in `ownAge`, so a later
    // delivery gives it a fresh hold.
    const skewed = candidate(
      new Date(PAST_CEILING.getTime() + 15 * 60_000).toISOString()
    );
    const longHold = collectExpiredMonitoredActivityHolds(
      [skewed],
      PAST_CEILING,
      LONG_STANDING_HOLD_START
    );
    const youngHold = collectExpiredMonitoredActivityHolds(
      [skewed],
      PAST_CEILING,
      new Date(PAST_CEILING.getTime() - 1000)
    );

    expect([...longHold.expired]).toEqual([
      monitoredActivityCandidateIdentity(skewed),
    ]);
    expect(longHold.ownAge.size).toBe(0);
    expect(youngHold.expired.size).toBe(0);
  });

  it("expires a forward-skewed event once the delivery clock overtakes it", () => {
    // The deferral is bounded by the skew, not indefinite: the stamp is fixed in
    // the payload rather than re-pinned per delivery.
    const skewed = new Date(PAST_CEILING.getTime() + 15 * 60_000);
    expect(
      collectExpiredMonitoredActivityHolds(
        [candidate(skewed.toISOString())],
        new Date(skewed.getTime() + MONITORED_ACTIVITY_HOLD_CEILING_MS + 1000),
        LONG_STANDING_HOLD_START
      ).expired.size
    ).toBe(1);
  });

  it("bounds a LONE forward-skewed held candidate by the hold ceiling, then holds it afresh", async () => {
    // ISS-12031 explanation 2 pinned the skew alone as the bound. #8737,
    // operator ruling 2026-10-12: the existing ceiling bounds it now, and the
    // sweep does not settle it, so the next delivery holds it again.
    const skewed = new Date(PAST_CEILING.getTime() + 15 * 60_000);
    const lone = {
      ...heldDelivery(PAST_CEILING),
      artifactRefs: [
        pullRequestRef({ ...EVENT, occurredAt: skewed.toISOString() }),
      ],
    };
    const { tx } = unresolvableTx();

    const swept = await persistMonitoredSessionActivity(tx as never, lone);
    const next = await persistMonitoredSessionActivity(tx as never, {
      ...lone,
      receivedAt: new Date(PAST_CEILING.getTime() + 60_000),
      monitoredActivityHeldSince: null,
    });

    expect(swept.retryRequired).toBe(false);
    expect(
      swept.outcomeCounts[MonitoredActivityOutcome.TargetHoldExpired]
    ).toBe(1);
    expect(next.retryRequired).toBe(true);
  });

  it("measures an unparseable occurredAt from the hold's own start", () => {
    // #8737, operator ruling 2026-10-12: this used to assert the stamp never
    // trips the ceiling. Once its sibling's target is settled and stops being
    // held, nothing else could, so the session stayed held for good.
    const malformed = candidate("not-a-date");
    const pastCeiling = collectExpiredMonitoredActivityHolds(
      [malformed],
      PAST_CEILING,
      LONG_STANDING_HOLD_START
    );
    const youngHold = collectExpiredMonitoredActivityHolds(
      [malformed],
      PAST_CEILING,
      new Date(PAST_CEILING.getTime() - 1000)
    );

    expect([...pastCeiling.ownAge]).toEqual([
      monitoredActivityCandidateIdentity(malformed),
    ]);
    expect(youngHold.expired.size).toBe(0);
  });

  it("still carries an unparseable occurredAt once a sibling trips it", () => {
    // #8064 review (tamsinb): the "never expires" claim held only because that
    // candidate was alone. It must NOT be exempt — leaving it held would leave
    // `retryRequired` true and the bound would not bind at all — so the
    // whole-session escalation carries it, and only the tripping is refused.
    const malformed = candidate("not-a-date");
    const expired = collectExpiredMonitoredActivityHolds(
      [malformed, candidate(EVENT.occurredAt)],
      PAST_CEILING,
      LONG_STANDING_HOLD_START
    );

    expect(
      expired.expired.has(monitoredActivityCandidateIdentity(malformed))
    ).toBe(true);
  });

  it("does not let a RESOLVED stale ref expire a fresh held sibling", async () => {
    // #8064 review (whitlockk, tamsinb): the desktop re-sends the whole carrier
    // snapshot on every delivery, so a long session always carries refs whose
    // atoms landed hours ago. Collecting over EVERY candidate put those in scope
    // of the whole-session escalation, and a stale one tripped it on essentially
    // every sync — the agent opens a PR, the webhook is 20s behind, and the fresh
    // ref went straight to HoldExpired on its FIRST delivery. Only the held
    // candidates — unresolved AND retry-owned — may trip the ceiling.
    const { tx, retained } = persistenceTx();
    const stale = branchRef("feature/landed-hours-ago", {
      ...EVENT,
      sourceEventId: "monitored_session_v1:resolved-stale",
    });
    const fresh = pullRequestRef({
      ...EVENT,
      sourceEventId: "monitored_session_v1:fresh-held",
      occurredAt: new Date(PAST_CEILING.getTime() - 20_000).toISOString(),
    });

    const result = await persistMonitoredSessionActivity(tx as never, {
      ...heldDelivery(PAST_CEILING),
      artifactRefs: [stale, fresh],
    });

    expect(result.retryRequired).toBe(true);
    expect(
      result.outcomeCounts[MonitoredActivityOutcome.TargetHoldExpired]
    ).toBe(0);
    expect(retained()).toHaveLength(0);
  });

  it("reads the session's retained rows once when both the ceiling and the retraction need them", async () => {
    // #8737 review (tamsinb): apps/api AGENTS.md, "Read a scope ONCE per
    // request". A held candidate beside a resolved one runs both readers.
    const { tx } = persistenceTx();
    const resolved = branchRef("feature/resolved", {
      ...EVENT,
      sourceEventId: "monitored_session_v1:resolved",
    });

    await persistMonitoredSessionActivity(tx as never, {
      ...heldDelivery(WITHIN_CEILING),
      artifactRefs: [resolved, pullRequestRef()],
    });

    const retainedReads = tx.$queryRaw.mock.calls.filter((call: unknown[]) =>
      isRetainedMonitoredActivityRowsQuery(call[0])
    );
    expect(retainedReads).toHaveLength(1);
  });

  it("asks the retained read for this delivery's targets only", async () => {
    // #8737 follow-up: the read used to fetch every retained row of the
    // session; it now names the delivery's targets, and the index answers it.
    const { tx } = persistenceTx();
    const resolved = branchRef("feature/resolved", {
      ...EVENT,
      sourceEventId: "monitored_session_v1:resolved",
    });

    await persistMonitoredSessionActivity(tx as never, {
      ...heldDelivery(WITHIN_CEILING),
      artifactRefs: [resolved, pullRequestRef()],
    });

    const [read] = tx.$queryRaw.mock.calls.filter((call: unknown[]) =>
      isRetainedMonitoredActivityRowsQuery(call[0])
    );
    expect(retainedRowsQueryTargets(read?.[0])).toEqual(
      expect.arrayContaining([
        {
          kind: resolved.kind,
          repositoryFullName: resolved.repositoryFullName,
          targetName: resolved.branchName,
        },
        {
          kind: pullRequestRef().kind,
          repositoryFullName: pullRequestRef().repositoryFullName,
          targetName: String(pullRequestRef().prNumber),
        },
      ])
    );
    expect(retainedRowsQueryTargets(read?.[0])).toHaveLength(2);
  });

  it("opens the hold on the delivery that first needs a retry", async () => {
    const { tx } = unresolvableTx();

    const result = await persistMonitoredSessionActivity(
      tx as never,
      heldDelivery(PAST_CEILING, null)
    );

    // The narrow half of `retryRequired`, and the value the stored hold start is
    // written from — see `recordMonitoredActivityHoldStart`.
    expect(result.holdRetained).toBe(true);
  });

  it("closes the hold on the delivery that resolves it", async () => {
    const { tx } = unresolvableTx();

    const result = await persistMonitoredSessionActivity(
      tx as never,
      heldDelivery(PAST_CEILING)
    );

    expect(result.holdRetained).toBe(false);
  });
});

describe("collectExpiredMonitoredActivityHolds (ISS-11427)", () => {
  it("names only the candidates past the ceiling", () => {
    const stale = candidate(EVENT.occurredAt);
    const fresh = candidate(new Date(PAST_CEILING).toISOString());

    const expired = collectExpiredMonitoredActivityHolds(
      [stale, fresh],
      PAST_CEILING,
      LONG_STANDING_HOLD_START
    );

    // Both gates read THIS set, so a candidate in it is terminal on both sides
    // and one outside it is still owed on both — the agreement
    // `assertEveryMonitoredCandidateAccounted` depends on.
    assert.deepEqual(
      [...expired.expired],
      [monitoredActivityCandidateIdentity(stale)]
    );
  });
});

describe("recordMonitoredActivityHoldStart (ISS-11427)", () => {
  function updateTx() {
    const update = vi.fn().mockResolvedValue({});
    return { update, tx: { sessionDetail: { update } } };
  }

  function record(
    tx: unknown,
    input: {
      storedHeldSince: Date | null;
      holdRetained: boolean;
      chunk?: { index: number; total: number } | null;
      storedPartRetained?: boolean | null;
    }
  ) {
    return recordMonitoredActivityHoldStart(tx as never, {
      sessionArtifactId: SESSION_ARTIFACT_ID,
      storedPartRetained: null,
      chunk: null,
      receivedAt: PAST_CEILING,
      ...input,
    });
  }

  it("stamps the delivery instant on the hold's FIRST delivery", async () => {
    const { tx, update } = updateTx();

    await record(tx, { storedHeldSince: null, holdRetained: true });

    // The clock the ceiling measures from starts HERE, not at the session row's
    // own creation — which is what makes an old session's first held candidate,
    // and a two-hour-offline catch-up, get their full thirty minutes.
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toMatchObject({
      where: { artifactId: SESSION_ARTIFACT_ID },
      data: { monitoredActivityHeldSince: PAST_CEILING },
    });
  });

  it("clears the start when an unsplit delivery releases the hold", async () => {
    const { tx, update } = updateTx();

    await record(tx, {
      storedHeldSince: LONG_STANDING_HOLD_START,
      holdRetained: false,
    });

    expect(update.mock.calls[0][0].data).toEqual({
      monitoredActivityHeldSince: null,
    });
  });

  it("writes nothing while a standing hold simply continues", async () => {
    const { tx, update } = updateTx();

    await record(tx, {
      storedHeldSince: LONG_STANDING_HOLD_START,
      holdRetained: true,
    });

    // Re-stamping would re-pin the ceiling on every delivery and the hold would
    // never expire; writing at all would cost a statement per ordinary sync.
    expect(update).not.toHaveBeenCalled();
  });

  it("writes nothing on an ordinary unheld sync", async () => {
    const { tx, update } = updateTx();

    await record(tx, { storedHeldSince: null, holdRetained: false });

    expect(update).not.toHaveBeenCalled();
  });
});

describe("recordMonitoredActivityHoldStart across a split (ISS-12031)", () => {
  /**
   * Drives every part of one split delivery through the writer against a
   * stored row, the way consecutive part requests see it.
   */
  async function deliverSplit(
    stored: { heldSince: Date | null; partRetained: boolean | null },
    partsRetained: readonly boolean[]
  ) {
    const row = { ...stored };
    const update = vi.fn(
      ({
        data,
      }: {
        data: {
          monitoredActivityHeldSince?: Date | null;
          monitoredActivityHoldPartRetained?: boolean;
        };
      }) => {
        if ("monitoredActivityHeldSince" in data) {
          row.heldSince = data.monitoredActivityHeldSince ?? null;
        }
        if (data.monitoredActivityHoldPartRetained !== undefined) {
          row.partRetained = data.monitoredActivityHoldPartRetained;
        }
        return Promise.resolve({});
      }
    );
    for (const [index, holdRetained] of partsRetained.entries()) {
      await recordMonitoredActivityHoldStart(
        { sessionDetail: { update } } as never,
        {
          sessionArtifactId: SESSION_ARTIFACT_ID,
          storedHeldSince: row.heldSince,
          storedPartRetained: row.partRetained,
          holdRetained,
          chunk: { index, total: partsRetained.length },
          receivedAt: PAST_CEILING,
        }
      );
    }
    return row;
  }

  it("keeps a standing start when an early part is clear and a later one holds", async () => {
    // The page order tamsinb described: page 1 all resolved, page 2 holding
    // the stuck target. Releasing on page 1 let page 2 re-open the hold at
    // "now" on every ack-omit retry, so the ceiling never bound.
    const row = await deliverSplit(
      { heldSince: LONG_STANDING_HOLD_START, partRetained: null },
      [false, true]
    );

    expect(row.heldSince).toBe(LONG_STANDING_HOLD_START);
  });

  it("keeps it when an early part holds and the last part is clear", async () => {
    const row = await deliverSplit(
      { heldSince: LONG_STANDING_HOLD_START, partRetained: null },
      [true, false, false]
    );

    expect(row.heldSince).toBe(LONG_STANDING_HOLD_START);
  });

  it("releases on the last part once no part of the split retained", async () => {
    // Not releasing a split at all would leave a chunked session's start in
    // place forever, and a later, separate hold would expire on its first
    // delivery.
    const row = await deliverSplit(
      { heldSince: LONG_STANDING_HOLD_START, partRetained: true },
      [false, false]
    );

    expect(row.heldSince).toBeNull();
  });

  it("does not let a previous attempt's marker block this split's release", async () => {
    // The marker is reset on part 0, so a retry that now resolves everything
    // releases even though the last attempt retained.
    const first = await deliverSplit(
      { heldSince: LONG_STANDING_HOLD_START, partRetained: null },
      [false, true]
    );
    const retry = await deliverSplit(
      { heldSince: first.heldSince, partRetained: first.partRetained },
      [false, false]
    );

    expect(first.partRetained).toBe(true);
    expect(retry.heldSince).toBeNull();
  });

  it("opens the hold on the part that first retains", async () => {
    const row = await deliverSplit({ heldSince: null, partRetained: null }, [
      false,
      true,
    ]);

    expect(row.heldSince).toBe(PAST_CEILING);
  });
});

describe("reportAbandonedMonitoredActivityHolds (ISS-11427)", () => {
  const context = {
    computeTargetId: "019ff900-0000-7000-8000-00000000000c",
    organizationId: ORGANIZATION_ID,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    resetAbandonedMonitoredActivityHoldThrottle();
  });

  // Unconditional, never the last line of the one case that installs them: an
  // assertion throwing between would otherwise leak a frozen clock into every
  // later case in this worker.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("warns once with the abandoned count", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    reportAbandonedMonitoredActivityHolds(context, 3);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({
      computeTargetId: context.computeTargetId,
      organizationId: context.organizationId,
      holdExpiredCount: 3,
      holdCeilingMs: MONITORED_ACTIVITY_HOLD_CEILING_MS,
    });
  });

  it("stays silent when nothing was abandoned", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    reportAbandonedMonitoredActivityHolds(context, 0);

    expect(warn).not.toHaveBeenCalled();
  });

  it("spends a per-organization budget instead of one warn per batch", () => {
    // #8064 review (whitlockk): batching the count bounds the line per BATCH, and an
    // authenticated caller chooses how many batches it sends. `apps/api/AGENTS.md`
    // ("Emission and Abuse Control") wants the budget per org/reason; the reason
    // is fixed here, so the organization is the key.
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    for (let index = 0; index < 25; index += 1) {
      reportAbandonedMonitoredActivityHolds(context, 1);
    }

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("keeps a second organization's first warn out of the first one's budget", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    reportAbandonedMonitoredActivityHolds(context, 1);
    reportAbandonedMonitoredActivityHolds(
      { ...context, organizationId: "019ff900-0000-7000-8000-00000000000d" },
      1
    );

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("flushes what the budget suppressed as an aggregated rollup", () => {
    // Suppressed is not discarded: the monitor still sees the volume, marked so
    // it cannot be mistaken for a first occurrence.
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T00:00:00.000Z"));
    reportAbandonedMonitoredActivityHolds(context, 1);
    reportAbandonedMonitoredActivityHolds(context, 1);
    reportAbandonedMonitoredActivityHolds(context, 1);
    vi.setSystemTime(new Date("2026-09-28T00:05:00.000Z"));

    reportAbandonedMonitoredActivityHolds(context, 1);

    expect(warn.mock.calls.map(([, fields]) => fields)).toContainEqual(
      expect.objectContaining({ occurrences: 2, aggregated: true })
    );
  });
});
