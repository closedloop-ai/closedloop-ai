import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  BranchLifecycleBoundaryKind,
  BranchParticipationKind,
} from "@repo/api/src/types/branch";
import {
  BRANCH_PUSH_METHOD_VALUES,
  SessionArtifactLinkKind,
} from "@repo/api/src/types/session-artifact-link";
import { vi } from "vitest";
import { type MockDb, now } from "./branch-read-service.test-helpers";

/**
 * A session→branch link row as `getSessionUsageByBranch` selects it. Carries the
 * same flat 10/20/30/40 token counts as this file's other session fixtures.
 */
export function makeSessionLink(
  targetId: string,
  sessionId: string,
  cost: string,
  // FEA-3457: the session's owner id — its assignee since ISS-12251, read off
  // the source artifact — null when unassigned. Owner resolution tallies
  // distinct sessions per owner.
  userId: string | null = null,
  metadata: Record<string, unknown> | null = null,
  branchParticipation: string | null = null,
  timing: { sessionStartedAt?: Date; sessionEndedAt?: Date | null } = {},
  // ISS-5445: the session's stored `billing_mode`, which drives the
  // subscription-vs-API ledger split in `getBranchUsage`. Defaults to null — no
  // captured mode ⇒ unknown ledger ⇒ counted in the total and in NEITHER
  // sub-bucket, preserving what every pre-existing caller already assumed.
  billingMode: string | null = null
) {
  return {
    targetId,
    sourceId: sessionId,
    branchParticipation,
    branchParticipationMethod: null,
    branchParticipationObservedAt: null,
    metadata,
    source: {
      name: `Session ${sessionId}`,
      slug: `session-${sessionId}`,
      assigneeId: userId,
      session: {
        artifactId: sessionId,
        externalSessionId: sessionId,
        harness: "codex",
        sessionStartedAt: timing.sessionStartedAt ?? now,
        sessionEndedAt:
          "sessionEndedAt" in timing ? timing.sessionEndedAt : null,
        estimatedCost: { toString: () => cost },
        inputTokens: 10n,
        outputTokens: 20n,
        cacheReadTokens: 30n,
        cacheWriteTokens: 40n,
        turns: 1,
        toolUseCount: 0,
        billingMode,
      },
    },
  };
}

export function makeSuccessfulReviewSessionLink(targetId: string) {
  return makeSessionLink(
    targetId,
    "review-session",
    "1.00",
    "reviewer-user",
    {
      linkKind: SessionArtifactLinkKind.SessionBranch,
      branchParticipation: BranchParticipationKind.Reviewed,
      branchLifecycleEvents: [
        {
          kind: BranchLifecycleBoundaryKind.ReviewFeedback,
          observedAt: new Date(50).toISOString(),
          evidenceId: "review-success",
        },
      ],
    },
    BranchParticipationKind.Reviewed
  );
}

/**
 * A Session→Branch link whose participation QUALIFIES as a push, so the owner
 * projection resolves an identity from it. Shared by the list-owner and
 * detail-owner suites (ISS-11738 split them).
 */
export function makePushSessionLink(
  targetId: string,
  sessionId: string,
  userId: string,
  observedAt: Date
) {
  return {
    ...makeSessionLink(targetId, sessionId, "1.00", userId),
    branchParticipationMethod: BRANCH_PUSH_METHOD_VALUES[0],
    branchParticipationObservedAt: observedAt,
  };
}

type SessionCreatorReadArgs = {
  select?: { createdById?: boolean };
  where?: { type?: string; id?: { in?: readonly string[] } };
};

type SeededSessionLink = {
  sourceId: string;
  source: { assigneeId: string | null };
};

/**
 * ISS-12251: a view of `mockDb` whose `artifact.findMany` answers the Branch
 * Owner's push-creator read (`readPushSessionCreators`) from the session links
 * seeded on `artifactLink.findMany`, at call time. These fixtures model one
 * person per session, so a link's `userId` is its session's creator as well as
 * its assignee. Every other read reaches `mockDb` itself, so seeding and call
 * assertions on `mockDb` are unchanged. Hand the view to `withDb`.
 */
export function withSeededPushSessionCreators(mockDb: MockDb): MockDb {
  return {
    ...mockDb,
    artifact: {
      ...mockDb.artifact,
      findMany: vi.fn(async (args: SessionCreatorReadArgs) => {
        if (
          !(
            args?.select?.createdById &&
            args.where?.type === ArtifactType.Session
          )
        ) {
          return mockDb.artifact.findMany(args);
        }
        const ids = new Set(args.where?.id?.in ?? []);
        const links: SeededSessionLink[] =
          (await mockDb.artifactLink.findMany.getMockImplementation()?.()) ??
          [];
        return links
          .filter((link) => ids.has(link.sourceId))
          .map((link) => ({
            id: link.sourceId,
            createdById: link.source.assigneeId,
          }));
      }),
    },
  };
}
