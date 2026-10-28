/**
 * ISS-12552: a session's evidence links sync after its ingest slice commits.
 * The attribution flag is never read while the slice transaction is open, and
 * an unavailable flag answer leaves the snapshot's links digest stale so a
 * resync with the same digest syncs the links once the flag answers.
 */
import { Harness } from "@repo/api/src/types/agent-component";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type DesktopAgentSessionsPayload,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import { DocumentStatus } from "@repo/api/src/types/document";
import {
  OPERATION_EVIDENCE_EXTRACTOR_VERSION,
  type OperationClaim,
  OperationClaimSource,
  ToolResultState,
} from "@repo/api/src/types/operation-claims";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-pr-link-metadata";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { log } from "@repo/observability/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createComputeTarget } from "@/__tests__/utils/chunked-sync-test-helpers";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { generateSlug } from "@/app/documents/document-utils";
import { ATTRIBUTION_EVIDENCE_POLICY_FLAG_UNAVAILABLE_LOG_KEY } from "@/lib/attribution-evidence-policy-feature";
import { upsertSessionsBatch } from "../upsert-sessions-batch";

const flag = vi.hoisted(() => ({
  answer: null as boolean | null,
  openTransactions: 0,
  readInsideTransaction: false,
}));
vi.mock("@/lib/attribution-evidence-policy-feature", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/attribution-evidence-policy-feature")
    >();
  const read = () => {
    if (flag.openTransactions > 0) {
      flag.readInsideTransaction = true;
    }
    return Promise.resolve(flag.answer);
  };
  return {
    ...actual,
    evaluateAttributionEvidenceForOrganization: vi.fn(read),
    isAttributionEvidenceEnabledForOrganization: vi.fn(
      async () => (await read()) === true
    ),
  };
});

const EXTERNAL_SESSION_ID = "iss12552-links-post-commit";
const STARTED_AT = "2026-10-16T10:00:00.000Z";
const tracker = createCommittedTestOrganizationTracker();

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 evidence links after the ingest commit",
  () => {
    beforeEach(() => {
      flag.answer = null;
      flag.openTransactions = 0;
      flag.readInsideTransaction = false;
      const tx = withDb.tx;
      vi.spyOn(withDb, "tx").mockImplementation(async (fn, options) => {
        flag.openTransactions += 1;
        try {
          return await tx(fn, options);
        } finally {
          flag.openTransactions -= 1;
        }
      });
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await tracker.cleanup();
    });

    it("reads the flag only after the slice commits", async () => {
      flag.answer = true;
      const fixture = await seed();

      await upsertSessionsBatch(
        fixture.context,
        payload(session("2026-10-16T11:00:00.000Z", fixture.documentId))
      );

      expect(flag.readInsideTransaction).toBe(false);
      expect(await evidenceLinks(fixture)).toEqual([
        { metadata: { linkKind: SessionArtifactLinkKind.SessionEvidence } },
      ]);
    });

    it("syncs the links on a same-digest resync after an unavailable answer", async () => {
      const warn = vi.spyOn(log, "warn");
      const fixture = await seed();

      await upsertSessionsBatch(
        fixture.context,
        payload(session("2026-10-16T11:00:00.000Z", fixture.documentId))
      );
      expect(await evidenceLinks(fixture)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        ATTRIBUTION_EVIDENCE_POLICY_FLAG_UNAVAILABLE_LOG_KEY,
        expect.objectContaining({
          level: "warn",
          status: "warn",
          deferredSessionCount: 1,
        })
      );

      flag.answer = true;
      await upsertSessionsBatch(
        fixture.context,
        payload(session("2026-10-16T12:00:00.000Z", fixture.documentId))
      );

      expect(flag.readInsideTransaction).toBe(false);
      expect(await evidenceLinks(fixture)).toEqual([
        { metadata: { linkKind: SessionArtifactLinkKind.SessionEvidence } },
      ]);
    });
  }
);

type Fixture = {
  organizationId: string;
  documentId: string;
  context: { organizationId: string; userId: string; computeTargetId: string };
};

async function seed(): Promise<Fixture> {
  const organizationId = await tracker.create();
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  const computeTargetId = await createComputeTarget(
    organizationId,
    user.id,
    "iss12552-links-machine"
  );
  const document = await withDb((db) =>
    db.artifact.create({
      data: {
        name: "Plan",
        slug: generateSlug(),
        type: ArtifactType.DOCUMENT,
        subtype: ArtifactSubtype.PRD,
        status: DocumentStatus.Draft,
        organizationId,
        createdById: user.id,
        projectId,
      },
      select: { id: true },
    })
  );
  return {
    organizationId,
    documentId: document.id,
    context: { organizationId, userId: user.id, computeTargetId },
  };
}

function evidenceLinks(fixture: Fixture) {
  return withDb((db) =>
    db.artifactLink.findMany({
      where: {
        organizationId: fixture.organizationId,
        targetId: fixture.documentId,
        metadata: {
          path: ["linkKind"],
          equals: SessionArtifactLinkKind.SessionEvidence,
        },
      },
      select: { metadata: true },
    })
  );
}

function readClaim(documentId: string): OperationClaim {
  return {
    claimKey: "claude:toolu_read",
    providerCallId: "toolu_read",
    source: OperationClaimSource.ClosedloopMcp,
    toolName: "get-document",
    operationKind: OperationKind.Read,
    resultState: ToolResultState.Present,
    inputTargets: [{ key: "documentId", uuid: documentId }],
    invokedAt: STARTED_AT,
    resultAt: STARTED_AT,
  };
}

/** The same claims, so the same digest, at a later session update time. */
function session(updatedAt: string, documentId: string): SyncedAgentSession {
  const claims = [readClaim(documentId)];
  return {
    externalSessionId: EXTERNAL_SESSION_ID,
    name: "ISS-12552 links after commit",
    status: SESSION_STATUS.ACTIVE,
    harness: Harness.Claude,
    cwd: "/tmp/iss12552-links",
    startedAt: STARTED_AT,
    updatedAt,
    agents: [],
    events: [],
    tokenUsageByModel: [],
    tokenEvents: [],
    operationEvidence: {
      extractorVersion: OPERATION_EVIDENCE_EXTRACTOR_VERSION,
      digest: "a".repeat(64),
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
