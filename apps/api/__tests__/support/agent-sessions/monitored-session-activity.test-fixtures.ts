import type { MonitoredActivityRetainedSnapshot } from "@repo/api/src/types/artifact-activity";
import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  type SyncedBranchArtifactRef,
  type SyncedPullRequestArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import {
  MonitoredSessionActivityEventKind,
  type SyncedMonitoredSessionActivityEvent,
} from "@repo/api/src/types/session-monitored-activity";
import { type Mock, vi } from "vitest";
import { answerRetainedMonitoredActivityRowsQuery } from "@/__tests__/support/agent-sessions/retained-monitored-activity-rows.test-fixtures";
import { RepositoryIdentitySource } from "@/app/agent-sessions/service/artifact-links/authority-source-queries";
import {
  type SessionPullRequestDetailMap,
  sessionPullRequestDetailKey,
} from "@/app/agent-sessions/service/artifact-links/pull-request-details";
import type {
  PullRequestLaneDeferral,
  SessionPullRequestLaneDeferralMap,
} from "@/app/agent-sessions/service/artifact-links/pull-request-lane-deferral";
import type { SessionRepositoryIdentityProbe } from "@/app/agent-sessions/service/artifact-links/shared";
import { MONITORED_ACTIVITY_HOLD_CEILING_MS } from "@/app/agent-sessions/service/monitored-activity-hold-ceiling";
import {
  emptyMonitoredActivityOutcomeCounts,
  type MonitoredActivityOutcome,
} from "@/app/agent-sessions/service/monitored-session-activity-persistence";

export const ORGANIZATION_ID = "019ff900-0000-7000-8000-000000000001";
export const BRANCH_ARTIFACT_ID = "019ff900-0000-7000-8000-000000000002";
export const PULL_REQUEST_ID = "019ff900-0000-7000-8000-000000000003";
export const REPOSITORY = "closedloop-ai/closedloop-ai";
export const REPOSITORY_ID = "019ff900-0000-7000-8000-000000000006";
export const PR_NUMBER = 6060;

/**
 * The repository WAS read for and no identity came back — the answer that lets
 * the classifier acknowledge, not the silence of a name nobody looked up. The
 * two are distinct on purpose (ISS-9181), so a fixture has to pick one.
 */
export const NO_REPOSITORY_AUTHORITY: SessionRepositoryIdentityProbe = {
  authorities: new Map(),
  probedNames: new Set([REPOSITORY]),
};

/** No read covered the repository at all. */
export const UNPROBED_REPOSITORY: SessionRepositoryIdentityProbe = {
  authorities: new Map(),
  probedNames: new Set(),
};

export const EVENT = {
  kind: MonitoredSessionActivityEventKind.AgentRead,
  sourceEventId: "monitored_session_v1:desktop-source-event",
  occurredAt: "2026-08-12T12:00:00.000Z",
  completeness: BranchActivityEvidenceCompleteness.Complete,
} satisfies SyncedMonitoredSessionActivityEvent;

/**
 * ISS-11427: a delivery clock INSIDE the monitored-activity hold ceiling,
 * derived from {@link EVENT} and the ceiling itself rather than written as a
 * literal.
 *
 * Every suite that drives a HELD candidate needs one, because `receivedAt`
 * defaults to `new Date()` — real wall clock, and by now far past the ceiling for
 * this fixture event, so an un-pinned case measures the expiry arm while its name
 * claims the classifier. Derived so lowering the ceiling cannot leave four
 * hand-written copies silently on the wrong side of it.
 */
export const WITHIN_HOLD_CEILING = new Date(
  Date.parse(EVENT.occurredAt) + MONITORED_ACTIVITY_HOLD_CEILING_MS / 2
);

/**
 * ISS-11427: a `monitoredActivityHeldSince` far enough back that the hold has
 * certainly outlived the ceiling, so a case measures `occurredAt` rather than
 * how long the cloud has been holding.
 */
export const LONG_STANDING_HOLD_START = new Date(
  Date.parse(EVENT.occurredAt) - 24 * 60 * 60 * 1000
);

