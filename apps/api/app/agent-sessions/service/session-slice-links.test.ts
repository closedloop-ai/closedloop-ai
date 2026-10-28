/**
 * ISS-9181: the LINKS phase hands the PR lane's OWN deferral report to the
 * monitored-activity classifier, and nothing downstream re-derives it.
 *
 * Both ends of that hand-off have their own suites, and every one of them
 * supplies the lane result by hand — so emptying `pullRequestLane.deferrals`
 * here leaves them all green while each deferred target stops being
 * lane-owned, falls to the existence read, comes back `IntentionallyAbsent`,
 * and acknowledges a Session whose monitored-activity evidence the desktop
 * never resends. This file owns the seam itself: both ends run for real, and
 * only the locked authority read — an input to the seam rather than part of
 * it — is stubbed.
 */
import type { SyncedArtifactRef } from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import {
  AUTHORITATIVE_REPOSITORY,
  EVENT,
  LONG_STANDING_HOLD_START,
  ORGANIZATION_ID,
  persistenceTx,
  pullRequestRef,
  SESSION_ARTIFACT_ID,
  WITHIN_HOLD_CEILING,
} from "@/__tests__/support/agent-sessions/monitored-session-activity.test-fixtures";
import { buildSyncedSession } from "@/__tests__/support/agent-sessions/service.test-harness";
import { MONITORED_ACTIVITY_HOLD_CEILING_MS } from "./monitored-activity-hold-ceiling";
import {
  emptyMonitoredActivityOutcomeCounts,
  MonitoredActivityOutcome,
} from "./monitored-session-activity-persistence";
import { persistSessionSliceLinks } from "./session-slice-links";

vi.mock("./artifact-links/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./artifact-links/shared")>()),
  resolveSessionRepositoryIdentity: vi.fn(() =>
    Promise.resolve(AUTHORITATIVE_REPOSITORY)
  ),
}));

/**
 * After `EVENT.occurredAt`, so the carrier is not future-quarantined — and
 * ISS-11427: inside the monitored-activity hold ceiling, so a case naming a HOLD
 * still measures the classifier rather than the new wall-clock bound.
 */
const SYNC_TIMESTAMP = WITHIN_HOLD_CEILING;

/** One minute past the ceiling, measured from `EVENT.occurredAt`. */
const PAST_HOLD_CEILING = new Date(
  Date.parse(EVENT.occurredAt) + MONITORED_ACTIVITY_HOLD_CEILING_MS + 60_000
);

describe("persistSessionSliceLinks", () => {
  it("holds a target the PR lane deferred, on the lane's own report", async () => {
    const { tx } = persistenceTx();

    const links = await persistSessionSliceLinks(
      {
        ...tx,
        artifactLink: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      } as never,
      {
        artifactId: SESSION_ARTIFACT_ID,
        computeTargetId: "compute-target-1",
        organizationId: ORGANIZATION_ID,
        projectId: null,
        // ISS-11427: a session the cloud stored well before this delivery, so
        // the hold-ceiling floor is satisfied and the case still measures the
        // classifier's hold rather than the wall-clock bound.
        monitoredActivityHeldSince: LONG_STANDING_HOLD_START,
        // Provider-verifiable and carrying no head branch name: the shape the
        // lane defers as `AwaitingDesktopDelivery`, recorded before it
        // consults repository authority.
        session: buildSyncedSession({ artifactRefs: [pullRequestRef()] }),
        shouldUpdatePullRequestLinks: false,
        slugMap: new Map(),
        syncTimestamp: SYNC_TIMESTAMP,
      }
    );

    expect(links.retryRequired).toBe(true);
    // The disposition too, not the boolean alone: an empty map at the call
    // site settles this target on the existence read instead, which answers
    // `IntentionallyAbsent` and lands the candidate in a different outcome.
    // `TargetRetryRequired` is the held population and
    // `TargetNotMaterialized` its breakdown, so one candidate is tallied in
    // both on purpose.
    expect(links.monitoredActivityOutcomeCounts).toEqual({
      ...emptyMonitoredActivityOutcomeCounts(),
      [MonitoredActivityOutcome.TargetNotMaterialized]: 1,
      [MonitoredActivityOutcome.TargetRetryRequired]: 1,
    });
  });

  it("opens the stored hold start on the delivery that first holds", async () => {
    const { tx } = persistenceTx();
    const update = vi.fn().mockResolvedValue({});

    await persistSessionSliceLinks(
      {
        ...tx,
        artifactLink: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        sessionDetail: { update },
      } as never,
      {
        artifactId: SESSION_ARTIFACT_ID,
        computeTargetId: "compute-target-1",
        organizationId: ORGANIZATION_ID,
        projectId: null,
        // NOT held yet — an old session whose first monitored candidate arrives
        // now, or one whose previous delivery released the hold.
        monitoredActivityHeldSince: null,
        session: buildSyncedSession({ artifactRefs: [pullRequestRef()] }),
        shouldUpdatePullRequestLinks: false,
        slugMap: new Map(),
        syncTimestamp: SYNC_TIMESTAMP,
      }
    );

    // The wiring itself: without this call the column is never written, the
    // ceiling's floor is permanently null, and the bound never binds.
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toMatchObject({
      where: { artifactId: SESSION_ARTIFACT_ID },
      data: { monitoredActivityHeldSince: SYNC_TIMESTAMP },
    });
  });

  it("lets the ceiling bind across a split whose first part carries no carrier", async () => {
    // ISS-12031: a split session ships its event part first with every carrier
    // stripped (`sessionWithoutMonitoredActivity`), then the monitored page.
    // When the page is ack-omitted the desktop re-sends from part 0, so this
    // pair repeats on every retry. The carrier-less part must not close the
    // hold, or the page re-opens it at "now" and the ceiling never binds.
    const { tx } = persistenceTx();
    let storedHeldSince: Date | null = LONG_STANDING_HOLD_START;
    const update = vi.fn(
      ({ data }: { data: { monitoredActivityHeldSince: Date | null } }) => {
        storedHeldSince = data.monitoredActivityHeldSince;
        return Promise.resolve({});
      }
    );
    const sliceTx = {
      ...tx,
      artifactLink: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      sessionDetail: { update },
    } as never;
    const { monitoredSessionActivity: _stripped, ...carrierlessRef } =
      pullRequestRef();
    const deliver = (index: number, artifactRefs: SyncedArtifactRef[]) =>
      persistSessionSliceLinks(sliceTx, {
        artifactId: SESSION_ARTIFACT_ID,
        computeTargetId: "compute-target-1",
        organizationId: ORGANIZATION_ID,
        projectId: null,
        monitoredActivityHeldSince: storedHeldSince,
        session: buildSyncedSession({
          artifactRefs,
          chunk: { index, total: 2 },
        }),
        shouldUpdatePullRequestLinks: false,
        slugMap: new Map(),
        syncTimestamp: PAST_HOLD_CEILING,
      });

    await deliver(0, [carrierlessRef]);
    const page = await deliver(1, [pullRequestRef()]);

    // One write: the page's release at the ceiling. The carrier-less part
    // wrote nothing, so the page still measured from the long-standing start.
    expect(update).toHaveBeenCalledTimes(1);
    expect(storedHeldSince).toBeNull();
    expect(page.retryRequired).toBe(false);
    expect(
      page.monitoredActivityOutcomeCounts[
        MonitoredActivityOutcome.TargetHoldExpired
      ]
    ).toBe(1);
  });
});
