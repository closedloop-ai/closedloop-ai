/**
 * ISS-12552 (Daveth Oakhurst, 2026-10-22): `attribution-evidence-policy` is off
 * by default for everyone. An organization PostHog gives no answer for reads
 * off at every server read site, end to end. Only the PostHog group
 * evaluation is replaced (it answers nothing); the gate, its request scope,
 * the Dev Mode path (no override in play) and the pinned-snapshot path (no
 * snapshot, or one without the key) all run for real.
 */
import { randomUUID } from "node:crypto";
import {
  isFeatureFlagEnabledForGroup,
  setPinnedFeatureFlagsProvider,
} from "@repo/analytics/feature-flags";
import { Harness } from "@repo/api/src/types/agent-component";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type DesktopAgentSessionsPayload,
} from "@repo/api/src/types/agent-session";
import { LinkDirection, LinkType } from "@repo/api/src/types/artifact";
import {
  MCP_CLIENT_HEADER_VALUE,
  OperationEvidenceHeader,
  OperationEvidenceOutcome,
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import {
  BranchParticipationKind,
  BranchStatus,
} from "@repo/api/src/types/branch";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import {
  OPERATION_EVIDENCE_EXTRACTOR_VERSION,
  type OperationClaim,
  OperationClaimSource,
  ToolResultState,
} from "@repo/api/src/types/operation-claims";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-pr-link-metadata";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import {
  ArtifactSubtype,
  ArtifactType,
  GitHubInstallationStatus,
  withDb,
} from "@repo/database";
import { keys } from "@repo/database/keys";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import { createTestAuthContext } from "@/__tests__/utils/auth-helpers";
import { createComputeTarget } from "@/__tests__/utils/chunked-sync-test-helpers";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { ARTIFACT_LINK_PAGE_SIZE } from "@/app/artifact-links/resolved-page";
import { artifactLinksService } from "@/app/artifact-links/service";
import { writeBranchSourceLink } from "@/app/branches/branch-source-link";
import { upsertBranchArtifactWithAttribution } from "@/app/branches/branch-upsert-with-attribution";
import { documentSessionsService } from "@/app/documents/document-sessions-service";
import { generateSlug } from "@/app/documents/document-utils";
import { POST as createDocument } from "@/app/documents/route";
import { readPullRequestAttributionEvidence } from "@/app/webhooks/github/handlers/pull-request-attribution-read";
import { runWithAttributionEvidenceGate } from "@/lib/attribution-evidence-gate-scope";
import {
  evaluateAttributionEvidenceForOrganization,
  isAttributionEvidenceEnabledForOrganization,
} from "@/lib/attribution-evidence-policy-feature";
import type { AuthContext } from "@/lib/auth/with-auth";
import { bindAwaitingClaimForReceipt } from "@/lib/operation-receipts/bind-awaiting-claim";
import { main as runBackfillScript } from "../../../../scripts/attribution-backfill";
import { main as runComparisonScript } from "../../../../scripts/attribution-comparison-report";
import { persistArtifactLinks } from "../artifact-links/slug-links";
import { listEligibleSessionContributions } from "../provenance-eligibility";
import {
  listRelatedSessions,
  listRelatedSessionsForArtifacts,
} from "../related-sessions";
import { deriveCommittedImplementationEvidence } from "./derive-committed-implementation-evidence";
import { persistSessionOperationEvidence } from "./persist-operation-evidence";
import { syncSessionEvidenceLinks } from "./session-evidence-links";

vi.mock("@repo/analytics/feature-flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/analytics/feature-flags")>()),
  isFeatureFlagEnabledForGroup: vi.fn(async () => null),
}));
const auth = vi.hoisted(() => ({
  context: null as AuthContext | null,
  scheduled: [] as Promise<unknown>[],
}));
vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context?: { params: Promise<unknown> }) =>
      handler(auth.context, request, context?.params),
}));
vi.mock("@vercel/functions", () => ({
  waitUntil: (work: Promise<unknown>) => {
    auth.scheduled.push(work);
  },
}));

