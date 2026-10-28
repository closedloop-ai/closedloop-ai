import type { SyncedPullRequestArtifactRef } from "@repo/api/src/types/session-artifact-link";
import type { SyncedMonitoredSessionActivityEvent } from "@repo/api/src/types/session-monitored-activity";
import { describe, expect, it } from "vitest";
import {
  EVENT,
  laneDeferrals,
  NO_PR_DETAILS,
  NO_PR_LANE_DEFERRALS,
  NO_REPOSITORY_AUTHORITY,
  ORGANIZATION_ID,
  observedOnlyAlongside,
  onlyOutcome,
  persistenceTx,
  probedAlongside,
  pullRequestRef,
  SESSION_ARTIFACT_ID,
  WITHIN_HOLD_CEILING,
} from "@/__tests__/support/agent-sessions/monitored-session-activity.test-fixtures";
import { PullRequestLaneDeferral } from "./artifact-links/pull-request-lane-deferral";
import { persistMonitoredSessionActivity } from "./monitored-session-activity";
import {
  emptyMonitoredActivityOutcomeCounts,
  MonitoredActivityOutcome,
} from "./monitored-session-activity-persistence";

/** ISS-9181's production shape: upstream OSS the organization has no claim on. */

const OUT_OF_SCOPE_REPOSITORY = "prisma/prisma-engines";
const OUT_OF_SCOPE_PR_NUMBER = 5860;

/**
 * What the PR lane reports for {@link outOfScopePullRequestRef}'s two shapes.
 * Stated, never derived from the refs: a fixture that re-derived the lane's
 * verdict could not catch the two disagreeing, which is the defect the lane's
 * own report exists to remove.
 */
const AWAITING_REPOSITORY_READ = laneDeferrals({
  repositoryFullName: OUT_OF_SCOPE_REPOSITORY,
  prNumber: OUT_OF_SCOPE_PR_NUMBER,
  deferral: PullRequestLaneDeferral.AwaitingRepositoryRead,
});
const AWAITING_DESKTOP_DELIVERY = laneDeferrals({
  repositoryFullName: OUT_OF_SCOPE_REPOSITORY,
  prNumber: OUT_OF_SCOPE_PR_NUMBER,
  deferral: PullRequestLaneDeferral.AwaitingDesktopDelivery,
});

/**
 * What the organization's RELATIONSHIP to a repository decides: whether a
 * monitored-activity target is acknowledged or held.
 *
 * Split out of `monitored-session-activity.test.ts` when PLN-2061 M1 pushed
 * that file past the 1,000-line ceiling. The seam is a real one: everything
 * here asserts `retryRequired` and `outcomeCounts` for a repository the
 * organization can or cannot reach, while the parent file asserts the rows a
 * delivery writes.
 */
