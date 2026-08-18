import { randomUUID } from "node:crypto";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  DesktopAgentSessionsAckReason,
  type DesktopAgentSessionsPayload,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import {
  DESKTOP_AGENT_SESSION_SYNC_MAX_SESSIONS_PER_REQUEST,
  DESKTOP_AGENT_SESSION_SYNC_REQUEST_MAX_BYTES,
} from "@repo/api/src/types/agent-session-sync-limits";
import { ArtifactType } from "@repo/api/src/types/artifact";
import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  SessionPrRelationType,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import { MonitoredSessionActivityEventKind } from "@repo/api/src/types/session-monitored-activity";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { upsertSessionSlice } from "@/app/agent-sessions/service/upsert-session-slice";
import {
  DesktopAgentSessionsRateLimiter,
  handleDesktopAgentSessionsEvent,
} from "@/lib/desktop-agent-sessions-handler";
import { desktopAgentSessionsPayloadObjectSchema } from "@/lib/desktop-agent-sessions-schema";
import { createTestOrganization, createTestUser } from "../utils/db-helpers";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const FIXTURE_SESSION_COUNT = 11;
const EVENT_ROWS_PER_SESSION = 250;
const ARTIFACT_LINKS_PER_SESSION = 2;
const REFERENCED_ARTIFACT_SLUG = "FEA-93935";
const STARTED_AT = "2026-07-30T12:00:00.000Z";
const UPDATED_AT = "2026-07-30T12:05:00.000Z";
const REPOSITORY_FULL_NAME = "closedloop-ai/symphony-alpha";