export function repositoryAuthority(input: {
  repositoryId?: string;
  providerRepositoryId?: string;
  identityConflict?: boolean;
  defaultBranch?: string;
  identitySources?: readonly RepositoryIdentitySource[];
}): SessionRepositoryIdentityProbe {
  return {
    authorities: new Map([
      [
        REPOSITORY,
        {
          repositoryId: input.repositoryId ?? null,
          ...(input.providerRepositoryId
            ? { providerRepositoryId: input.providerRepositoryId }
            : {}),
          ...(input.identityConflict === undefined
            ? {}
            : { identityConflict: input.identityConflict }),
          authorities: input.defaultBranch
            ? [{ evidence: { defaultBranch: input.defaultBranch } } as never]
            : [],
          identitySources: new Set(
            input.identitySources ?? impliedIdentitySources(input)
          ),
        },
      ],
    ]),
    probedNames: new Set([REPOSITORY]),
  };
}

/**
 * The source a fixture's identity would have come from in production, so a
 * case that says nothing about provenance still describes a repository the
 * organization can reach rather than one it merely observed.
 *
 * `repositoryId` pins its source exactly — the installation read is the only
 * one that writes it. A conflict carries none because both reconcilers clear
 * the set when two sources disagree, so a fixture claiming otherwise would be
 * a shape `resolveSessionRepositoryIdentity` cannot produce.
 */
function impliedIdentitySources(input: {
  repositoryId?: string;
  providerRepositoryId?: string;
  identityConflict?: boolean;
}): readonly RepositoryIdentitySource[] {
  if (input.identityConflict) {
    return [];
  }
  if (input.repositoryId) {
    return [RepositoryIdentitySource.Installation];
  }
  return input.providerRepositoryId ? [RepositoryIdentitySource.Public] : [];
}

/** The PR lane's output for the same refs — what attribution now reads. */
export const RESOLVED_PR_DETAILS: SessionPullRequestDetailMap = new Map([
  [
    sessionPullRequestDetailKey(REPOSITORY, PR_NUMBER),
    { prDetailId: PULL_REQUEST_ID, branchArtifactId: BRANCH_ARTIFACT_ID },
  ],
]);
export const NO_PR_DETAILS: SessionPullRequestDetailMap = new Map();

/**
 * The PR lane deferred nothing: every unresolved PR target is one it resolved
 * or never ran over, so the existence read settles it. NOT the same as "the
 * lane did not run" — the classifier cannot tell those apart and must not,
 * which is why the input is required rather than defaulted.
 */
export const NO_PR_LANE_DEFERRALS: SessionPullRequestLaneDeferralMap =
  new Map();

/** The lane's report for one or more targets, keyed the way the lane keys it. */
export function laneDeferrals(
  ...entries: readonly {
    repositoryFullName: string;
    prNumber: number;
    deferral: PullRequestLaneDeferral;
  }[]
): SessionPullRequestLaneDeferralMap {
  return new Map(
    entries.map((entry) => [
      sessionPullRequestDetailKey(entry.repositoryFullName, entry.prNumber),
      entry.deferral,
    ])
  );
}

export const AUTHORITATIVE_REPOSITORY: SessionRepositoryIdentityProbe = {
  authorities: new Map([
    [
      REPOSITORY,
      {
        repositoryId: REPOSITORY_ID,
        providerRepositoryId: "provider-repository-1",
        authorities: [{ evidence: { defaultBranch: "main" } } as never],
        identitySources: new Set([RepositoryIdentitySource.Installation]),
      },
    ],
  ]),
  probedNames: new Set([REPOSITORY]),
};

/** `AUTHORITATIVE_REPOSITORY`, plus a second name read for and not found. */
export function probedAlongside(
  ...otherNames: readonly string[]
): SessionRepositoryIdentityProbe {
  return {
    authorities: AUTHORITATIVE_REPOSITORY.authorities,
    probedNames: new Set([REPOSITORY, ...otherNames]),
  };
}

