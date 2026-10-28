/**
 * Shared harness for the ISS-11427 hold-ceiling suites
 * (`monitored-activity-hold-ceiling.test.ts` and
 * `monitored-activity-hold-ceiling-settlement.test.ts`).
 */
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import {
  EVENT,
  LONG_STANDING_HOLD_START,
  laneDeferrals,
  NO_PR_DETAILS,
  ORGANIZATION_ID,
  PR_NUMBER,
  persistenceTx,
  pullRequestRef,
  REPOSITORY,
} from "@/__tests__/support/agent-sessions/monitored-session-activity.test-fixtures";
import { RepositoryIdentitySource } from "@/app/agent-sessions/service/artifact-links/authority-source-queries";
import { PullRequestLaneDeferral } from "@/app/agent-sessions/service/artifact-links/pull-request-lane-deferral";
import type { SessionRepositoryIdentityProbe } from "@/app/agent-sessions/service/artifact-links/shared";
import { MONITORED_ACTIVITY_HOLD_CEILING_MS } from "@/app/agent-sessions/service/monitored-activity-hold-ceiling";
import type { MonitoredActivityCandidate } from "@/app/agent-sessions/service/monitored-session-activity-shared";

export const SESSION_ARTIFACT_ID = "019ff900-0000-7000-8000-000000000004";
export const OCCURRED_AT_MS = Date.parse(EVENT.occurredAt);
/** One minute inside the ceiling — the hold still stands. */
export const WITHIN_CEILING = new Date(
  OCCURRED_AT_MS + MONITORED_ACTIVITY_HOLD_CEILING_MS - 60_000
);
/** One minute past it — the server resolves the hold itself. */
export const PAST_CEILING = new Date(
  OCCURRED_AT_MS + MONITORED_ACTIVITY_HOLD_CEILING_MS + 60_000
);

/**
 * The held shape this ticket measured in production: a PR ref the PR lane
 * deferred on a repository the organization holds an observed identity for and
 * no installation, so `classifyTarget` answers `TargetNotMaterialized` and the
 * target never materializes.
 */
export const OBSERVED_ONLY_REPOSITORY: SessionRepositoryIdentityProbe = {
  authorities: new Map([
    [
      REPOSITORY,
      {
        repositoryId: null,
        providerRepositoryId: "provider-repo",
        authorities: [],
        identitySources: new Set([RepositoryIdentitySource.Observed]),
      },
    ],
  ]),
  probedNames: new Set([REPOSITORY]),
};

export const HEADLESS_DEFERRALS = laneDeferrals({
  repositoryFullName: REPOSITORY,
  prNumber: PR_NUMBER,
  deferral: PullRequestLaneDeferral.AwaitingDesktopDelivery,
});

export function unresolvableTx() {
  const harness = persistenceTx();
  harness.tx.branchDetail.findMany.mockResolvedValue([]);
  harness.tx.pullRequestDetail.findMany.mockResolvedValue([]);
  return harness;
}

export function heldDelivery(
  receivedAt: Date,
  monitoredActivityHeldSince: Date | null = LONG_STANDING_HOLD_START
) {
  return {
    organizationId: ORGANIZATION_ID,
    sessionArtifactId: SESSION_ARTIFACT_ID,
    artifactRefs: [pullRequestRef()],
    pullRequestLane: {
      details: NO_PR_DETAILS,
      deferrals: HEADLESS_DEFERRALS,
    },
    repositoryIdentity: OBSERVED_ONLY_REPOSITORY,
    receivedAt,
    monitoredActivityHeldSince,
  };
}

export function candidate(occurredAt: string): MonitoredActivityCandidate {
  return {
    target: {
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName: REPOSITORY,
      prNumber: PR_NUMBER,
    },
    event: { ...EVENT, occurredAt },
    transportOnly: false,
  };
}
