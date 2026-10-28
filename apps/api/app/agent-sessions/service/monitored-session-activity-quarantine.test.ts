/**
 * The monitored-activity quarantine's width behavior (ISS-9860) and its
 * conflicting-anchor error arms (ISS-8131 items 4-5).
 *
 * The module's happy path is covered by `monitored-session-activity.test.ts`
 * ("keeps quarantine identity stable when retry completeness changes") and
 * stays there. ISS-8131 item 3 — the per-session identity cap — was deleted by
 * ISS-9860; the first block below pins its absence and the bind-budget
 * chunking that replaced it as the only bound on a wide page.
 *
 * `assertQuarantineMatches` throws on a THREE-arm `||`, and the arms are not
 * independent by accident: `occurredAt` is inside `quarantineEventFingerprint`
 * but not inside `quarantineEventIdentityHash`, so the obvious fixture (a row
 * with a different `occurredAt`) trips two arms at once and kills neither
 * single-arm mutant. Each case below therefore isolates exactly one arm.
 *
 * No fixture rebuilds the module-private fingerprint composition. Each captures
 * the REAL fingerprint the writer produced, off
 * `monitoredSessionActivityQuarantine.createMany`, so a later change to that
 * composition cannot silently un-isolate an arm.
 */
import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import {
  MonitoredSessionActivityEventKind,
  type SyncedMonitoredSessionActivityEvent,
} from "@repo/api/src/types/session-monitored-activity";
import { describe, expect, it } from "vitest";
import {
  EVENT,
  NO_PR_LANE_DEFERRALS,
  NO_REPOSITORY_AUTHORITY,
  ORGANIZATION_ID,
  persistenceTx,
  pullRequestRef,
  RESOLVED_PR_DETAILS,
} from "@/__tests__/support/agent-sessions/monitored-session-activity.test-fixtures";
import { MAX_TRUSTED_FUTURE_SKEW_MS } from "@/lib/trusted-timestamp";
import { persistMonitoredSessionActivity } from "./monitored-session-activity";
import { MonitoredActivityOutcome } from "./monitored-session-activity-persistence";
import type { MonitoredActivityQuarantineRow } from "./monitored-session-activity-quarantine";
import { bindParameterChunkSize } from "./write-chunking";

const SESSION_ARTIFACT_ID = "019ff900-0000-7000-8000-000000000004";
const QUARANTINE_CONFLICT_MESSAGE =
  "conflicting monitored activity quarantine identity";
/** The retired per-session identity cap (ISS-9860). */
const RETIRED_PER_SESSION_CAP = 100;
/**
 * The bind budgets the production module sizes its statements against, derived
 * here independently: one bind per hash beside the org and session binds for
 * the `in` read, and the eight `MonitoredSessionActivityQuarantine` columns per
 * `createMany` row.
 */
const QUARANTINE_READ_CHUNK = bindParameterChunkSize(1, 2);
const QUARANTINE_INSERT_CHUNK = bindParameterChunkSize(8, 0);
/** The DIFFERENT throw, from `reconcileCandidate` — must not be confused. */
const CARRIER_CONFLICT_MESSAGE = "conflicting monitored activity carrier";

const RECEIVED_AT = new Date("2026-08-12T12:00:00.000Z");
/** Comfortably past the trusted future boundary, so the event is quarantined. */
const FUTURE_OCCURRED_AT = new Date(
  RECEIVED_AT.getTime() + 2 * MAX_TRUSTED_FUTURE_SKEW_MS
).toISOString();

const FUTURE_EVENT = {
  ...EVENT,
  occurredAt: FUTURE_OCCURRED_AT,
} satisfies SyncedMonitoredSessionActivityEvent;

function persistInput(event: SyncedMonitoredSessionActivityEvent) {
  return {
    organizationId: ORGANIZATION_ID,
    sessionArtifactId: SESSION_ARTIFACT_ID,
    artifactRefs: [pullRequestRef(event)],
    pullRequestLane: {
      details: RESOLVED_PR_DETAILS,
      // The lane resolved this target's row, so it defers nothing.
      deferrals: NO_PR_LANE_DEFERRALS,
    },
    repositoryIdentity: NO_REPOSITORY_AUTHORITY,
    receivedAt: RECEIVED_AT,
  };
}