/**
 * `AUTHORITATIVE_REPOSITORY`, plus a second name whose ONLY identity is a
 * verified observation — ISS-10628's production shape, confirmed on
 * 2026-09-18: one `github_observed_repository` row in state `verified`
 * carrying a real `github_repo_id`, and no installation, public row or PR
 * head anywhere in the organization.
 *
 * Deliberately paired with an installation-backed name in ONE probe: a
 * single-repository fixture cannot tell a per-repository authority predicate
 * from a global one, so it would pass under the exact mutation the predicate
 * exists to catch (PLN-2061 M1).
 */
export function observedOnlyAlongside(
  observedFullName: string
): SessionRepositoryIdentityProbe {
  return {
    authorities: new Map([
      ...AUTHORITATIVE_REPOSITORY.authorities,
      [
        observedFullName,
        {
          repositoryId: null,
          providerRepositoryId: OBSERVED_ONLY_PROVIDER_REPOSITORY_ID,
          authorities: [],
          identitySources: new Set([RepositoryIdentitySource.Observed]),
        },
      ],
    ]),
    probedNames: new Set([REPOSITORY, observedFullName]),
  };
}

/** The provider id a verified observation supplies, and the whole of what it supplies. */
export const OBSERVED_ONLY_PROVIDER_REPOSITORY_ID = "204033634";

export const SESSION_ARTIFACT_ID = "019ff900-0000-7000-8000-000000000004";

/** Exactly one outcome non-zero, so a double-counted population fails here. */
export function onlyOutcome(
  outcome: MonitoredActivityOutcome,
  count: number
): Record<MonitoredActivityOutcome, number> {
  return { ...emptyMonitoredActivityOutcomeCounts(), [outcome]: count };
}

export function pullRequestRef(
  event: SyncedMonitoredSessionActivityEvent = EVENT,
  carrierCompleteness:
    | typeof BranchActivityEvidenceCompleteness.Complete
    | typeof BranchActivityEvidenceCompleteness.Partial = BranchActivityEvidenceCompleteness.Complete
): SyncedPullRequestArtifactRef {
  return {
    kind: ArtifactRefTargetKind.PullRequest,
    repositoryFullName: REPOSITORY,
    prNumber: PR_NUMBER,
    method: ArtifactRefMethod.McpToolCall,
    relation: ArtifactRefRelation.Reviewed,
    monitoredSessionActivity: {
      completeness: carrierCompleteness,
      events: [event],
    },
  };
}

export function branchRef(
  branchName: string,
  event: SyncedMonitoredSessionActivityEvent
): SyncedBranchArtifactRef {
  return {
    kind: ArtifactRefTargetKind.Branch,
    repositoryFullName: REPOSITORY,
    branchName,
    method: ArtifactRefMethod.McpToolCall,
    relation: ArtifactRefRelation.Reviewed,
    monitoredSessionActivity: {
      completeness: BranchActivityEvidenceCompleteness.Complete,
      events: [event],
    },
  };
}

/**
 * One persisted `ArtifactActivityEvent` row as the double records it. The
 * primary key is the idempotence key ISS-9182 relies on, so the double refuses
 * a duplicate `id` exactly as `ON CONFLICT DO NOTHING` does.
 */
export type StoredActivityEventRow = {
  id: string;
  organizationId: string;
  artifactId: string;
  actorType: string;
  actorId: string | null;
  action: string;
  /** Narrower than the column: retention is this tx's only event writer. */
  after: MonitoredActivityRetainedSnapshot;
  createdAt: Date;
};

/** One persisted `BranchActivityAtom` row as the double records it. */
type StoredActivityAtomRow = {
  version: number;
  organizationId: string;
  branchArtifactId: string;
  source: string;
  sourceEventId: string;
  compatibilityAliasForSourceEventId?: string | null;
  occurredAt: Date;
  attributionKind: string;
  pullRequestDetailId: string | null;
  completeness: string;
};

/**
 * Explicit because this harness is exported: the inferred type names
 * `@vitest/spy`'s internal `Procedure`, which is not portable across a module
 * boundary (TS2883).
 */