describe("persistMonitoredSessionActivity, by repository scope", () => {
  /**
   * ISS-9181 assigned this shape a side deliberately. The ref is
   * `monitoredActivityOnly`, and `collectIdentityOnlyRepositoryNames` carries
   * no such filter, so this repository's name IS queried for identity: absence
   * from the authority map is a real "the organization holds no claim on it",
   * not a lookup that never ran. It is therefore acknowledged, and counted
   * under its own outcome rather than the transport skip.
   */
  it("acknowledges a transport-only ref whose repository the organization has no identity for", async () => {
    const { tx } = persistenceTx();
    tx.branchDetail.findMany.mockResolvedValue([]);
    tx.pullRequestDetail.findMany.mockResolvedValue([]);

    await expect(
      persistMonitoredSessionActivity(tx as never, {
        organizationId: ORGANIZATION_ID,
        sessionArtifactId: SESSION_ARTIFACT_ID,
        artifactRefs: [
          { ...pullRequestRef(), monitoredActivityOnly: true as const },
        ],
        pullRequestLane: {
          details: NO_PR_DETAILS,
          // `monitoredActivityOnly`, so the lane never ran over this identity.
          deferrals: NO_PR_LANE_DEFERRALS,
        },
        repositoryIdentity: NO_REPOSITORY_AUTHORITY,
      })
    ).resolves.toMatchObject({
      retryRequired: false,
      outcomeCounts: onlyOutcome(
        MonitoredActivityOutcome.TargetRepositoryOutOfScope,
        1
      ),
    });
  });

  /**
   * The reported incident, end to end at this seam: SES-87947 named
   * `prisma/prisma-engines`, an upstream OSS repository the organization holds
   * no installation and no `Repository` row for. `retryRequired: false` is what
   * puts the already-committed Session into `acceptedSessionIds`
   * (`upsert-sessions-batch.ts`, `persisted && !retryRequired`) instead of
   * telling the user its data could not be uploaded.
   */
  it("acknowledges a trusted target on a repository the organization has no claim on", async () => {
    const { tx } = persistenceTx();
    tx.pullRequestDetail.findMany.mockResolvedValue([]);

    const result = await persistMonitoredSessionActivity(tx as never, {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      artifactRefs: [outOfScopePullRequestRef()],
      pullRequestLane: {
        details: NO_PR_DETAILS,
        deferrals: AWAITING_REPOSITORY_READ,
      },
      // The org's own fork resolves normally; the upstream repo was read for on
      // the identity lane and had no identity in any source.
      repositoryIdentity: probedAlongside(OUT_OF_SCOPE_REPOSITORY),
    });

    expect(result).toMatchObject({
      retryRequired: false,
      persistedCount: 0,
      outcomeCounts: onlyOutcome(
        MonitoredActivityOutcome.TargetRepositoryOutOfScope,
        1
      ),
    });
    expect(tx.branchActivityAtom.createMany).not.toHaveBeenCalled();
  });

  /**
   * ISS-9181 code review: this was named for the desktop's `ack_omitted` budget
   * and could not detect a regression in it — that budget lives in the desktop
   * client, nothing here carries state between calls, and any implementation
   * deterministic on this input answers both calls alike. The name now claims
   * only what the assertions pin: the classification is a pure function of the
   * delivery, so a redelivery of the same payload lands the same way.
   */
  it("answers a redelivered out-of-scope payload identically", async () => {
    const { tx } = persistenceTx();
    tx.pullRequestDetail.findMany.mockResolvedValue([]);
    const input = {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      artifactRefs: [outOfScopePullRequestRef()],
      pullRequestLane: {
        details: NO_PR_DETAILS,
        deferrals: AWAITING_REPOSITORY_READ,
      },
      repositoryIdentity: probedAlongside(OUT_OF_SCOPE_REPOSITORY),
    };

    const first = await persistMonitoredSessionActivity(tx as never, input);
    const second = await persistMonitoredSessionActivity(tx as never, input);

    expect(first.retryRequired).toBe(false);
    expect(second.retryRequired).toBe(false);
    expect(second.outcomeCounts).toEqual(
      onlyOutcome(MonitoredActivityOutcome.TargetRepositoryOutOfScope, 1)
    );
  });

  it("counts the transport skip and the acknowledged out-of-scope skip as disjoint populations", async () => {
    const { tx } = persistenceTx();
    tx.branchDetail.findMany.mockResolvedValue([]);
    tx.pullRequestDetail.findMany.mockResolvedValue([]);

    const result = await persistMonitoredSessionActivity(tx as never, {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      artifactRefs: [
        // Provider-authoritative absent PR on an in-scope repository.
        { ...pullRequestRef(), monitoredActivityOnly: true as const },
        outOfScopePullRequestRef(),
      ],
      pullRequestLane: {
        details: NO_PR_DETAILS,
        deferrals: AWAITING_REPOSITORY_READ,
      },
      repositoryIdentity: probedAlongside(OUT_OF_SCOPE_REPOSITORY),
    });

    expect(result.retryRequired).toBe(false);
    expect(result.outcomeCounts).toEqual({
      ...emptyMonitoredActivityOutcomeCounts(),
      [MonitoredActivityOutcome.TransportTargetSkipped]: 1,
      [MonitoredActivityOutcome.TargetRepositoryOutOfScope]: 1,
    });
  });

  /**
   * ISS-10628 end to end, and the case ISS-9181's own fix could not reach.
   * That fix acknowledges on `RepositoryOutOfScope`, which fires only when the
   * organization holds NO identity for the repository. Production holds one:
   * a verified `github_observed_repository` row for `prisma/prisma-engines`
   * carrying a real `github_repo_id` and no installation anywhere, confirmed
   * 2026-09-18. Identity was therefore `Held`, the acknowledgement was
   * disqualified, the PR lane claimed the target, and the Session was withheld
   * under `TargetNotMaterialized` — waiting on a delivery that cannot happen.
   *
   * `retryRequired: false` is what puts the already-committed Session into
   * `acceptedSessionIds` (`upsert-sessions-batch.ts`, `persisted &&
   * !retryRequired`) instead of telling the user its data could not be
   * uploaded.
   */
  it("acknowledges a target on a repository the organization can name but not fetch", async () => {
    const { tx } = persistenceTx();
    tx.pullRequestDetail.findMany.mockResolvedValue([]);

    const result = await persistMonitoredSessionActivity(tx as never, {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      artifactRefs: [outOfScopePullRequestRef()],
      pullRequestLane: {
        details: NO_PR_DETAILS,
        deferrals: AWAITING_REPOSITORY_READ,
      },
      repositoryIdentity: observedOnlyAlongside(OUT_OF_SCOPE_REPOSITORY),
    });

    // The whole count map: a hold now lands under its own disposition as well
    // as the shared total (ISS-9182), so a target still being withheld cannot
    // hide behind a `retryRequired` that some other candidate set to false.
    expect(result).toMatchObject({
      retryRequired: false,
      persistedCount: 0,
      // Its OWN member, never `TargetIntentionallyAbsent`: the provider never
      // said this PR is absent, and PLN-2061 M2 discards the desktop's
      // evidence for both causes, so the counter has to tell them apart
      // (ISS-9182 review r4053480710).
      outcomeCounts: onlyOutcome(
        MonitoredActivityOutcome.TargetRepositoryUnfetchable,
        1
      ),
    });
    expect(tx.branchActivityAtom.createMany).not.toHaveBeenCalled();
  });

  /**
   * The counterfactual for the acknowledgement above, on the SAME repository:
   * only the lane's deferral differs. A headless ref is recorded BEFORE the
   * lane consults repository authority, and the delivery that carries the name
   * writes the row from the desktop's own facts — so the lane still owns this
   * target and the hold is the honest answer. Acknowledging it would discard
   * monitored-activity evidence for good, which is the loss the whole
   * partition exists to prevent.
   */
  it("holds a headless target on a repository the organization cannot fetch", async () => {
    const { tx } = persistenceTx();
    tx.pullRequestDetail.findMany.mockResolvedValue([]);

    const result = await persistMonitoredSessionActivity(tx as never, {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      artifactRefs: [outOfScopePullRequestRef(EVENT, null)],
      pullRequestLane: {
        details: NO_PR_DETAILS,
        deferrals: AWAITING_DESKTOP_DELIVERY,
      },
      repositoryIdentity: observedOnlyAlongside(OUT_OF_SCOPE_REPOSITORY),
      // ISS-11427: inside the hold ceiling, measured from `EVENT.occurredAt`.
      // Left to the `new Date()` default this case would measure the ceiling
      // (47 days past the fixture event) rather than the classifier it names.
      receivedAt: WITHIN_HOLD_CEILING,
    });

    // The whole count map: the hold lands under its own disposition AND under
    // the shared retry total, so a target quietly moving to an acknowledged
    // disposition cannot hide behind either one alone.
    expect(result).toMatchObject({
      retryRequired: true,
      persistedCount: 0,
      outcomeCounts: {
        ...emptyMonitoredActivityOutcomeCounts(),
        [MonitoredActivityOutcome.TargetNotMaterialized]: 1,
        [MonitoredActivityOutcome.TargetRetryRequired]: 1,
      },
    });
  });

  it("keeps holding an out-of-scope target whose event is still in the future", async () => {
    const { tx } = persistenceTx();
    tx.pullRequestDetail.findMany.mockResolvedValue([]);

    const result = await persistMonitoredSessionActivity(tx as never, {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: SESSION_ARTIFACT_ID,
      artifactRefs: [
        outOfScopePullRequestRef({
          ...EVENT,
          occurredAt: "2026-08-14T13:00:00.000Z",
        }),
      ],
      pullRequestLane: {
        details: NO_PR_DETAILS,
        deferrals: AWAITING_REPOSITORY_READ,
      },
      repositoryIdentity: probedAlongside(OUT_OF_SCOPE_REPOSITORY),
      receivedAt: WITHIN_HOLD_CEILING,
    });

    // ISS-7131's arm is a separate judgment and this change must not widen to
    // it: a quarantined future event still holds, out of scope or not.
    expect(result).toMatchObject({
      retryRequired: true,
      outcomeCounts: onlyOutcome(
        MonitoredActivityOutcome.FutureRetryRequired,
        1
      ),
    });
  });
});

/**
 * `branchName` defaults to present because that is the lane's ordinary shape
 * and the only one whose deferral waits on a repository read. Pass `null` for
 * the wire contract's headless shape, which the lane records unresolved before
 * it consults authority at all — `null` rather than `undefined` because
 * `undefined` takes the default back.
 *
 * The ref no longer DECIDES which deferral the classifier sees; the lane does,
 * and each case states it. The two are paired here so a case reads as one
 * delivery rather than two unrelated fixtures.
 */
function outOfScopePullRequestRef(
  event: SyncedMonitoredSessionActivityEvent = EVENT,
  branchName: string | null = "feat/head"
): SyncedPullRequestArtifactRef {
  return {
    ...pullRequestRef(event),
    repositoryFullName: OUT_OF_SCOPE_REPOSITORY,
    prNumber: OUT_OF_SCOPE_PR_NUMBER,
    ...(branchName ? { branchName } : {}),
  };
}