/** `count` distinct future-dated events on the one resolved PR target. */
function persistManyFutureInput(count: number) {
  const events = Array.from({ length: count }, (_, index) => ({
    ...FUTURE_EVENT,
    sourceEventId: `${FUTURE_EVENT.sourceEventId}-${index}`,
  }));
  return {
    ...persistInput(FUTURE_EVENT),
    artifactRefs: [
      {
        ...pullRequestRef(FUTURE_EVENT),
        monitoredSessionActivity: {
          completeness: BranchActivityEvidenceCompleteness.Complete,
          events,
        },
      },
    ],
  };
}

/**
 * Run one ordinary quarantining sync and return the anchor the PRODUCTION
 * writer actually stored. Every corrupt-row fixture is built from this, so no
 * test knows how a fingerprint is composed.
 */
async function captureWrittenAnchor(
  event: SyncedMonitoredSessionActivityEvent
): Promise<MonitoredActivityQuarantineRow> {
  const { tx } = persistenceTx();
  await persistMonitoredSessionActivity(tx as never, persistInput(event));
  const written = tx.monitoredSessionActivityQuarantine.createMany.mock
    .calls[0][0].data[0] as MonitoredActivityQuarantineRow;
  return written;
}

/** A tx whose quarantine reads always return exactly `row`. */
function txReturningQuarantineRow(row: MonitoredActivityQuarantineRow) {
  const harness = persistenceTx();
  harness.tx.monitoredSessionActivityQuarantine.findMany.mockImplementation(
    () => [row]
  );
  return harness;
}

describe("monitored activity quarantine — no identity cap, chunked statements (ISS-9860)", () => {
  it("anchors every new future identity past the retired per-session cap without a throw", async () => {
    const { tx } = persistenceTx();
    const count = RETIRED_PER_SESSION_CAP + 1;

    const result = await persistMonitoredSessionActivity(
      tx as never,
      persistManyFutureInput(count)
    );

    expect(result.retryRequired).toBe(true);
    expect(result.persistedCount).toBe(0);
    expect(
      result.outcomeCounts[MonitoredActivityOutcome.FutureRetryRequired]
    ).toBe(count);
    expect(writtenQuarantineRows(tx)).toBe(count);
    expect(tx.branchActivityAtom.createMany).not.toHaveBeenCalled();
    expect(tx.branchActivityAtom.createManyAndReturn).not.toHaveBeenCalled();
  });

  it("splits the identity read and the anchor insert at the bind budget for a page wider than one chunk", async () => {
    const { tx } = persistenceTx();
    const count = QUARANTINE_READ_CHUNK + 1;

    const result = await persistMonitoredSessionActivity(
      tx as never,
      persistManyFutureInput(count)
    );

    expect(
      result.outcomeCounts[MonitoredActivityOutcome.FutureRetryRequired]
    ).toBe(count);
    // The trust partition reads the anchors once before the write and once
    // after it, so each read costs one statement per chunk.
    const readChunks = Math.ceil(count / QUARANTINE_READ_CHUNK);
    expect(readChunks).toBe(2);
    expect(
      tx.monitoredSessionActivityQuarantine.findMany
    ).toHaveBeenCalledTimes(2 * readChunks);
    for (const [args] of tx.monitoredSessionActivityQuarantine.findMany.mock
      .calls) {
      expect(args.where.eventIdentityHash.in.length).toBeLessThanOrEqual(
        QUARANTINE_READ_CHUNK
      );
    }
    const insertChunks = Math.ceil(count / QUARANTINE_INSERT_CHUNK);
    expect(insertChunks).toBeGreaterThan(1);
    expect(
      tx.monitoredSessionActivityQuarantine.createMany
    ).toHaveBeenCalledTimes(insertChunks);
    for (const [args] of tx.monitoredSessionActivityQuarantine.createMany.mock
      .calls) {
      expect(args.data.length).toBeLessThanOrEqual(QUARANTINE_INSERT_CHUNK);
    }
    expect(writtenQuarantineRows(tx)).toBe(count);
  });
});