const tracker = createCommittedTestOrganizationTracker();
const organizationIds: string[] = [];
const TRANSACTION_OPTIONS = { maxWait: 5000, timeout: 20_000 };
const INVOKED_AT = "2026-10-22T12:00:00.000Z";
const REPOSITORY = "acme/default-off";
const BRANCH = "feat/default-off";
const originalArgv = process.argv;

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 attribution flag off by default",
  () => {
    beforeEach(() => {
      vi.mocked(isFeatureFlagEnabledForGroup).mockClear();
    });

    afterEach(async () => {
      await Promise.all(auth.scheduled.splice(0));
      auth.context = null;
      process.argv = originalArgv;
      setPinnedFeatureFlagsProvider(null);
      vi.restoreAllMocks();
      const ids = organizationIds.splice(0);
      await withDb((db) =>
        db.artifactOperationReceipt.deleteMany({
          where: { organizationId: { in: ids } },
        })
      );
      await tracker.cleanup();
    });

    it("reads an unanswered organization as off, and asks PostHog for its group", async () => {
      const fixture = await seed();

      await expect(
        evaluateAttributionEvidenceForOrganization(fixture.organizationId)
      ).resolves.toBeNull();
      await expect(
        isAttributionEvidenceEnabledForOrganization(fixture.organizationId)
      ).resolves.toBe(false);
      expect(isFeatureFlagEnabledForGroup).toHaveBeenCalled();
    });

    it("reads off from a pinned snapshot that does not name the key", async () => {
      const fixture = await seed();
      setPinnedFeatureFlagsProvider(async () => ({ "some-other-flag": true }));

      await expect(
        evaluateAttributionEvidenceForOrganization(fixture.organizationId)
      ).resolves.toBe(false);
      expect(isFeatureFlagEnabledForGroup).not.toHaveBeenCalled();
    });

    it("records no receipt for an API-key write and returns none", async () => {
      const fixture = await seed();
      auth.context = createTestAuthContext({
        user: { ...fixture.user, organizationId: fixture.organizationId },
        authMethod: "api_key",
        apiKeyScopes: ["read", "write"],
        apiKeyId: randomUUID(),
      });

      const response = await createDocument(
        new NextRequest("http://localhost:3002/documents", {
          method: "POST",
          body: JSON.stringify({
            type: DocumentType.Prd,
            title: "Default off",
            content: "first",
            projectId: fixture.projectId,
          }),
          headers: {
            "Content-Type": "application/json",
            "x-internal-secret": "test-internal-secret",
            [OperationEvidenceHeader.McpClient]: MCP_CLIENT_HEADER_VALUE,
            [OperationEvidenceHeader.ClientCallId]: "toolu_default_off",
          },
        }),
        { params: Promise.resolve({}) }
      );
      const body: { data: Record<string, unknown> } = await response.json();

      expect(response.status).toBe(200);
      expect(body.data).not.toHaveProperty("operationReceipt");
      expect(await receiptCount(fixture.organizationId)).toBe(0);
      expect(isFeatureFlagEnabledForGroup).toHaveBeenCalled();
    });

    it("binds no late receipt to a waiting claim", async () => {
      const fixture = await seed();
      await persistClaims(fixture, [revisionClaim(fixture, "toolu_late")]);
      const receiptId = await recordReceipt(fixture, "toolu_late");

      await bindAwaitingClaimForReceipt(receiptId, fixture.organizationId);

      expect(await evidenceOutcomes(fixture.sessionId)).toEqual([
        { receiptId: null, outcome: OperationEvidenceOutcome.AwaitingReceipt },
      ]);
    });

    it("ingests no evidence or snapshot and stores the sent owner, while acking the batch", async () => {
      const fixture = await seed();
      const computeTargetId = await createComputeTarget(
        fixture.organizationId,
        fixture.user.id,
        "default-off-machine"
      );

      const ack = await agentSessionsService.upsertSessions(
        {
          organizationId: fixture.organizationId,
          userId: fixture.user.id,
          computeTargetId,
        },
        syncPayload(fixture)
      );

      expect(ack.persistedSessionIds).toEqual(["default-off-session"]);
      const session = await withDb((db) =>
        db.sessionDetail.findFirstOrThrow({
          where: { computeTargetId, externalSessionId: "default-off-session" },
          select: {
            artifactId: true,
            tokenEvents: { select: { agentExternalId: true } },
          },
        })
      );
      expect(await evidenceRowCount(fixture.organizationId)).toBe(0);
      expect(await snapshotCount(fixture.organizationId)).toBe(0);
      expect(session.tokenEvents).toEqual([{ agentExternalId: "agent-sub" }]);
      expect(isFeatureFlagEnabledForGroup).toHaveBeenCalled();
    });

    it("derives no implementation evidence after an ingest commit", async () => {
      const fixture = await seed();
      const branchId = await seedBranch(fixture);
      await linkIssueToBranch(fixture, branchId);
      await sessionWroteBranch(fixture, branchId);

      await deriveCommittedImplementationEvidence(fixture.organizationId, [
        fixture.sessionId,
      ]);

      expect(await evidenceRowCount(fixture.organizationId)).toBe(0);
      expect(isFeatureFlagEnabledForGroup).toHaveBeenCalled();
    });

    it("derives no implementation evidence when the links service writes an issue-to-branch link", async () => {
      const fixture = await seed();
      const branchId = await seedBranch(fixture);
      await sessionWroteBranch(fixture, branchId);

      const created = await artifactLinksService.createLink(
        fixture.organizationId,
        {
          sourceId: fixture.issueId,
          targetId: branchId,
          linkType: LinkType.Produces,
        }
      );

      expect(created.ok).toBe(true);
      expect(await evidenceRowCount(fixture.organizationId)).toBe(0);
      expect(isFeatureFlagEnabledForGroup).toHaveBeenCalled();
    });

    it("derives nothing from a branch write's source link through the upsert wrapper", async () => {
      const fixture = await seed();
      const repository = await seedInstallationRepository(fixture);
      const input = {
        organizationId: fixture.organizationId,
        repositoryId: repository.id,
        repositoryFullName: REPOSITORY,
        branchName: BRANCH,
        projectId: fixture.projectId,
      };
      const branch = await upsertBranchArtifactWithAttribution(input);
      if (!branch.ok) {
        throw new Error("expected the branch to be written");
      }
      await sessionWroteBranch(fixture, branch.value.id);

      const linked = await upsertBranchArtifactWithAttribution({
        ...input,
        sourceArtifactId: fixture.issueId,
      });

      expect(linked.ok && linked.value.linkedArtifacts).toHaveLength(1);
      expect(await evidenceRowCount(fixture.organizationId)).toBe(0);
      expect(isFeatureFlagEnabledForGroup).toHaveBeenCalled();
    });

    it("derives nothing from a source link the pull_request webhook writes", async () => {
      const fixture = await seed();
      const repository = await seedInstallationRepository(fixture);
      const branchId = await seedBranch(fixture);
      await sessionWroteBranch(fixture, branchId);

      await runWithAttributionEvidenceGate(async () => {
        await readPullRequestAttributionEvidence(
          { id: repository.githubRepoId, full_name: REPOSITORY },
          repository.installationId
        );
        await withDb.tx(
          (tx) =>
            writeBranchSourceLink(tx, {
              organizationId: fixture.organizationId,
              sourceArtifactId: fixture.issueId,
              branchArtifactId: branchId,
            }),
          TRANSACTION_OPTIONS
        );
      });

      expect(await evidenceRowCount(fixture.organizationId)).toBe(0);
      expect(isFeatureFlagEnabledForGroup).toHaveBeenCalled();
    });

    it("answers every reader arm from the legacy links", async () => {
      const fixture = await seed();
      await persistOutputMention(fixture);
      await recordReceipt(fixture, "toolu_revision");
      await persistClaims(fixture, [revisionClaim(fixture, "toolu_revision")]);
      const legacy = (
        await listEligibleSessionContributions({
          organizationId: fixture.organizationId,
          artifactId: fixture.documentId,
        })
      ).map((row) => [row.sessionArtifactId, row.kind]);

      const single = await listRelatedSessions(
        fixture.organizationId,
        fixture.documentId,
        25
      );
      const batch = await listRelatedSessionsForArtifacts(
        fixture.organizationId,
        [fixture.documentId],
        25
      );
      const tab = await documentSessionsService.readSessions(
        fixture.organizationId,
        fixture.documentId
      );
      const direct = await artifactLinksService.findResolvedLinksPage(
        fixture.organizationId,
        fixture.documentId,
        LinkDirection.Source,
        { skip: 0, take: 10 }
      );
      const tree = await artifactLinksService.findResolvedLinkTreePage(
        fixture.organizationId,
        fixture.documentId,
        LinkDirection.Source,
        1,
        { skip: 0, take: ARTIFACT_LINK_PAGE_SIZE + 1 }
      );

      expect(legacy).toHaveLength(1);
      expect(
        single.items.map((row) => [row.sessionArtifactId, row.kind])
      ).toEqual(legacy);
      expect(
        (batch[fixture.documentId]?.items ?? []).map((row) => [
          row.sessionArtifactId,
          row.kind,
        ])
      ).toEqual(legacy);
      expect(tab?.detail.sessions.map((row) => row.sessionId)).toEqual([
        fixture.sessionId,
      ]);
      for (const page of [direct, tree]) {
        expect(page.items).toHaveLength(1);
        expect(page.items[0]).not.toHaveProperty("sessionEvidence");
      }
      expect(isFeatureFlagEnabledForGroup).toHaveBeenCalled();
    });

    it("writes no evidence link and leaves the snapshot's links digest stale for a retry", async () => {
      const fixture = await seed();
      await persistClaims(fixture, [revisionClaim(fixture, "toolu_link")]);

      await syncSessionEvidenceLinks(fixture.organizationId, [
        fixture.sessionId,
      ]);

      expect(await evidenceLinkCount(fixture.organizationId)).toBe(0);
      expect(
        await withDb((db) =>
          db.agentSessionOperationEvidenceSnapshot.findMany({
            where: { agentSessionId: fixture.sessionId },
            select: { linksSyncedDigest: true },
          })
        )
      ).toEqual([{ linksSyncedDigest: null }]);
    });

    it("refuses to run the backfill and the comparison report", async () => {
      const fixture = await seed();
      process.argv = [
        "node",
        "attribution-backfill.ts",
        "--org",
        fixture.organizationId,
      ];
      await expect(runBackfillScript()).rejects.toThrow(fixture.organizationId);
      process.argv = [
        "node",
        "attribution-comparison-report.ts",
        "--out",
        "default-off-report.json",
        "--org",
        fixture.organizationId,
      ];
      await expect(runComparisonScript()).rejects.toThrow(
        fixture.organizationId
      );
    });
  }
);

