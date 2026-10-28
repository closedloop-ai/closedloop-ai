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
import { GitHubInstallationStatus } from "@repo/api/src/types/github";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  MAX_SYNCED_ARTIFACT_REFS_PRODUCER,
  SessionPrRelationType,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import { MonitoredSessionActivityEventKind } from "@repo/api/src/types/session-monitored-activity";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import { observeStatements } from "@/__tests__/support/db-statement-observer";
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
const SLUG_REFS_PER_SESSION = MAX_SYNCED_ARTIFACT_REFS_PRODUCER - 3;
const ARTIFACT_LINKS_PER_SESSION = SLUG_REFS_PER_SESSION + 1;
const STARTED_AT = "2026-07-30T12:00:00.000Z";
const UPDATED_AT = "2026-07-30T12:05:00.000Z";
const REPOSITORY_FULL_NAME = "closedloop-ai/closedloop-ai";

describeIfDb("desktop agent-session worst-case ingestion", () => {
  it("persists a producer-bound-exceeding batch without P2028", async () => {
    const organizationId = await createTestOrganization();
    try {
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);
      await createReferencedArtifact(organizationId, user.id);
      await createRepositoryAuthority(organizationId);
      const payload = buildPayload();
      expect(
        payload.sessions[0].artifactRefs?.filter(
          (ref) => ref.kind !== ArtifactRefTargetKind.Commit
        )
      ).toHaveLength(MAX_SYNCED_ARTIFACT_REFS_PRODUCER);

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

      const { statements } = await observeStatements(() =>
        agentSessionsService.upsertSessions(
          {
            organizationId,
            userId: user.id,
            computeTargetId: computeTarget.id,
          },
          payload
        )
      );
      expect(statements.length).toBeLessThanOrEqual(
        FIXTURE_SESSION_COUNT * 150 + 30
      );
      console.info("ISS-9278 full ingest", {
        sessions: FIXTURE_SESSION_COUNT,
        refs: MAX_SYNCED_ARTIFACT_REFS_PRODUCER,
        statements: statements.length,
      });

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
      expect(persisted.branchActivityCompatibilityAliases).toBe(
        FIXTURE_SESSION_COUNT
      );
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

  it("bounds a mixed session and its replay with 100 producer refs", async () => {
    const organizationId = await createTestOrganization();
    try {
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);
      await createReferencedArtifact(organizationId, user.id);
      await createRepositoryAuthority(organizationId);
      const session = buildSession(1);
      session.artifactRefs = [
        ...Array.from({ length: 77 }, (_, index) =>
          closedloopArtifactRef(index)
        ),
        ...Array.from({ length: 20 }, (_, index) =>
          branchRef(`feat/mixed-${index}`)
        ),
        ...Array.from({ length: 3 }, (_, index) =>
          pullRequestRef(index + 1, `feat/mixed-${index}`)
        ),
        ...Array.from({ length: 30 }, (_, index) =>
          commitRef(
            index + 1,
            `feat/mixed-${index % 20}`,
            (index + 1).toString(16).padStart(40, "0")
          )
        ),
      ];
      session.prRefs = Array.from({ length: 3 }, (_, index) => ({
        repositoryFullName: REPOSITORY_FULL_NAME,
        prNumber: index + 1,
        prUrl: `https://github.com/${REPOSITORY_FULL_NAME}/pull/${index + 1}`,
        relationType: SessionPrRelationType.Created,
      }));
      const payload = {
        ...buildPayload(),
        sessions: [session],
        sessionCount: 1,
      };
      const context = {
        organizationId,
        userId: user.id,
        computeTargetId: computeTarget.id,
      };
      assertPayloadIsWireValid(payload);
      const first = await observeStatements(() =>
        agentSessionsService.upsertSessions(context, payload)
      );
      const before = await readPersistedCounts(
        organizationId,
        computeTarget.id
      );
      const replay = await observeStatements(() =>
        agentSessionsService.upsertSessions(context, payload)
      );
      const after = await readPersistedCounts(organizationId, computeTarget.id);
      expect(before).toMatchObject({
        sessions: 1,
        branchDetails: 20,
        pullRequestDetails: 3,
        commitDetails: 30,
        artifactLinks: 97,
        distinctArtifactLinks: 97,
      });
      expect(after).toMatchObject({
        ...before,
        lastAgentSessionSyncAt: expect.any(Date),
      });
      const persistedSession = await withDb((db) =>
        db.artifact.findFirst({
          where: { organizationId, type: ArtifactType.Session },
          select: { assigneeId: true },
        })
      );
      expect(persistedSession?.assigneeId).toBe(user.id);
      // ISS-11608, measured on this fixture. Before: 120 statements first, 112
      // on replay, 34 of them advisory locks (3 provider, 2 per-session, 25
      // Session-link and per-edge, 4 retry-identity). After: 93 and 85, with 8
      // advisory-lock statements. ISS-12251 adds one user lookup to the create
      // arm for its assignee connection: measured first ingest is now 94;
      // replay remains within the existing 85-statement budget. ISS-12251's
      // createdAt sync then added the upsert's `artifact.createdAt` read-back,
      // one SELECT on `artifacts`: measured first ingest is now 95.
      // ISS-12279 signals every branch the session joins or leaves: two
      // RelatesTo link reads plus ONE batched pg_notify for all 20 branches
      // (unbatched it was one statement per branch, 116 first). Measured: 97
      // first, 88 replay. ISS-12463 seeds the branch assignee once per ingest:
      // one UPDATE over the batch's branches that the existing-branch lookup
      // read as unassigned, so a first ingest pays it and a replay of branches
      // the first ingest seeded skips it. ISS-12552 derives
      // implementation evidence from branch participation in one read.
      // Measured: 99 first, 89 replay.
      for (const observed of [first, replay]) {
        const advisoryLocks = observed.statements.filter((statement) =>
          statement.sql.includes("advisory_xact_lock")
        );
        expect(advisoryLocks.length).toBeLessThanOrEqual(8);
        // The three PR identities in ONE statement carrying all three keys.
        const providerLocks = advisoryLocks.filter((statement) =>
          statement.values.some(
            (value) =>
              Array.isArray(value) &&
              value.some(
                (key) =>
                  typeof key === "string" &&
                  key.startsWith("iss-6980:pull-request-provider:")
              )
          )
        );
        expect(providerLocks).toHaveLength(1);
        expect(providerLocks[0].values[0]).toHaveLength(3);
        // The Session-link key once per transaction, though the branch lane and
        // the PR-link lane both take it.
        const sessionLinkLocks = advisoryLocks.filter((statement) =>
          statement.values.some(
            (value) =>
              typeof value === "string" &&
              value.startsWith("iss-6980:session-artifact-links:")
          )
        );
        expect(sessionLinkLocks).toHaveLength(1);
      }
      expect(first.statements.length).toBeLessThanOrEqual(99);
      expect(replay.statements.length).toBeLessThanOrEqual(89);
      console.info("ISS-9278 mixed ingest", {
        branches: 20,
        prs: 3,
        commits: 30,
        slugs: 77,
        first: first.statements.length,
        replay: replay.statements.length,
      });
    } finally {
      await cleanupOrganization(organizationId);
    }
  });

  it("locks a prose-only PR identity once before session locks and preserves absent prRefs", async () => {
    const organizationId = await createTestOrganization();
    try {
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);
      await createRepositoryAuthority(organizationId);
      const context = {
        organizationId,
        userId: user.id,
        computeTargetId: computeTarget.id,
      };
      const session = buildSession(1);
      await withDb((db) =>
        db.gitHubInstallation.create({
          data: {
            organizationId,
            installationId: randomUUID(),
            accountId: "1",
            accountLogin: "closedloop-ai",
            accountType: "Organization",
            senderLogin: "test",
            senderId: "1",
            status: GitHubInstallationStatus.Active,
            repositories: {
              create: {
                ...persistedGitHubRepositoryAuthority({
                  githubRepoId: "repo-closedloop-ai",
                  fullName: REPOSITORY_FULL_NAME,
                }),
                owner: "closedloop-ai",
                name: "closedloop-ai",
                private: false,
              },
            },
          },
          select: { id: true },
        })
      );
      session.artifactRefs = [pullRequestRef(1, "feat/prose")];
      const payload = {
        ...buildPayload(),
        sessions: [session],
        sessionCount: 1,
      };
      await agentSessionsService.upsertSessions(context, payload);
      await withDb((db) =>
        db.pullRequestDetail.updateMany({
          where: { organizationId },
          data: { lastVerifiedAt: new Date(UPDATED_AT) },
        })
      );
      session.artifactRefs = [
        {
          kind: ArtifactRefTargetKind.PullRequest,
          repositoryFullName: REPOSITORY_FULL_NAME,
          prNumber: 1,
          method: ArtifactRefMethod.PrMentionInProse,
          relation: ArtifactRefRelation.Referenced,
          observedAt: UPDATED_AT,
        },
      ];
      await withDb((db) =>
        db.artifactLink.deleteMany({ where: { organizationId } })
      );
      session.externalSessionId = "iss9278-prose-only-session";
      session.prRefs = [];
      const observed = await observeStatements(() =>
        agentSessionsService.upsertSessions(context, payload)
      );
      const provider = observed.statements.flatMap((statement, index) =>
        statement.sql.includes("pg_advisory_xact_lock") &&
        statement.values.some(
          (value) =>
            typeof value === "string" &&
            value.startsWith("iss-6980:pull-request-provider:")
        )
          ? [index]
          : []
      );
      expect(provider).toHaveLength(1);
      const sessionLock = observed.statements.findIndex((statement) =>
        statement.sql.includes("pg_advisory_xact_lock(hashtext(")
      );
      expect(provider[0]).toBeLessThan(sessionLock);
      const links = await withDb((db) =>
        db.artifactLink.findMany({
          where: { organizationId },
          select: { metadata: true },
        })
      );
      expect(links).toHaveLength(1);
      expect(links[0].metadata).toMatchObject({
        linkKind: "session_pr_prose",
      });
      session.prRefs = undefined;
      const absent = await observeStatements(() =>
        agentSessionsService.upsertSessions(context, payload)
      );
      expect(
        absent.statements.filter((statement) =>
          statement.values.some(
            (value) =>
              typeof value === "string" &&
              value.startsWith("iss-6980:pull-request-provider:")
          )
        )
      ).toHaveLength(0);
    } finally {
      await cleanupOrganization(organizationId);
    }
  });

  it("keeps partial committed slices retryable and duplicate-free", async () => {
    const organizationId = await createTestOrganization();
    try {
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);
      const slugMap = await createReferencedArtifact(organizationId, user.id);
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
          rateLimiter: new DesktopAgentSessionsRateLimiter(),
          upsertBatch: async (context, parsedPayload) => {
            await withDb.tx((tx) =>
              upsertSessionSlice(tx, {
                context,
                dataSyncLevel: parsedPayload.dataSyncLevel,
                includeFrustration: false,
                projectResolution: {
                  artifactProjectById: new Map(),
                },
                rowLevelAck: parsedPayload.wantsAcceptedSessionIds === true,
                session: parsedPayload.sessions[0],
                slugMap,
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
        branchActivityCompatibilityAliases: FIXTURE_SESSION_COUNT,
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
    const rows = await db.artifact.createManyAndReturn({
      data: Array.from({ length: SLUG_REFS_PER_SESSION }, (_, index) => ({
        organizationId,
        createdById: userId,
        name: `Referenced artifact ${index}`,
        slug: `FEA-${939_350 + index}`,
        status: "DRAFT",
        type: ArtifactType.Document,
      })),
      select: { id: true, slug: true },
    });
    return new Map(rows.map((row) => [row.slug!, row.id]));
  });
}

function createRepositoryAuthority(organizationId: string) {
  return withDb((db) =>
    db.publicRepository.create({
      data: {
        organizationId,
        ...persistedGitHubRepositoryAuthority({
          githubRepoId: "repo-closedloop-ai",
          fullName: REPOSITORY_FULL_NAME,
        }),
        owner: "closedloop-ai",
        name: "closedloop-ai",
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
      ...Array.from({ length: SLUG_REFS_PER_SESSION }, (_, index) =>
        closedloopArtifactRef(index)
      ),
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

function closedloopArtifactRef(index: number): SyncedArtifactRef {
  return {
    kind: ArtifactRefTargetKind.ClosedloopArtifact,
    slug: `FEA-${939_350 + index}`,
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
      branchActivityCompatibilityAliases,
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
      db.branchActivityAtom.count({
        where: {
          organizationId,
          compatibilityAliasForSourceEventId: null,
        },
      }),
      db.branchActivityAtom.count({
        where: {
          organizationId,
          compatibilityAliasForSourceEventId: { not: null },
        },
      }),
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
      branchActivityCompatibilityAliases,
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
    await db.gitHubInstallation.deleteMany({ where: { organizationId } });
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