describe("monitored activity quarantine — conflicting anchor (ISS-8131 items 4-5)", () => {
  it("rejects on the FINGERPRINT arm alone when only the event kind changed", async () => {
    // `kind` is in the fingerprint but NOT in the identity hash, so the stored
    // anchor is still FOUND while only the fingerprint diverges. `occurredAt`
    // matches (arm 2 false) and the anchor is genuinely future-dated relative to
    // its own receivedAt (arm 3 false) — so deleting the fingerprint arm is the
    // only mutation this case can survive.
    const stored = await captureWrittenAnchor(FUTURE_EVENT);
    const { tx } = txReturningQuarantineRow(stored);
    const reKinded = {
      ...FUTURE_EVENT,
      kind: MonitoredSessionActivityEventKind.AgentAction,
    } satisfies SyncedMonitoredSessionActivityEvent;

    await expect(
      persistMonitoredSessionActivity(tx as never, persistInput(reKinded))
    ).rejects.toThrow(QUARANTINE_CONFLICT_MESSAGE);
    expect(tx.branchActivityAtom.createMany).not.toHaveBeenCalled();
  });

  it("rejects on the OCCURRED-AT arm alone when a corrupt row's column disagrees with its own fingerprint", async () => {
    // Unreachable for any row this code WROTE — the writer derives the
    // fingerprint and the column from one candidate — so this is a
    // persisted-row trust boundary: a hand-edited or migration-damaged anchor.
    // The fingerprint is the real one, so arm 1 is false; the row stays outside
    // the trusted boundary, so arm 3 is false.
    const stored = await captureWrittenAnchor(FUTURE_EVENT);
    const { tx } = txReturningQuarantineRow({
      ...stored,
      occurredAt: new Date(Date.parse(FUTURE_OCCURRED_AT) + 60_000),
    });

    await expect(
      persistMonitoredSessionActivity(tx as never, persistInput(FUTURE_EVENT))
    ).rejects.toThrow(QUARANTINE_CONFLICT_MESSAGE);
    expect(tx.branchActivityAtom.createMany).not.toHaveBeenCalled();
  });

  it("rejects on the TRUSTED-BOUNDARY arm alone when a stored anchor was never future-dated", async () => {
    // Both writers guarantee the negation at write time, so an anchor whose own
    // `occurredAt` sits inside the trusted boundary of its own `receivedAt`
    // should not exist. Fingerprint and column both match the candidate, so
    // arms 1 and 2 are false and only the boundary arm can throw.
    const stored = await captureWrittenAnchor(FUTURE_EVENT);
    const { tx } = txReturningQuarantineRow({
      ...stored,
      receivedAt: stored.occurredAt,
    });

    await expect(
      persistMonitoredSessionActivity(tx as never, persistInput(FUTURE_EVENT))
    ).rejects.toThrow(QUARANTINE_CONFLICT_MESSAGE);
    expect(tx.branchActivityAtom.createMany).not.toHaveBeenCalled();
  });

  it("throws NOTHING and re-reports the future candidate on an identical re-send", async () => {
    // The negative that makes the three above mean something: with all three
    // arms false, the anchor is honoured and the candidate comes back as a
    // future retry rather than an error.
    const stored = await captureWrittenAnchor(FUTURE_EVENT);
    const { tx } = txReturningQuarantineRow(stored);

    const result = await persistMonitoredSessionActivity(
      tx as never,
      persistInput(FUTURE_EVENT)
    );

    expect(result.retryRequired).toBe(true);
    expect(result.persistedCount).toBe(0);
    expect(
      result.outcomeCounts[MonitoredActivityOutcome.FutureRetryRequired]
    ).toBe(1);
    expect(tx.branchActivityAtom.createMany).not.toHaveBeenCalled();
  });

  it("is a DIFFERENT throw from the carrier-identity conflict", async () => {
    // The only conflict assertion that existed before this suite matches
    // "conflicting monitored activity CARRIER identity" — a different throw, in
    // `reconcileCandidate`, on a different path. Pinning that they are distinct
    // stops a future reader reading the covered one as covering this one.
    const stored = await captureWrittenAnchor(FUTURE_EVENT);
    const { tx } = txReturningQuarantineRow(stored);
    const reKinded = {
      ...FUTURE_EVENT,
      kind: MonitoredSessionActivityEventKind.AgentAction,
    } satisfies SyncedMonitoredSessionActivityEvent;

    await expect(
      persistMonitoredSessionActivity(tx as never, persistInput(reKinded))
    ).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(CARRIER_CONFLICT_MESSAGE),
      })
    );
  });
});

function writtenQuarantineRows(
  tx: ReturnType<typeof persistenceTx>["tx"]
): number {
  return tx.monitoredSessionActivityQuarantine.createMany.mock.calls.reduce(
    (total, [args]) => total + args.data.length,
    0
  );
}