export type MonitoredActivityPersistenceHarness = {
  tx: {
    branchDetail: { findMany: Mock; findUnique: Mock; updateMany: Mock };
    pullRequestDetail: { findMany: Mock; findUnique: Mock };
    branchActivityAtom: {
      createManyAndReturn: Mock;
      createMany: Mock;
      findMany: Mock;
      findUnique: Mock;
    };
    monitoredSessionActivityQuarantine: {
      createMany: Mock;
      findMany: Mock;
    };
    artifactActivityEvent: {
      createMany: Mock;
      findMany: Mock;
      deleteMany: Mock;
    };
    $queryRaw: Mock;
    $executeRaw: Mock;
  };
  stored: () => StoredActivityAtomRow | undefined;
  allStored: () => StoredActivityAtomRow[];
  allRows: () => StoredActivityAtomRow[];
  /** The ISS-9182 retention rows this tx holds, in write order. */
  retained: () => StoredActivityEventRow[];
};

/**
 * The monitored-activity persistence transaction double, shared by
 * `monitored-session-activity.test.ts` (the writer's happy paths) and
 * `monitored-session-activity-quarantine.test.ts` (the quarantine error arms).
 * Moved here verbatim by ISS-8131 when the second consumer appeared — one
 * harness, so the two suites cannot drift on what the tx does.
 *
 * A case that needs a persisted row the production writers cannot emit (a
 * corrupt quarantine anchor) overrides `monitoredSessionActivityQuarantine`'s
 * `findMany` per case rather than reaching into the closed-over arrays.
 *
 * Identity checks go through Sets, not `Array#some`: the chunking cases
 * (ISS-9860) push tens of thousands of rows through this double, and a
 * quadratic dedupe turned each of them into a multi-second stall.
 */