describeIfDb("desktop agent-session worst-case ingestion", () => {
  it("persists a producer-bound-exceeding batch without P2028", async () => {
    const organizationId = await createTestOrganization();
    try {
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);
      await createReferencedArtifact(organizationId, user.id);
      await createRepositoryAuthority(organizationId);
      const payload = buildPayload();

      // ISS-5988: the producer bound is no longer "one session per request" —
      // admission is bounded by BYTES (the 256 KiB request cap plus the desktop's
      // hydration byte budget), and the count constant is only a backstop. So the
      // meaningful server-side property is that a MULTI-session batch inside the
      // schema's own `sessions: z.array(...).max(200)` ceiling persists without
      // P2028, which is what this fixture proves.
      expect(FIXTURE_SESSION_COUNT).toBeGreaterThan(1);
      expect(FIXTURE_SESSION_COUNT).toBeLessThanOrEqual(
        DESKTOP_AGENT_SESSION_SYNC_MAX_SESSIONS_PER_REQUEST
      );
      expect(DESKTOP_AGENT_SESSION_SYNC_REQUEST_MAX_BYTES).toBeGreaterThan(0);

      await agentSessionsService.upsertSessions(
        {
          organizationId,
          userId: user.id,
          computeTargetId: computeTarget.id,
        },
        payload
      );

      const persisted = await readPersistedCounts(
        organizationId,
        computeTarget.id
      );
      expect(persisted.sessions).toBe(FIXTURE_SESSION_COUNT);
      expect(persisted.events).toBe(
        FIXTURE_SESSION_COUNT * EVENT_ROWS_PER_SESSION
      );
      expect(persisted.tokenEvents).toBe(FIXTURE_SESSION_COUNT);
      expect(persisted.rollups).toBe(FIXTURE_SESSION_COUNT);
      expect(persisted.componentUsage).toBe(FIXTURE_SESSION_COUNT * 2);
      expect(persisted.branchDetails).toBe(FIXTURE_SESSION_COUNT);
      expect(persisted.artifactLinks).toBe(
        FIXTURE_SESSION_COUNT * ARTIFACT_LINKS_PER_SESSION
      );
      expect(persisted.distinctArtifactLinks).toBe(persisted.artifactLinks);
      expect(persisted.pullRequestDetails).toBe(FIXTURE_SESSION_COUNT);
      expect(persisted.commitDetails).toBe(FIXTURE_SESSION_COUNT);
      expect(persisted.branchActivityAtoms).toBe(FIXTURE_SESSION_COUNT);
      expect(persisted.lastAgentSessionSyncAt).toBeInstanceOf(Date);

      // Report the dimensions in the assertion path without timing checks.
      expect({
        sessions: FIXTURE_SESSION_COUNT,
        perSession: {
          analytics: 1,
          branchRefs: 1,
          commitRefs: 1,
          componentUsage: 2,
          events: EVENT_ROWS_PER_SESSION,
          prRefs: 1,
          tokenEvents: 1,
          tokenUsageByModel: 1,
        },
      }).toMatchObject({
        sessions: 11,
        perSession: {
          analytics: 1,
          branchRefs: 1,
          commitRefs: 1,
          componentUsage: 2,
          events: EVENT_ROWS_PER_SESSION,
          prRefs: 1,
          tokenEvents: 1,
          tokenUsageByModel: 1,
        },
      });
    } finally {
      await cleanupOrganization(organizationId);
    }
  });

  it("keeps partial committed slices retryable and duplicate-free", async () => {
    const organizationId = await createTestOrganization();
    try {
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);
      const referencedArtifactId = await createReferencedArtifact(
        organizationId,
        user.id
      );
      await createRepositoryAuthority(organizationId);
      const payload = buildPayload();

      const failedAck = await handleDesktopAgentSessionsEvent(
        payload,
        {
          organizationId,
          targetId: computeTarget.id,
          userId: user.id,
        },
        {
          isFeatureEnabled: async () => true,
          isOrgPolicyEnabled: async () => true,
          rateLimiter: new DesktopAgentSessionsRateLimiter(),
          upsertBatch: async (context, parsedPayload) => {
            await withDb.tx((tx) =>
              upsertSessionSlice(tx, {
                context,
                includeFrustration: false,
                projectResolution: {
                  artifactProjectById: new Map(),
                  loopProjectById: new Map(),
                  sameOrgLoopIds: new Set(),
                },
                session: parsedPayload.sessions[0],
                slugMap: new Map([
                  [REFERENCED_ARTIFACT_SLUG, referencedArtifactId],
                ]),
                syncTimestamp: new Date("2026-07-30T12:06:00.000Z"),
              })
            );
            throw new Error("slice_failed_after_commit");
          },
        }
      );

      expect(failedAck).toEqual({
        accepted: false,
        reason: DesktopAgentSessionsAckReason.IngestionFailed,
      });

      const partial = await readPersistedCounts(
        organizationId,
        computeTarget.id
      );
      expect(partial.sessions).toBe(1);
      expect(partial.events).toBe(EVENT_ROWS_PER_SESSION);
      expect(partial.artifactLinks).toBe(ARTIFACT_LINKS_PER_SESSION);
      expect(partial.distinctArtifactLinks).toBe(partial.artifactLinks);
      expect(partial.componentUsage).toBe(2);
      expect(partial.lastAgentSessionSyncAt).toBeNull();

      await agentSessionsService.upsertSessions(
        {
          organizationId,
          userId: user.id,
          computeTargetId: computeTarget.id,
        },
        payload
      );

      const retried = await readPersistedCounts(
        organizationId,
        computeTarget.id
      );
      expect(retried).toMatchObject({
        branchDetails: FIXTURE_SESSION_COUNT,
        branchActivityAtoms: FIXTURE_SESSION_COUNT,
        artifactLinks: FIXTURE_SESSION_COUNT * ARTIFACT_LINKS_PER_SESSION,
        commitDetails: FIXTURE_SESSION_COUNT,
        componentUsage: FIXTURE_SESSION_COUNT * 2,
        distinctArtifactLinks:
          FIXTURE_SESSION_COUNT * ARTIFACT_LINKS_PER_SESSION,
        events: FIXTURE_SESSION_COUNT * EVENT_ROWS_PER_SESSION,
        pullRequestDetails: FIXTURE_SESSION_COUNT,
        rollups: FIXTURE_SESSION_COUNT,
        sessions: FIXTURE_SESSION_COUNT,
        tokenEvents: FIXTURE_SESSION_COUNT,
      });
      expect(retried.lastAgentSessionSyncAt).toBeInstanceOf(Date);
    } finally {
      await cleanupOrganization(organizationId);
    }
  });
});

