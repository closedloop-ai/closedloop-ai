/**
 * PLN-1389 Phase 0 (PRD-522 R6) — CLOUD side of the cross-surface branch-parity
 * test. Seeds the shared scenario (@repo/lib/branches/cross-surface-parity-fixture)
 * into Postgres via the production ingestion path and asserts the cloud branch
 * read (branchReadService) produces the shared surface-invariant expectation. The
 * desktop-local counterpart (apps/desktop/test/cross-surface-parity.test.ts)
 * asserts the SAME expectation against SQLite; both passing proves cloud == local
 * == expected without needing a single cross-store process.
 */
import { randomUUID } from "node:crypto";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type DesktopAgentSessionsPayload,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { BranchPushSource, LinkType } from "@repo/api/src/types/artifact";
import {
  type BranchSession,
  normalizeRepoFullName,
} from "@repo/api/src/types/branch";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import {
  CROSS_SURFACE_ACTIVITY,
  CROSS_SURFACE_BOUNDED_END,
  CROSS_SURFACE_BOUNDED_START,
  CROSS_SURFACE_BRANCH_NAME,
  CROSS_SURFACE_MULTI_BRANCH_SESSION_ID,
  CROSS_SURFACE_REPO_FULL_NAME,
  CROSS_SURFACE_SECOND_BRANCH_NAME,
  CROSS_SURFACE_SESSIONS,
  CROSS_SURFACE_USER_A,
  computeExpectedActivityRollup,
  computeExpectedBoundedCostCompleteness,
  computeExpectedBranchRollup,
  computeExpectedCostCompleteness,
  computeExpectedMergedTrace,
  type ParityPerSessionUsage,
  parityCostEvidenceForEvent,
  paritySessionUsageSortKey,
} from "@repo/lib/branches/__tests__/cross-surface-parity-fixture";
import { rollupBranchActivity } from "@repo/lib/branches/activity-rollup";
import { describe, expect, it } from "vitest";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { branchReadService } from "@/app/branches/branch-read-service";
import { branchService } from "@/app/branches/branch-service";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

async function createComputeTarget(
  organizationId: string,
  userId: string,
  label: string
): Promise<string> {
  const target = await withDb((db) =>
    db.computeTarget.create({
      data: {
        organizationId,
        userId,
        machineName: `cross-surface-${label}`,
        platform: "darwin",
      },
      select: { id: true },
    })
  );
  return target.id;
}

async function seedRepo(organizationId: string): Promise<string> {
  const installation = await withDb((db) =>
    db.gitHubInstallation.create({
      data: {
        organizationId,
        installationId: randomUUID(),
        accountId: "acct-parity",
        accountLogin: "acme",
        accountType: "Organization",
        status: GitHubInstallationStatus.ACTIVE,
        senderLogin: "sender",
        senderId: "sender-parity",
        repositories: {
          create: {
            ...persistedGitHubRepositoryAuthority({
              githubRepoId: "repo-parity",
              fullName: CROSS_SURFACE_REPO_FULL_NAME,
            }),
            name: "parity",
            owner: "acme",
            private: false,
          },
        },
      },
      include: { repositories: true },
    })
  );
  const repo = installation.repositories[0];
  if (!repo) {
    throw new Error("cross-surface: failed to seed repository");
  }
  return repo.id;
}

async function seedBranch(
  organizationId: string,
  repositoryId: string,
  projectId: string,
  branchName: string = CROSS_SURFACE_BRANCH_NAME
): Promise<string> {
  const result = await branchService.upsertBranchArtifact({
    organizationId,
    repositoryId,
    repositoryFullName: CROSS_SURFACE_REPO_FULL_NAME,
    branchName,
    projectId,
  });
  if (!result.ok) {
    throw new Error("cross-surface: failed to seed branch");
  }
  const branch = await withDb((db) =>
    db.branchDetail.findFirstOrThrow({
      where: {
        organizationId,
        repositoryFullName: normalizeRepoFullName(CROSS_SURFACE_REPO_FULL_NAME),
        branchName,
      },
      select: { artifactId: true },
    })
  );
  // Set-once push evidence so the branch is org-list-visible (the read requires
  // firstPushedAt OR a current PR), matching two-org-fixture.
  await withDb((db) =>
    db.branchDetail.update({
      where: { artifactId: branch.artifactId },
      data: {
        firstPushedAt: new Date(CROSS_SURFACE_SESSIONS[0].startedAt),
        pushSource: BranchPushSource.Session,
      },
    })
  );
  return branch.artifactId;
}

