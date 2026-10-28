/**
 * The sticky ceiling (#8737): a target an earlier delivery's ceiling settled
 * stays acknowledged on re-offer, and only an OWN-AGE expiry settles it
 * (operator ruling 2026-10-12: "Give B its own hold").
 */

import { ArtifactActivityAction } from "@repo/api/src/types/artifact-activity";
import {
  MonitoredHoldExpiryCause,
  MonitoredTargetDisposition,
} from "@repo/api/src/types/monitored-activity-target";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it } from "vitest";
import {
  candidate,
  heldDelivery,
  PAST_CEILING,
  SESSION_ARTIFACT_ID,
  unresolvableTx,
} from "@/__tests__/support/agent-sessions/monitored-activity-hold-ceiling.test-fixtures";
import {
  EVENT,
  LONG_STANDING_HOLD_START,
  laneDeferrals,
  NO_PR_DETAILS,
  ORGANIZATION_ID,
  PR_NUMBER,
  pullRequestRef,
  REPOSITORY,
} from "@/__tests__/support/agent-sessions/monitored-session-activity.test-fixtures";
import { PullRequestLaneDeferral } from "./artifact-links/pull-request-lane-deferral";
import { MONITORED_ACTIVITY_HOLD_CEILING_MS } from "./monitored-activity-hold-ceiling";
import { persistMonitoredSessionActivity } from "./monitored-session-activity";
import { MonitoredActivityOutcome } from "./monitored-session-activity-persistence";
import {
  retainedMonitoredActivityEventId,
  retainedMonitoredActivitySnapshot,
} from "./monitored-session-activity-retention";
import type { MonitoredActivityCandidate } from "./monitored-session-activity-shared";
import { effectiveMonitoredTargetDisposition } from "./monitored-session-transport-resolution";