function createComputeTarget(organizationId: string, userId: string) {
  return withDb((db) =>
    db.computeTarget.create({
      data: {
        organizationId,
        userId,
        machineName: "fea-3935-worst-case",
        platform: "darwin",
      },
      select: { id: true },
    })
  );
}

function createReferencedArtifact(organizationId: string, userId: string) {
  return withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId,
        createdById: userId,
        name: "FEA-3935 referenced artifact",
        slug: REFERENCED_ARTIFACT_SLUG,
        status: "DRAFT",
        type: ArtifactType.Document,
      },
      select: { id: true },
    });
    return artifact.id;
  });
}

function createRepositoryAuthority(organizationId: string) {
  return withDb((db) =>
    db.publicRepository.create({
      data: {
        organizationId,
        ...persistedGitHubRepositoryAuthority({
          githubRepoId: "repo-symphony-alpha",
          fullName: REPOSITORY_FULL_NAME,
        }),
        owner: "closedloop-ai",
        name: "symphony-alpha",
        htmlUrl: `https://github.com/${REPOSITORY_FULL_NAME}`,
      },
    })
  );
}

function buildPayload(): DesktopAgentSessionsPayload {
  const sessions = Array.from({ length: FIXTURE_SESSION_COUNT }, (_, index) =>
    buildSession(index + 1)
  );
  const payload = {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: randomUUID(),
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: sessions.length,
    sessions,
  } satisfies DesktopAgentSessionsPayload;
  assertPayloadIsWireValid(payload);
  return payload;
}

function buildSession(index: number): SyncedAgentSession {
  const externalSessionId = `fea-3935-session-${index}`;
  const branchName = `feat/fea-3935-${index}`;
  const sha = index.toString(16).padStart(40, "0");
  return {
    externalSessionId,
    name: `FEA-3935 worst-case ${index}`,
    status: "completed",
    harness: "codex",
    cwd: `/tmp/fea-3935/${index}`,
    model: "gpt-5.5",
    startedAt: STARTED_AT,
    updatedAt: UPDATED_AT,
    endedAt: UPDATED_AT,
    agents: [
      {
        externalAgentId: `agent-${index}`,
        name: "Implementation worker",
        type: "main",
        status: "completed",
      },
    ],
    events: buildEvents(externalSessionId, index),
    tokenUsageByModel: [
      {
        model: "gpt-5.5",
        inputTokens: 100 + index,
        outputTokens: 50 + index,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        estimatedCostUsd: 0.25,
      },
    ],
    tokenEvents: [
      {
        externalEventId: `${externalSessionId}-token-1`,
        agentExternalId: `agent-${index}`,
        model: "gpt-5.5",
        inputTokens: 100 + index,
        outputTokens: 50 + index,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        estimatedCostUsd: 0.25,
        createdAt: UPDATED_AT,
      },
    ],
    sessionAnalytics: {
      startedAt: STARTED_AT,
      startedDay: "2026-07-30",
      status: "completed",
      harness: "codex",
      isHuman: false,
      humanTurns: 1,
      agentTurns: 2,
      eventCount: 2,
      toolInvocations: 1,
      errorEvents: 0,
      inputTokens: 100 + index,
      outputTokens: 50 + index,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      estimatedCostUsd: 0.25,
      runtimeMs: 60_000,
      updatedAt: UPDATED_AT,
    },
    components: [
      {
        componentKind: "tool",
        componentKey: "bash",
        harness: "codex",
        invocations: 1,
        errorCount: 0,
        firstInvokedAt: STARTED_AT,
        lastInvokedAt: UPDATED_AT,
        gitBranch: branchName,
      },
      {
        componentKind: "skill",
        componentKey: "workflow-orchestrator",
        externalComponentId: `component-${index}`,
        harness: "codex",
        invocations: 1,
        errorCount: 0,
        firstInvokedAt: STARTED_AT,
        lastInvokedAt: UPDATED_AT,
        gitBranch: branchName,
      },
    ],
    artifactRefs: [
      closedloopArtifactRef(),
      branchRef(branchName),
      pullRequestRef(index, branchName),
      monitoredPullRequestRef(index),
      commitRef(index, branchName, sha),
    ],
    prRefs: [
      {
        repositoryFullName: REPOSITORY_FULL_NAME,
        prNumber: index,
        prUrl: `https://github.com/${REPOSITORY_FULL_NAME}/pull/${index}`,
        relationType: SessionPrRelationType.Created,
      },
    ],
  };
}