/** Ingest one scenario session under its user's compute target; return its id. */
async function seedSession(
  context: { organizationId: string; userId: string; computeTargetId: string },
  spec: (typeof CROSS_SURFACE_SESSIONS)[number]
): Promise<string> {
  // FEA-2276: ingest this session's activity tiling + per-turn spend so the cloud
  // read attributes segment spend. Sessions absent from CROSS_SURFACE_ACTIVITY
  // (gamma) upsync none — exercising the no-tiling -> unattributed path.
  const activity = CROSS_SURFACE_ACTIVITY[spec.externalSessionId];
  const session: SyncedAgentSession = {
    externalSessionId: spec.externalSessionId,
    status: "completed",
    harness: spec.harness,
    model: spec.model,
    cwd: "/tmp/cross-surface-parity",
    startedAt: spec.startedAt,
    updatedAt: spec.endedAt,
    endedAt: spec.endedAt,
    agents: [],
    events: [],
    // Drive the SessionDetail rollup columns the branch read sums.
    tokenUsageByModel: [
      {
        model: spec.model,
        inputTokens: spec.usage.inputTokens,
        outputTokens: spec.usage.outputTokens,
        cacheReadTokens: spec.usage.cacheReadTokens,
        cacheWriteTokens: spec.usage.cacheWriteTokens,
        estimatedCostUsd: spec.usage.estimatedCostUsd,
      },
    ],
    ...(activity
      ? {
          activitySegmentRows: activity.segments.map((segment) => ({
            phase: segment.phase,
            startMs: segment.startMs,
            endMs: segment.endMs,
            confidence: segment.confidence,
            evidenceLayers: [],
            version: 1,
          })),
          tokenEvents: activity.tokenEvents.map((event, index) => {
            const evidence = parityCostEvidenceForEvent(
              spec.externalSessionId,
              index,
              event.costUsd
            );
            return {
              externalEventId: `${spec.externalSessionId}-event-${index}`,
              model: spec.model,
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              ...(event.costUsd == null
                ? {}
                : { estimatedCostUsd: event.costUsd }),
              ...evidence,
              createdAt: event.createdAt,
            };
          }),
        }
      : {}),
  };
  const payload: DesktopAgentSessionsPayload = {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: randomUUID(),
    syncMode: AgentSessionSyncMode.Backfill,
    sessionCount: 1,
    sessions: [session],
  };
  await agentSessionsService.upsertSessions(context, payload);
  const row = await withDb((db) =>
    db.sessionDetail.findUniqueOrThrow({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId: context.computeTargetId,
          externalSessionId: spec.externalSessionId,
        },
      },
      select: { artifactId: true },
    })
  );
  return row.artifactId;
}

/** Link a session artifact to the branch with the `session_pr` metadata the read keys on. */
async function linkSessionToBranch(
  organizationId: string,
  sessionArtifactId: string,
  branchArtifactId: string,
  branchName: string = CROSS_SURFACE_BRANCH_NAME
): Promise<void> {
  await withDb((db) =>
    db.artifactLink.create({
      data: {
        organizationId,
        sourceId: sessionArtifactId,
        targetId: branchArtifactId,
        linkType: LinkType.RelatesTo,
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionPr,
          branchName,
          branchRepositoryFullName: CROSS_SURFACE_REPO_FULL_NAME,
        },
      },
    })
  );
}

async function seedCloudScenario(): Promise<{
  organizationId: string;
  branchArtifactId: string;
  primaryProjectId: string;
}> {
  const organizationId = await createTestOrganization();
  const userA = await createTestUser(organizationId);
  const userB = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, userA.id);
  const secondProjectId = await createTestProject(organizationId, userA.id, {
    name: "Cross-surface second project",
  });
  const repositoryId = await seedRepo(organizationId);
  const branchArtifactId = await seedBranch(
    organizationId,
    repositoryId,
    projectId
  );
  const targetA = await createComputeTarget(organizationId, userA.id, "a");
  const targetB = await createComputeTarget(organizationId, userB.id, "b");

  // FEA-3826: a SECOND branch in a DIFFERENT project that the multi-branch
  // session also links to. The global divisor remains 2 even when callers filter
  // the returned corpus to projectId; project membership cannot shrink 1/N.
  const secondBranchArtifactId = await seedBranch(
    organizationId,
    repositoryId,
    secondProjectId,
    CROSS_SURFACE_SECOND_BRANCH_NAME
  );

  for (const spec of CROSS_SURFACE_SESSIONS) {
    const isUserA = spec.userId === CROSS_SURFACE_USER_A;
    const sessionArtifactId = await seedSession(
      {
        organizationId,
        userId: isUserA ? userA.id : userB.id,
        computeTargetId: isUserA ? targetA : targetB,
      },
      spec
    );
    await linkSessionToBranch(
      organizationId,
      sessionArtifactId,
      branchArtifactId
    );
    // The multi-branch session gets a second session_pr link → branch_count 2.
    if (spec.externalSessionId === CROSS_SURFACE_MULTI_BRANCH_SESSION_ID) {
      await linkSessionToBranch(
        organizationId,
        sessionArtifactId,
        secondBranchArtifactId,
        CROSS_SURFACE_SECOND_BRANCH_NAME
      );
    }
  }
  return { organizationId, branchArtifactId, primaryProjectId: projectId };
}

