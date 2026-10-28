/**
 * ISS-12552: session ingest re-derives a session's
 * implementation evidence when its slice can change it (a new evidence
 * snapshot, or branch refs), and only then, against a real Postgres.
 */
import { Harness } from "@repo/api/src/types/agent-component";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type DesktopAgentSessionsPayload,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { LinkType } from "@repo/api/src/types/artifact";
import {
  AttributionRelationshipKind,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { BranchStatus } from "@repo/api/src/types/branch";
import { DocumentStatus } from "@repo/api/src/types/document";
import {
  OPERATION_EVIDENCE_EXTRACTOR_VERSION,
  OperationClaimSource,
} from "@repo/api/src/types/operation-claims";
import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import { GIT_PUSH_METHOD } from "@/__tests__/utils/branch-identity-sql-fixture";
import { createComputeTarget } from "@/__tests__/utils/chunked-sync-test-helpers";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { generateSlug } from "@/app/documents/document-utils";
import { upsertSessionsBatch } from "../upsert-sessions-batch";

/**
 * The flag is on (PRD-800), for derivation and for the link sync alike:
 * with the link sync off the links digest stays stale, so the second slice
 * would rebuild the snapshot and re-derive.
 */
vi.mock("@/lib/attribution-evidence-policy-feature", () => ({
  isAttributionEvidenceEnabledForOrganization: vi.fn(async () => true),
  evaluateAttributionEvidenceForOrganization: vi.fn(async () => true),
}));

const REPOSITORY = "acme/implementation-ingest";
const BRANCH = "feat/implemented";
const EXTERNAL_SESSION_ID = "iss12552-implementation-ingest";
const STARTED_AT = "2026-10-16T10:00:00.000Z";
const tracker = createCommittedTestOrganizationTracker();

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 implementation evidence at session ingest",
  () => {
    afterEach(() => tracker.cleanup());

    it("writes the implementation row with the requests the slice's join names, and leaves it alone for a slice with neither branch refs nor a new snapshot", async () => {
      const fixture = await seed();

      await upsertSessionsBatch(
        fixture.context,
        payload(session("2026-10-16T11:00:00.000Z", { branchRef: true }))
      );
      const derived = await implementationRows(fixture.organizationId);
      expect(derived).toEqual([
        {
          targetArtifactId: fixture.branchId,
          relationshipKind: AttributionRelationshipKind.Implementation,
          source: OperationSource.Repository,
          anchors: expect.objectContaining({
            requestKeys: ["req-implemented"],
          }),
        },
      ]);

      // A re-derive now would delete the row, so a slice that skips it leaves it.
      await withDb((db) =>
        db.artifactLink.updateMany({
          where: {
            organizationId: fixture.organizationId,
            targetId: fixture.branchId,
            linkType: LinkType.RelatesTo,
          },
          data: { branchParticipation: null, metadata: {} },
        })
      );
      await upsertSessionsBatch(
        fixture.context,
        payload(session("2026-10-16T12:00:00.000Z", { branchRef: false }))
      );

      expect(await implementationRows(fixture.organizationId)).toEqual(derived);
    });
  }
);

type Fixture = {
  organizationId: string;
  branchId: string;
  context: { organizationId: string; userId: string; computeTargetId: string };
};

/** An issue whose branch already exists, in an org with the repository's authority. */
async function seed(): Promise<Fixture> {
  const organizationId = await tracker.create();
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  const computeTargetId = await createComputeTarget(
    organizationId,
    user.id,
    "iss12552-implementation-ingest"
  );
  const [owner, name] = REPOSITORY.split("/");
  const branchId = await withDb(async (db) => {
    await db.publicRepository.create({
      data: {
        organizationId,
        ...persistedGitHubRepositoryAuthority({
          githubRepoId: `repo-${organizationId}`,
          fullName: REPOSITORY,
        }),
        owner,
        name,
        htmlUrl: `https://github.com/${REPOSITORY}`,
      },
      select: { id: true },
    });
    const branch = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: BRANCH,
        status: BranchStatus.Open,
        createdById: user.id,
      },
      select: { id: true },
    });
    await db.branchDetail.create({
      data: {
        artifactId: branch.id,
        organizationId,
        repositoryFullName: REPOSITORY,
        branchName: BRANCH,
      },
      select: { artifactId: true },
    });
    const issue = await db.artifact.create({
      data: {
        name: "Issue",
        slug: generateSlug(),
        type: ArtifactType.DOCUMENT,
        subtype: ArtifactSubtype.FEATURE,
        status: DocumentStatus.Draft,
        organizationId,
        createdById: user.id,
        projectId,
      },
      select: { id: true },
    });
    await db.artifactLink.create({
      data: {
        organizationId,
        sourceId: issue.id,
        targetId: branch.id,
        linkType: LinkType.Produces,
      },
      select: { id: true },
    });
    return branch.id;
  });
  return {
    organizationId,
    branchId,
    context: { organizationId, userId: user.id, computeTargetId },
  };
}

function session(
  updatedAt: string,
  options: { branchRef: boolean }
): SyncedAgentSession {
  return {
    externalSessionId: EXTERNAL_SESSION_ID,
    name: "ISS-12552 implementation ingest",
    status: SESSION_STATUS.ACTIVE,
    harness: Harness.Claude,
    cwd: "/tmp/iss12552-implementation",
    startedAt: STARTED_AT,
    updatedAt,
    agents: [],
    events: [],
    tokenUsageByModel: [],
    tokenEvents: [],
    ...(options.branchRef
      ? {
          artifactRefs: [
            {
              kind: ArtifactRefTargetKind.Branch,
              repositoryFullName: REPOSITORY,
              branchName: BRANCH,
              method: GIT_PUSH_METHOD,
              relation: ArtifactRefRelation.Created,
              observedAt: updatedAt,
            },
          ],
        }
      : {}),
    operationEvidence: {
      extractorVersion: OPERATION_EVIDENCE_EXTRACTOR_VERSION,
      digest: "b".repeat(64),
      coverage: {
        harness: "claude",
        evidencePathSupported: true,
        closedloopMcpCalls: 0,
        shellCallsWithOperationIds: 0,
        directApiShellCommands: 0,
        unsupportedToolNames: {},
        claimsDroppedByCap: 0,
      },
      claims: [
        {
          claimKey: `claude:implementation:${BRANCH}`,
          source: OperationClaimSource.ImplementationJoin,
          branch: BRANCH,
          requestKeys: ["req-implemented"],
        },
      ],
    },
  };
}

function payload(synced: SyncedAgentSession): DesktopAgentSessionsPayload {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: crypto.randomUUID(),
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [synced],
  };
}

function implementationRows(organizationId: string) {
  return withDb((db) =>
    db.agentSessionOperationEvidence.findMany({
      where: {
        organizationId,
        relationshipKind: AttributionRelationshipKind.Implementation,
      },
      select: {
        targetArtifactId: true,
        relationshipKind: true,
        source: true,
        anchors: true,
      },
    })
  );
}