type Fixture = {
  organizationId: string;
  user: Awaited<ReturnType<typeof createTestUser>>;
  projectId: string;
  sessionId: string;
  documentId: string;
  documentSlug: string;
  issueId: string;
};

async function seed(): Promise<Fixture> {
  const organizationId = await tracker.create();
  organizationIds.push(organizationId);
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  const sessionId = await createTestSessionDetail({
    organizationId,
    userId: user.id,
    label: "default-off",
  });
  const documentSlug = generateSlug();
  const [documentId, issueId] = await withDb(async (db) => {
    const created: string[] = [];
    for (const subtype of [ArtifactSubtype.PRD, ArtifactSubtype.FEATURE]) {
      const artifact = await db.artifact.create({
        data: {
          name: subtype,
          slug: subtype === ArtifactSubtype.PRD ? documentSlug : generateSlug(),
          type: ArtifactType.DOCUMENT,
          subtype,
          status: DocumentStatus.Draft,
          organizationId,
          createdById: user.id,
          projectId,
        },
        select: { id: true },
      });
      created.push(artifact.id);
    }
    return created;
  });
  if (!(documentId && issueId)) {
    throw new Error("expected a document and an issue");
  }
  return {
    organizationId,
    user,
    projectId,
    sessionId,
    documentId,
    documentSlug,
    issueId,
  };
}