describe("a target an earlier delivery's ceiling already settled", () => {
  // Monitor 315255487 (2026-10-12): the desktop re-sends the carrier snapshot,
  // so the expired candidate came back on the next delivery, re-opened a fresh
  // thirty minutes, and a live session was acknowledged once per half hour.
  const FIVE_MINUTES_LATER = new Date(PAST_CEILING.getTime() + 5 * 60_000);
  const freshEvent = (sourceEventId: string) => ({
    ...EVENT,
    sourceEventId,
    occurredAt: new Date(FIVE_MINUTES_LATER.getTime() - 10_000).toISOString(),
  });

  async function expireStuckTarget() {
    const harness = unresolvableTx();
    const expiring = await persistMonitoredSessionActivity(
      harness.tx as never,
      heldDelivery(PAST_CEILING)
    );
    return { ...harness, expiring };
  }

  it("acknowledges the re-offered target, new mentions included, without re-reporting it", async () => {
    const { tx, retained, expiring } = await expireStuckTarget();
    expect(
      expiring.outcomeCounts[MonitoredActivityOutcome.TargetHoldExpired]
    ).toBe(1);

    const reOffered = await persistMonitoredSessionActivity(tx as never, {
      // The expiring delivery released the hold, so the next one arrives
      // unheld: without the earlier retention it would open a fresh hold.
      ...heldDelivery(FIVE_MINUTES_LATER, null),
      artifactRefs: [
        pullRequestRef(),
        pullRequestRef(freshEvent("monitored_session_v1:new-mention")),
      ],
    });

    expect(reOffered.retryRequired).toBe(false);
    expect(reOffered.holdRetained).toBe(false);
    expect(
      reOffered.outcomeCounts[MonitoredActivityOutcome.TargetHoldExpired]
    ).toBe(0);
    expect(
      reOffered.outcomeCounts[MonitoredActivityOutcome.TargetHoldSettled]
    ).toBe(2);
    expect(retained()).toHaveLength(2);
  });

  it("settles a new mention on the target even when the expired one is not re-sent", async () => {
    const { tx, expiring } = await expireStuckTarget();
    expect(
      expiring.outcomeCounts[MonitoredActivityOutcome.TargetHoldExpired]
    ).toBe(1);

    const newMentionOnly = await persistMonitoredSessionActivity(tx as never, {
      ...heldDelivery(FIVE_MINUTES_LATER, null),
      artifactRefs: [
        pullRequestRef(freshEvent("monitored_session_v1:only-new")),
      ],
    });

    expect(newMentionOnly.retryRequired).toBe(false);
  });

  it("still holds a target an earlier delivery retained for a terminal reason", async () => {
    // A row retained as out of scope says nothing about a later delivery in
    // which the same target is retry-owned again, e.g. after the App install.
    const { tx } = unresolvableTx();
    const candidate: MonitoredActivityCandidate = {
      target: {
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: REPOSITORY,
        prNumber: PR_NUMBER,
      },
      event: EVENT,
      transportOnly: false,
    };
    await tx.artifactActivityEvent.createMany({
      data: [
        {
          id: retainedMonitoredActivityEventId(SESSION_ARTIFACT_ID, candidate),
          organizationId: ORGANIZATION_ID,
          artifactId: SESSION_ARTIFACT_ID,
          action: ArtifactActivityAction.MonitoredActivityRetained,
          after: retainedMonitoredActivitySnapshot(
            candidate,
            MonitoredTargetDisposition.RepositoryOutOfScope
          ),
        },
      ],
    } as never);

    const delivery = await persistMonitoredSessionActivity(
      tx as never,
      heldDelivery(FIVE_MINUTES_LATER, null)
    );

    expect(delivery.retryRequired).toBe(true);
    expect(delivery.holdRetained).toBe(true);
  });

  it("supersedes a terminal row when the same mention later expires, so the re-send is settled", async () => {
    // #8737 review (tamsinb): the retained row id ignores the disposition, so
    // the HoldExpired insert hit `skipDuplicates` and the row kept saying
    // RepositoryOutOfScope; the next re-send then opened a fresh hold.
    const { tx, retained } = unresolvableTx();
    const candidate: MonitoredActivityCandidate = {
      target: {
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: REPOSITORY,
        prNumber: PR_NUMBER,
      },
      event: EVENT,
      transportOnly: false,
    };
    await tx.artifactActivityEvent.createMany({
      data: [
        {
          id: retainedMonitoredActivityEventId(SESSION_ARTIFACT_ID, candidate),
          organizationId: ORGANIZATION_ID,
          artifactId: SESSION_ARTIFACT_ID,
          action: ArtifactActivityAction.MonitoredActivityRetained,
          after: retainedMonitoredActivitySnapshot(
            candidate,
            MonitoredTargetDisposition.RepositoryOutOfScope
          ),
        },
      ],
    } as never);

    await persistMonitoredSessionActivity(
      tx as never,
      heldDelivery(PAST_CEILING)
    );
    const reOffered = await persistMonitoredSessionActivity(
      tx as never,
      heldDelivery(FIVE_MINUTES_LATER, null)
    );

    expect(retained()).toHaveLength(1);
    expect(retained()[0]?.after).toMatchObject({
      disposition: MonitoredTargetDisposition.HoldExpired,
    });
    expect(reOffered.retryRequired).toBe(false);
  });

  it("keeps a different target's hold on the same session", async () => {
    const { tx, retained, expiring } = await expireStuckTarget();
    expect(
      expiring.outcomeCounts[MonitoredActivityOutcome.TargetHoldExpired]
    ).toBe(1);
    const otherPrNumber = PR_NUMBER + 1;

    const reOffered = await persistMonitoredSessionActivity(tx as never, {
      ...heldDelivery(FIVE_MINUTES_LATER, null),
      artifactRefs: [
        pullRequestRef(),
        {
          ...pullRequestRef(freshEvent("monitored_session_v1:other-target")),
          prNumber: otherPrNumber,
        },
      ],
      pullRequestLane: {
        details: NO_PR_DETAILS,
        deferrals: laneDeferrals(
          {
            repositoryFullName: REPOSITORY,
            prNumber: PR_NUMBER,
            deferral: PullRequestLaneDeferral.AwaitingDesktopDelivery,
          },
          {
            repositoryFullName: REPOSITORY,
            prNumber: otherPrNumber,
            deferral: PullRequestLaneDeferral.AwaitingDesktopDelivery,
          }
        ),
      },
    });

    expect(reOffered.retryRequired).toBe(true);
    expect(reOffered.holdRetained).toBe(true);
    expect(retained()).toHaveLength(1);
  });
});