describeIfDb("cross-surface branch parity — cloud (PRD-522 R6)", () => {
  it("cloud branch read matches the shared surface-invariant expectation", async () => {
    await autoRollbackTransaction(async () => {
      const expected = computeExpectedBranchRollup();
      const { organizationId, branchArtifactId, primaryProjectId } =
        await seedCloudScenario();

      const detail = await branchReadService.getBranchDetail(
        organizationId,
        branchArtifactId
      );
      expect(detail).not.toBeNull();
      if (!detail) {
        return;
      }

      // Distinct linked sessions (both users' sessions surface on the branch).
      expect(detail.sessionIds.length).toBe(expected.sessionCount);
      expect(detail.sessions.length).toBe(expected.sessionCount);

      // Aggregate token sums across all linked sessions.
      const sum = (pick: (s: BranchSession) => number) =>
        detail.sessions.reduce((acc, s) => acc + pick(s), 0);
      expect(sum((s) => s.inputTokens)).toBe(expected.inputTokens);
      expect(sum((s) => s.outputTokens)).toBe(expected.outputTokens);
      expect(sum((s) => s.cacheReadTokens)).toBe(expected.cacheReadTokens);
      expect(sum((s) => s.cacheWriteTokens)).toBe(expected.cacheWriteTokens);

      // Raw compatibility remains the sum of full session costs; canonical
      // attribution even-splits beta across the two branches.
      expect(detail.estimatedCostUsd).toBe(
        expected.perSession.reduce(
          (total, session) => total + session.estimatedCostUsd,
          0
        )
      );
      expect(detail.attributedCostUsd).toBe(expected.estimatedCostUsd);

      // Per-session usage multiset (order-independent; no cross-surface id).
      const actualPerSession: ParityPerSessionUsage[] = detail.sessions.map(
        (s) => ({
          inputTokens: s.inputTokens,
          outputTokens: s.outputTokens,
          cacheReadTokens: s.cacheReadTokens,
          cacheWriteTokens: s.cacheWriteTokens,
          estimatedCostUsd: s.estimatedCostUsd ?? 0,
        })
      );
      expect(actualPerSession.map(paritySessionUsageSortKey).sort()).toEqual(
        expected.perSession.map(paritySessionUsageSortKey).sort()
      );

      // Merged-trace ordering (R6.3): same session ordering + idle synthesis.
      // Normalize to {type, tMs, gapMs} — the epoch-ms instant pins ordering
      // (indistinguishable `sessionstart`s can't hide a mis-order) while staying
      // robust to timestamp-string format; sessionId is excluded (not comparable).
      const trace = await branchReadService.getBranchTrace(
        organizationId,
        branchArtifactId,
        { limit: 100, offset: 0 }
      );
      expect(trace).not.toBeNull();
      const normalizedTrace = (trace?.items ?? []).map((item) => ({
        type: item.type,
        tMs: Date.parse((item as { t?: string }).t ?? ""),
        gapMs: (item as { gapMs?: number }).gapMs ?? null,
      }));
      expect(normalizedTrace).toEqual(computeExpectedMergedTrace());

      // FEA-2276: the per-activity cost rollup must match the shared expectation
      // (the SAME the desktop-local test asserts) — proves the cloud read
      // attributes segment spend identically to the desktop projection.
      expect(rollupBranchActivity(detail)).toEqual(
        computeExpectedActivityRollup()
      );

      // The returned corpus is filtered to the primary project, but the
      // multi-branch session's second link belongs to another project. The list
      // path must still use the global distinct-branch divisor (2), matching the
      // unfiltered detail and Desktop parity result above.
      const projectFilteredList = await branchReadService.listBranches(
        organizationId,
        {
          limit: 100,
          offset: 0,
          projectId: [primaryProjectId],
        }
      );
      expect(projectFilteredList.items.map((item) => item.id)).toEqual([
        branchArtifactId,
      ]);
      expect(projectFilteredList.items[0]?.attributedCostUsd).toBe(
        expected.estimatedCostUsd
      );
      expect(
        Object.values(projectFilteredList.sessionBranchCount ?? {}).sort()
      ).toEqual([1, 1, 2]);

      const usage = await branchReadService.getBranchUsage(organizationId, {
        limit: 100,
        offset: 0,
      });
      expect(usage.costCompleteness).toEqual(computeExpectedCostCompleteness());
      const boundedUsage = await branchReadService.getBranchUsage(
        organizationId,
        {
          limit: 100,
          offset: 0,
          startDate: new Date(CROSS_SURFACE_BOUNDED_START),
          endDate: new Date(CROSS_SURFACE_BOUNDED_END),
        }
      );
      const expectedBounded = computeExpectedBoundedCostCompleteness();
      expect(boundedUsage.costCompleteness).toEqual(expectedBounded);
      expect(boundedUsage.totalEstimatedCost).toBe(
        "subtotalUsd" in expectedBounded ? expectedBounded.subtotalUsd : 0
      );
    });
  });
});