async function seedBranch(fixture: Fixture): Promise<string> {
  return await withDb(async (db) => {
    const branch = await db.artifact.create({
      data: {
        organizationId: fixture.organizationId,
        type: ArtifactType.BRANCH,
        name: "branch-default-off",
        status: BranchStatus.Open,
        createdById: fixture.user.id,
      },
      select: { id: true },
    });
    await db.branchDetail.create({
      data: {
        artifactId: branch.id,
        organizationId: fixture.organizationId,
        repositoryFullName: REPOSITORY,
        branchName: BRANCH,
      },
      select: { artifactId: true },
    });
    return branch.id;
  });
}

async function seedInstallationRepository(
  fixture: Fixture
): Promise<{ id: string; installationId: number; githubRepoId: number }> {
  const installationId = Number.parseInt(
    randomUUID().replaceAll("-", "").slice(0, 8),
    16
  );
  const githubRepoId = installationId + 1;
  const installation = await withDb((db) =>
    db.gitHubInstallation.create({
      data: {
        organizationId: fixture.organizationId,
        installationId: String(installationId),
        accountId: `acct-${installationId}`,
        accountLogin: "acme",
        accountType: "Organization",
        status: GitHubInstallationStatus.ACTIVE,
        senderLogin: "sender",
        senderId: `sender-${installationId}`,
        repositories: {
          create: {
            ...persistedGitHubRepositoryAuthority({
              githubRepoId: String(githubRepoId),
              fullName: REPOSITORY,
            }),
            name: "default-off",
            owner: "acme",
            private: false,
          },
        },
      },
      select: { repositories: { select: { id: true } } },
    })
  );
  const [repository] = installation.repositories;
  if (!repository) {
    throw new Error("expected a repository");
  }
  return { id: repository.id, installationId, githubRepoId };
}