it("leaves an already-acknowledged disposition alone", () => {
  // There is no hold to expire, and rewriting it would lose the reason the
  // retained row carries.
  expect(
    effectiveMonitoredTargetDisposition({
      disposition: MonitoredTargetDisposition.RepositoryOutOfScope,
      holdExpired: true,
    })
  ).toBe(MonitoredTargetDisposition.RepositoryOutOfScope);
});

it("expires an UNCLASSIFIED target too", () => {
  // `undefined` is retry-owned, and it is the one hold with no disposition to
  // name — leaving it out would leave it unbounded.
  expect(
    effectiveMonitoredTargetDisposition({
      disposition: undefined,
      holdExpired: true,
    })
  ).toBe(MonitoredTargetDisposition.HoldExpired);
});

describe("own-age versus escalation-swept expiry (#8737, operator ruling 2026-10-12)", () => {
  const SIBLING_PR_NUMBER = PR_NUMBER + 1;
  const NEXT_DELIVERY = new Date(PAST_CEILING.getTime() + 5 * 60_000);
  const freshOccurredAt = new Date(
    PAST_CEILING.getTime() - 60_000
  ).toISOString();

  function siblingRef(
    sourceEventId = "monitored_session_v1:sibling",
    occurredAt = freshOccurredAt
  ) {
    return {
      ...pullRequestRef({ ...EVENT, sourceEventId, occurredAt }),
      prNumber: SIBLING_PR_NUMBER,
    };
  }

  function prNumberOf(row: { after: { kind: string } }) {
    return "prNumber" in row.after ? row.after.prNumber : undefined;
  }

  function twoTargetDelivery(receivedAt: Date, heldSince: Date | null) {
    return {
      ...heldDelivery(receivedAt, heldSince),
      artifactRefs: [pullRequestRef(), siblingRef()],
      pullRequestLane: {
        details: NO_PR_DETAILS,
        deferrals: laneDeferrals(
          {
            repositoryFullName: REPOSITORY,
            prNumber: PR_NUMBER,
            deferral: PullRequestLaneDeferral.AwaitingDesktopDelivery,
          },
          {
            repositoryFullName: REPOSITORY,
            prNumber: SIBLING_PR_NUMBER,
            deferral: PullRequestLaneDeferral.AwaitingDesktopDelivery,
          }
        ),
      },
    };
  }

  function seedRetainedRow(
    tx: ReturnType<typeof unresolvableTx>["tx"],
    occurredAt: string,
    holdExpiryCause?: MonitoredHoldExpiryCause
  ) {
    const retainedCandidate = candidate(occurredAt);
    return tx.artifactActivityEvent.createMany({
      data: [
        {
          id: retainedMonitoredActivityEventId(
            SESSION_ARTIFACT_ID,
            retainedCandidate
          ),
          organizationId: ORGANIZATION_ID,
          artifactId: SESSION_ARTIFACT_ID,
          action: ArtifactActivityAction.MonitoredActivityRetained,
          after: retainedMonitoredActivitySnapshot(
            retainedCandidate,
            MonitoredTargetDisposition.HoldExpired,
            holdExpiryCause
          ),
        },
      ],
    } as never);
  }

  it("gives a swept-in sibling a fresh hold on the next delivery", async () => {
    const { tx, retained } = unresolvableTx();
    const expiring = await persistMonitoredSessionActivity(
      tx as never,
      twoTargetDelivery(PAST_CEILING, LONG_STANDING_HOLD_START)
    );
    expect(expiring.retryRequired).toBe(false);
    expect(
      retained().map((row) => [prNumberOf(row), row.after.holdExpiryCause])
    ).toEqual(
      expect.arrayContaining([
        [PR_NUMBER, MonitoredHoldExpiryCause.OwnAge],
        [SIBLING_PR_NUMBER, MonitoredHoldExpiryCause.Escalation],
      ])
    );

    const next = await persistMonitoredSessionActivity(
      tx as never,
      twoTargetDelivery(NEXT_DELIVERY, null)
    );

    expect(next.retryRequired).toBe(true);
    expect(next.holdRetained).toBe(true);
  });

  it("still settles an own-age expiry on the next delivery", async () => {
    const { tx } = unresolvableTx();
    await persistMonitoredSessionActivity(
      tx as never,
      heldDelivery(PAST_CEILING)
    );

    const next = await persistMonitoredSessionActivity(
      tx as never,
      heldDelivery(NEXT_DELIVERY, null)
    );

    expect(next.retryRequired).toBe(false);
  });

  it("settles a target whose legacy row carries no expiry cause", async () => {
    const { tx } = unresolvableTx();
    await seedRetainedRow(tx, EVENT.occurredAt);

    const next = await persistMonitoredSessionActivity(
      tx as never,
      heldDelivery(NEXT_DELIVERY, null)
    );

    expect(next.retryRequired).toBe(false);
  });

  it("does not settle a target whose only row records an escalation sweep", async () => {
    const { tx } = unresolvableTx();
    await seedRetainedRow(
      tx,
      EVENT.occurredAt,
      MonitoredHoldExpiryCause.Escalation
    );

    const next = await persistMonitoredSessionActivity(
      tx as never,
      heldDelivery(NEXT_DELIVERY, null)
    );

    expect(next.retryRequired).toBe(true);
  });

  it("settles the swept sibling once its own hold expires, superseding the sweep row", async () => {
    const { tx, retained } = unresolvableTx();
    await persistMonitoredSessionActivity(
      tx as never,
      twoTargetDelivery(PAST_CEILING, LONG_STANDING_HOLD_START)
    );
    const ownHoldExpires = new Date(
      NEXT_DELIVERY.getTime() + MONITORED_ACTIVITY_HOLD_CEILING_MS + 60_000
    );
    await persistMonitoredSessionActivity(
      tx as never,
      twoTargetDelivery(ownHoldExpires, NEXT_DELIVERY)
    );

    const after = await persistMonitoredSessionActivity(
      tx as never,
      twoTargetDelivery(new Date(ownHoldExpires.getTime() + 60_000), null)
    );

    expect(after.retryRequired).toBe(false);
    expect(
      retained().find((row) => prNumberOf(row) === SIBLING_PR_NUMBER)?.after
        .holdExpiryCause
    ).toBe(MonitoredHoldExpiryCause.OwnAge);
  });

  it("ends the hold on a forward-skewed sibling once the stuck target is settled", async () => {
    const { tx, retained } = unresolvableTx();
    await seedRetainedRow(tx, EVENT.occurredAt);
    const skewed = siblingRef(
      "monitored_session_v1:skewed",
      new Date(PAST_CEILING.getTime() + 2 * 60 * 60_000).toISOString()
    );

    const delivery = await persistMonitoredSessionActivity(tx as never, {
      ...twoTargetDelivery(PAST_CEILING, LONG_STANDING_HOLD_START),
      artifactRefs: [pullRequestRef(), skewed],
    });

    expect(delivery.retryRequired).toBe(false);
    expect(
      retained().find((row) => prNumberOf(row) === SIBLING_PR_NUMBER)?.after
        .holdExpiryCause
    ).toBe(MonitoredHoldExpiryCause.Escalation);
  });
});