export function persistenceTx(): MonitoredActivityPersistenceHarness {
  const stored: StoredActivityAtomRow[] = [];
  const storedIdentities = new Set<string>();
  const activityEvents: StoredActivityEventRow[] = [];
  const activityEventIds = new Set<string>();
  const quarantined: Array<{
    organizationId: string;
    sessionArtifactId: string;
    eventIdentityHash: string;
    eventFingerprint: string;
    occurredAt: Date;
    receivedAt: Date;
  }> = [];
  const quarantinedIdentities = new Set<string>();
  const tx = {
    branchDetail: {
      findMany: vi.fn().mockImplementation(({ where }) => {
        if ("artifactId" in where) {
          return where.artifactId.in.map((artifactId: string) => ({
            artifactId,
          }));
        }
        return where.OR.map(
          (target: { repositoryFullName: string; branchName: string }) => ({
            artifactId: `artifact:${target.branchName}`,
            repositoryFullName: target.repositoryFullName,
            branchName: target.branchName,
          })
        );
      }),
      findUnique: vi.fn().mockResolvedValue({ artifactId: BRANCH_ARTIFACT_ID }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    pullRequestDetail: {
      // Attribution for a ref the PR lane handled is threaded, never re-derived
      // (ISS-6450), so the only read left on this path is the atom batch's
      // id-keyed one. Residual-target tests override this per case.
      findMany: vi
        .fn()
        .mockImplementation(({ where }) =>
          "id" in where
            ? [{ id: PULL_REQUEST_ID, branchArtifactId: BRANCH_ARTIFACT_ID }]
            : []
        ),
      findUnique: vi.fn().mockResolvedValue({
        id: PULL_REQUEST_ID,
        branchArtifactId: BRANCH_ARTIFACT_ID,
        organizationId: ORGANIZATION_ID,
      }),
    },
    branchActivityAtom: {
      createManyAndReturn: vi
        .fn()
        .mockImplementation(({ data }: { data: typeof stored }) => {
          const inserted: Array<{
            branchArtifactId: string;
            source: string;
            sourceEventId: string;
          }> = [];
          for (const row of data) {
            const identity = storedAtomIdentity(row);
            if (storedIdentities.has(identity)) {
              continue;
            }
            storedIdentities.add(identity);
            stored.push(row);
            inserted.push({
              branchArtifactId: row.branchArtifactId,
              source: row.source,
              sourceEventId: row.sourceEventId,
            });
          }
          return inserted;
        }),
      createMany: vi
        .fn()
        .mockImplementation(({ data }: { data: typeof stored }) => {
          let count = 0;
          for (const row of data) {
            const identity = storedAtomIdentity(row);
            if (storedIdentities.has(identity)) {
              continue;
            }
            storedIdentities.add(identity);
            stored.push(row);
            count += 1;
          }
          return { count };
        }),
      findMany: vi.fn().mockImplementation(() => stored),
      findUnique: vi.fn().mockImplementation(() => stored[0]),
    },
    monitoredSessionActivityQuarantine: {
      createMany: vi.fn().mockImplementation(({ data }) => {
        let count = 0;
        for (const row of data) {
          const identity = quarantineRowIdentity(row);
          if (quarantinedIdentities.has(identity)) {
            continue;
          }
          quarantinedIdentities.add(identity);
          quarantined.push(row);
          count += 1;
        }
        return { count };
      }),
      findMany: vi.fn().mockImplementation(({ where }) => {
        const wanted = new Set<string>(where.eventIdentityHash.in);
        return quarantined.filter(
          (row) =>
            row.organizationId === where.organizationId &&
            row.sessionArtifactId === where.sessionArtifactId &&
            wanted.has(row.eventIdentityHash)
        );
      }),
    },
    artifactActivityEvent: {
      createMany: vi
        .fn()
        .mockImplementation(({ data }: { data: StoredActivityEventRow[] }) => {
          let count = 0;
          for (const row of data) {
            if (activityEventIds.has(row.id)) {
              continue;
            }
            activityEventIds.add(row.id);
            activityEvents.push(row);
            count += 1;
          }
          return { count };
        }),
      // Two readers with different `where` shapes: the retention write's
      // id-keyed verification, and the retraction's action-keyed scan of one
      // session artifact. Each predicate is applied only when its key is
      // present, so neither silently answers the other's question.
      findMany: vi.fn().mockImplementation(({ where }) => {
        const wanted =
          where.id === undefined ? undefined : new Set<string>(where.id.in);
        return activityEvents.filter(
          (row) =>
            row.organizationId === where.organizationId &&
            row.artifactId === where.artifactId &&
            (wanted === undefined || wanted.has(row.id)) &&
            (where.action === undefined || row.action === where.action)
        );
      }),
      deleteMany: vi.fn().mockImplementation(({ where }) => {
        const wanted = new Set<string>(where.id.in);
        const removed = activityEvents.filter(
          (row) =>
            row.organizationId === where.organizationId &&
            row.artifactId === where.artifactId &&
            wanted.has(row.id)
        );
        for (const row of removed) {
          activityEvents.splice(activityEvents.indexOf(row), 1);
          activityEventIds.delete(row.id);
        }
        return { count: removed.length };
      }),
    },
    // The retained-row read is answered from this tx's own rows; every other
    // statement keeps the canned resolution answer.
    $queryRaw: vi
      .fn()
      .mockImplementation((query: unknown) =>
        Promise.resolve(
          answerRetainedMonitoredActivityRowsQuery(query, activityEvents) ?? [
            { id: PULL_REQUEST_ID, branchArtifactId: BRANCH_ARTIFACT_ID },
          ]
        )
      ),
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
  return {
    tx,
    stored: () =>
      stored.find((row) => row.compatibilityAliasForSourceEventId == null),
    allStored: () =>
      stored.filter((row) => row.compatibilityAliasForSourceEventId == null),
    allRows: () => stored,
    retained: () => activityEvents,
  };
}

/** The `(branch, source, sourceEventId)` identity a stored atom row is keyed by in these doubles. */
export function storedAtomIdentity(row: {
  branchArtifactId: string;
  source: string;
  sourceEventId: string;
}): string {
  return `${row.branchArtifactId}\u0000${row.source}\u0000${row.sourceEventId}`;
}

function quarantineRowIdentity(row: {
  organizationId: string;
  sessionArtifactId: string;
  eventIdentityHash: string;
}): string {
  return `${row.organizationId}\u0000${row.sessionArtifactId}\u0000${row.eventIdentityHash}`;
}