function linkIssueToBranch(fixture: Fixture, branchId: string) {
  return withDb((db) =>
    db.artifactLink.create({
      data: {
        organizationId: fixture.organizationId,
        sourceId: fixture.issueId,
        targetId: branchId,
        linkType: LinkType.Produces,
      },
    })
  );
}

function sessionWroteBranch(fixture: Fixture, branchId: string) {
  return withDb((db) =>
    db.artifactLink.create({
      data: {
        organizationId: fixture.organizationId,
        sourceId: fixture.sessionId,
        targetId: branchId,
        linkType: LinkType.RelatesTo,
        branchParticipation: BranchParticipationKind.Wrote,
        metadata: {},
      },
    })
  );
}

function revisionClaim(fixture: Fixture, callId: string): OperationClaim {
  return {
    claimKey: `claude:${callId}`,
    providerCallId: callId,
    source: OperationClaimSource.ClosedloopMcp,
    toolName: "update-document",
    operationKind: OperationKind.UpdateFields,
    resultState: ToolResultState.Present,
    inputTargets: [{ key: "documentId", uuid: fixture.documentId }],
    invokedAt: INVOKED_AT,
    resultAt: "2026-10-22T12:00:05.000Z",
  };
}

async function recordReceipt(fixture: Fixture, callId: string) {
  const row = await withDb((db) =>
    db.artifactOperationReceipt.create({
      data: {
        id: randomUUID(),
        organizationId: fixture.organizationId,
        principalUserId: fixture.user.id,
        source: OperationSource.Mcp,
        operationKind: OperationKind.UpdateFields,
        targetArtifactId: fixture.documentId,
        outcome: OperationReceiptOutcome.Committed,
        changedFields: ["fileName"],
        clientCallId: callId,
        requestedAt: new Date("2026-10-22T12:00:01.000Z"),
        committedAt: new Date("2026-10-22T12:00:01.000Z"),
      },
      select: { id: true },
    })
  );
  return row.id;
}