function buildEvents(
  externalSessionId: string,
  sessionIndex: number
): SyncedAgentSession["events"] {
  return Array.from({ length: EVENT_ROWS_PER_SESSION }, (_, eventIndex) => ({
    externalEventId: `${externalSessionId}-event-${eventIndex}`,
    agentExternalId: `agent-${sessionIndex}`,
    eventType: eventIndex % 2 === 0 ? "message" : "tool_use",
    ...(eventIndex % 2 === 0 ? {} : { toolName: "Bash" }),
    createdAt: eventIndex === 0 ? STARTED_AT : UPDATED_AT,
  }));
}

function closedloopArtifactRef(): SyncedArtifactRef {
  return {
    kind: ArtifactRefTargetKind.ClosedloopArtifact,
    slug: REFERENCED_ARTIFACT_SLUG,
    isPrimary: false,
    method: ArtifactRefMethod.McpToolCall,
    relation: ArtifactRefRelation.Referenced,
    observedAt: UPDATED_AT,
  };
}

function branchRef(branchName: string): SyncedArtifactRef {
  return {
    kind: ArtifactRefTargetKind.Branch,
    repositoryFullName: REPOSITORY_FULL_NAME,
    branchName,
    method: "git_push",
    relation: ArtifactRefRelation.Created,
    observedAt: UPDATED_AT,
  };
}

function pullRequestRef(index: number, branchName: string): SyncedArtifactRef {
  return {
    kind: ArtifactRefTargetKind.PullRequest,
    repositoryFullName: REPOSITORY_FULL_NAME,
    prNumber: index,
    method: "gh_pr_create",
    relation: ArtifactRefRelation.Created,
    observedAt: UPDATED_AT,
    branchName,
    title: `PR ${index}`,
    state: GitHubPRState.Merged,
    isDraft: false,
    additions: index,
    deletions: 0,
    changedFiles: 1,
    mergedAt: UPDATED_AT,
    closedAt: UPDATED_AT,
  };
}

function monitoredPullRequestRef(index: number): SyncedArtifactRef {
  return {
    kind: ArtifactRefTargetKind.PullRequest,
    repositoryFullName: REPOSITORY_FULL_NAME,
    prNumber: index,
    method: "mcp_tool_call",
    relation: ArtifactRefRelation.Reviewed,
    observedAt: UPDATED_AT,
    // The regular ref above materializes the target. This transport-only
    // duplicate must add one atom without adding a second membership link.
    monitoredActivityOnly: true,
    monitoredSessionActivity: {
      completeness: BranchActivityEvidenceCompleteness.Complete,
      events: [
        {
          kind: MonitoredSessionActivityEventKind.AgentAction,
          sourceEventId: `session-pr-create-${index}`,
          occurredAt: UPDATED_AT,
          completeness: BranchActivityEvidenceCompleteness.Complete,
        },
      ],
    },
  };
}

function commitRef(
  index: number,
  branchName: string,
  sha: string
): SyncedArtifactRef {
  return {
    kind: ArtifactRefTargetKind.Commit,
    repositoryFullName: REPOSITORY_FULL_NAME,
    branchName,
    sha,
    message: `FEA-3935 fixture commit ${index}`,
    committedAt: UPDATED_AT,
    linesAdded: index,
    linesRemoved: 0,
    filesChanged: 1,
    method: "git_commit",
    relation: ArtifactRefRelation.Created,
    observedAt: UPDATED_AT,
  };
}