function persistClaims(fixture: Fixture, claims: OperationClaim[]) {
  return withDb.tx(
    (tx) =>
      persistSessionOperationEvidence(tx, {
        organizationId: fixture.organizationId,
        agentSessionId: fixture.sessionId,
        fresh: true,
        evidence: {
          extractorVersion: OPERATION_EVIDENCE_EXTRACTOR_VERSION,
          digest: "d".repeat(64),
          coverage: {
            harness: "claude",
            evidencePathSupported: true,
            closedloopMcpCalls: claims.length,
            shellCallsWithOperationIds: 0,
            directApiShellCommands: 0,
            unsupportedToolNames: {},
            claimsDroppedByCap: 0,
          },
          claims,
        },
      }),
    TRANSACTION_OPTIONS
  );
}

function persistOutputMention(fixture: Fixture) {
  return withDb.tx(
    (tx) =>
      persistArtifactLinks(
        tx,
        fixture.organizationId,
        fixture.sessionId,
        [
          {
            kind: ArtifactRefTargetKind.ClosedloopArtifact,
            slug: fixture.documentSlug,
            method: ArtifactRefMethod.McpToolCall,
            isPrimary: false,
            relation: ArtifactRefRelation.Output,
          },
        ],
        new Map([[fixture.documentSlug, fixture.documentId]]),
        new Date()
      ),
    TRANSACTION_OPTIONS
  );
}

function syncPayload(fixture: Fixture): DesktopAgentSessionsPayload {
  const claims = [revisionClaim(fixture, "toolu_ingest")];
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: randomUUID(),
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    wantsAcceptedSessionIds: true,
    sessions: [
      {
        externalSessionId: "default-off-session",
        name: "ISS-12552 default off",
        status: SESSION_STATUS.ACTIVE,
        harness: Harness.Claude,
        cwd: "/tmp/default-off",
        startedAt: INVOKED_AT,
        updatedAt: "2026-10-22T13:00:00.000Z",
        agents: [],
        events: [],
        tokenUsageByModel: [],
        tokenEvents: [
          {
            externalEventId: "default-off-event",
            model: "claude-opus-4",
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            estimatedCostUsd: 0.5,
            createdAt: INVOKED_AT,
            agentExternalId: "agent-sub",
          },
        ],
        operationEvidence: {
          extractorVersion: OPERATION_EVIDENCE_EXTRACTOR_VERSION,
          digest: "e".repeat(64),
          coverage: {
            harness: "claude",
            evidencePathSupported: true,
            closedloopMcpCalls: claims.length,
            shellCallsWithOperationIds: 0,
            directApiShellCommands: 0,
            unsupportedToolNames: {},
            claimsDroppedByCap: 0,
          },
          claims,
        },
      },
    ],
  };
}

function receiptCount(organizationId: string) {
  return withDb((db) =>
    db.artifactOperationReceipt.count({ where: { organizationId } })
  );
}

function evidenceRowCount(organizationId: string) {
  return withDb((db) =>
    db.agentSessionOperationEvidence.count({ where: { organizationId } })
  );
}

function snapshotCount(organizationId: string) {
  return withDb((db) =>
    db.agentSessionOperationEvidenceSnapshot.count({
      where: { organizationId },
    })
  );
}

function evidenceLinkCount(organizationId: string) {
  return withDb((db) =>
    db.artifactLink.count({
      where: {
        organizationId,
        metadata: {
          path: ["linkKind"],
          equals: SessionArtifactLinkKind.SessionEvidence,
        },
      },
    })
  );
}

function evidenceOutcomes(sessionId: string) {
  return withDb((db) =>
    db.agentSessionOperationEvidence.findMany({
      where: { agentSessionId: sessionId },
      select: { receiptId: true, outcome: true },
    })
  );
}