function readPersistedCounts(organizationId: string, computeTargetId: string) {
  return withDb(async (db) => {
    const sessionRows = await db.sessionDetail.findMany({
      where: { computeTargetId },
      select: { artifactId: true },
    });
    const sessionIds = sessionRows.map((row) => row.artifactId);
    const [
      events,
      tokenEvents,
      rollups,
      componentUsage,
      artifactLinks,
      branchDetails,
      branchActivityAtoms,
      pullRequestDetails,
      commitDetails,
      target,
    ] = await Promise.all([
      db.agentSessionEvent.count({
        where: { agentSessionId: { in: sessionIds } },
      }),
      db.agentSessionTokenEvent.count({
        where: { agentSessionId: { in: sessionIds } },
      }),
      db.agentSessionUsageRollup.count({
        where: { artifactId: { in: sessionIds } },
      }),
      db.agentComponentSessionUsage.count({
        where: { agentSessionId: { in: sessionIds } },
      }),
      db.artifactLink.findMany({
        where: { sourceId: { in: sessionIds } },
        select: { sourceId: true, targetId: true, linkType: true },
      }),
      db.branchDetail.count({ where: { organizationId } }),
      db.branchActivityAtom.count({ where: { organizationId } }),
      db.pullRequestDetail.count({
        where: { organizationId },
      }),
      db.commitDetail.count({ where: { organizationId } }),
      db.computeTarget.findUniqueOrThrow({
        where: { id: computeTargetId },
        select: { lastAgentSessionSyncAt: true },
      }),
    ]);
    const distinctArtifactLinks = new Set(
      artifactLinks.map(
        (link) => `${link.sourceId}:${link.targetId}:${link.linkType}`
      )
    ).size;
    return {
      artifactLinks: artifactLinks.length,
      branchActivityAtoms,
      branchDetails,
      commitDetails,
      componentUsage,
      distinctArtifactLinks,
      events,
      lastAgentSessionSyncAt: target.lastAgentSessionSyncAt,
      pullRequestDetails,
      rollups,
      sessions: sessionRows.length,
      tokenEvents,
    };
  });
}

async function cleanupOrganization(organizationId: string): Promise<void> {
  await withDb(async (db) => {
    const artifacts = await db.artifact.findMany({
      where: { organizationId },
      select: { id: true },
    });
    const artifactIds = artifacts.map((artifact) => artifact.id);
    await db.agentComponentSessionUsage.deleteMany({
      where: { agentSessionId: { in: artifactIds } },
    });
    await db.agentSessionTokenEvent.deleteMany({
      where: { agentSessionId: { in: artifactIds } },
    });
    await db.agentSessionEvent.deleteMany({
      where: { agentSessionId: { in: artifactIds } },
    });
    await db.agentSessionUsageRollup.deleteMany({
      where: { artifactId: { in: artifactIds } },
    });
    await db.artifactLink.deleteMany({
      where: {
        OR: [
          { sourceId: { in: artifactIds } },
          { targetId: { in: artifactIds } },
        ],
      },
    });
    await db.pullRequestDetail.deleteMany({
      where: { organizationId },
    });
    await db.commitDetail.deleteMany({ where: { organizationId } });
    await db.sessionDetail.deleteMany({
      where: { artifactId: { in: artifactIds } },
    });
    await db.branchDetail.deleteMany({ where: { organizationId } });
    await db.publicRepository.deleteMany({ where: { organizationId } });
    await db.artifact.deleteMany({ where: { id: { in: artifactIds } } });
    await db.agentComponent.deleteMany({ where: { organizationId } });
    await db.computeTarget.deleteMany({ where: { organizationId } });
    await db.user.deleteMany({ where: { organizationId } });
    await db.organization.deleteMany({ where: { id: organizationId } });
  });
}

function assertPayloadIsWireValid(payload: DesktopAgentSessionsPayload): void {
  const parsed = desktopAgentSessionsPayloadObjectSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `invalid integration payload: ${JSON.stringify(parsed.error.issues)}`
    );
  }
}
