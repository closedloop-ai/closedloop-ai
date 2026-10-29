/**
 * ISS-12552: evidence links and the evidence read path
 * against a real Postgres, with `attribution-evidence-policy` on and off.
 */
import { randomUUID } from "node:crypto";
import { LinkDirection, LinkType } from "@repo/api/src/types/artifact";
import {
  AttributionRelationshipKind,
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { DocumentStatus } from "@repo/api/src/types/document";
import {
  OPERATION_EVIDENCE_EXTRACTOR_VERSION,
  type OperationClaim,
  OperationClaimSource,
  ToolResultState,
} from "@repo/api/src/types/operation-claims";
import { ProvenanceRelationshipKind } from "@repo/api/src/types/provenance-relationship";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-pr-link-metadata";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import {
  ARTIFACT_LINK_PAGE_SIZE,
  type ResolvedLinkWindow,
} from "@/app/artifact-links/resolved-page";
import { artifactLinksService } from "@/app/artifact-links/service";
import { documentSessionsService } from "@/app/documents/document-sessions-service";
import { generateSlug } from "@/app/documents/document-utils";
import { evaluateAttributionEvidenceForOrganization } from "@/lib/attribution-evidence-policy-feature";
import { bindAwaitingClaimForReceipt } from "@/lib/operation-receipts/bind-awaiting-claim";
import { persistArtifactLinks } from "../artifact-links/slug-links";
import { classifySessionLinkKind } from "../provenance-eligibility";
import {
  listRelatedSessions,
  listRelatedSessionsForArtifacts,
} from "../related-sessions";
import { runAttributionBackfill } from "./attribution-backfill";
import { persistSessionOperationEvidence } from "./persist-operation-evidence";
import { syncSessionEvidenceLinks } from "./session-evidence-links";
import { settleCommittedSessionEvidence } from "./settle-committed-session-evidence";

/** On for every organization while `on`, else for the listed ones only. */
const flag = vi.hoisted(() => ({
  on: false,
  onOrganizationIds: new Set<string>(),
}));
vi.mock("@/lib/attribution-evidence-policy-feature", () => ({
  isAttributionEvidenceEnabledForOrganization: vi.fn(
    async (organizationId: string) =>
      flag.on || flag.onOrganizationIds.has(organizationId)
  ),
  evaluateAttributionEvidenceForOrganization: vi.fn(
    async (organizationId: string) =>
      flag.on || flag.onOrganizationIds.has(organizationId)
  ),
}));

const CLOP_ID_RE = /^clop_[0-9a-f-]{36}$/;
const tracker = createCommittedTestOrganizationTracker();
/** Cold-start headroom; the ingest transaction sets its own budget. */
const TRANSACTION_OPTIONS = { maxWait: 5000, timeout: 20_000 };
const organizationIds: string[] = [];
const EVIDENCE_DIGEST = "c".repeat(64);

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 evidence links and reads",
  () => {
    afterEach(async () => {
      flag.on = false;
      flag.onOrganizationIds.clear();
      const ids = organizationIds.splice(0);
      await withDb(async (db) => {
        await db.artifactOperationReceipt.deleteMany({
          where: { organizationId: { in: ids } },
        });
        await db.attributionBackfillRun.deleteMany({
          where: { organizationId: { in: ids } },
        });
      });
      await tracker.cleanup();
    });

    it("links a UUID-only revision while the flag is on, and the slug sweep keeps it", async () => {
      flag.on = true;
      const fixture = await seed();
      await syncRevision(fixture);

      await withDb.tx(
        (tx) =>
          persistArtifactLinks(
            tx,
            fixture.organizationId,
            fixture.sessionId,
            [],
            new Map(),
            new Date()
          ),
        TRANSACTION_OPTIONS
      );

      expect(await links(fixture)).toEqual([
        { metadata: { linkKind: SessionArtifactLinkKind.SessionEvidence } },
      ]);
      const related = await listRelatedSessions(
        fixture.organizationId,
        fixture.documentId,
        5
      );
      expect(related.items.map((row) => row.kind)).toEqual([
        ProvenanceRelationshipKind.Contribution,
      ]);
    });

    it("carries the evidence on the session row of the document's resolved links", async () => {
      flag.on = true;
      const fixture = await seed();
      await syncRevision(fixture);

      const page = await resolvedLinks(fixture);

      expect(page.items.map((item) => item.sessionEvidence)).toEqual([
        expect.objectContaining({
          relationshipKind: AttributionRelationshipKind.Revision,
          operations: [
            expect.objectContaining({
              operationId: expect.stringMatching(CLOP_ID_RE),
              operationKind: OperationKind.UpdateFields,
              durableResult: { changedFields: ["fileName"] },
            }),
          ],
        }),
      ]);
    });

    it("keeps the revision when the session reads the document afterwards", async () => {
      flag.on = true;
      const fixture = await seed();
      await syncRevision(fixture, [
        {
          claimKey: "claude:toolu_read_after",
          providerCallId: "toolu_read_after",
          source: OperationClaimSource.ClosedloopMcp,
          toolName: "get-document",
          operationKind: OperationKind.Read,
          resultState: ToolResultState.Present,
          inputTargets: [{ key: "documentId", uuid: fixture.documentId }],
          invokedAt: "2026-10-16T12:10:00.000Z",
          resultAt: "2026-10-16T12:10:01.000Z",
        },
      ]);

      const page = await resolvedLinks(fixture);

      expect(page.items[0]?.sessionEvidence).toMatchObject({
        relationshipKind: AttributionRelationshipKind.Revision,
        operations: [
          { relationshipKind: AttributionRelationshipKind.Revision },
          { relationshipKind: AttributionRelationshipKind.Usage },
        ],
      });
    });

    it("omits sessionEvidence from resolved links while the flag is off, and returns it when on", async () => {
      flag.on = true;
      const fixture = await seed();
      await syncRevision(fixture);

      flag.on = false;
      const off = await resolvedLinks(fixture);
      flag.on = true;
      const on = await resolvedLinks(fixture);

      expect(off.items).toHaveLength(1);
      expect(off.items.map((item) => "sessionEvidence" in item)).toEqual([
        false,
      ]);
      expect(
        on.items.map((item) => item.sessionEvidence?.relationshipKind)
      ).toEqual([AttributionRelationshipKind.Revision]);
    });

    it("gates sessionEvidence in tree mode on the freshly traversed and the cached page", async () => {
      flag.on = true;
      const fixture = await seed();
      await syncRevision(fixture);
      const cachedWindow = await cacheTreePage(fixture);
      const freshWindow = { skip: 0, take: ARTIFACT_LINK_PAGE_SIZE + 1 };

      flag.on = false;
      const off = [
        await resolvedTree(fixture, freshWindow),
        await resolvedTree(fixture, cachedWindow),
      ];
      flag.on = true;
      const on = [
        await resolvedTree(fixture, freshWindow),
        await resolvedTree(fixture, cachedWindow),
      ];

      expect(
        off.map((page) => page.items.map((item) => "sessionEvidence" in item))
      ).toEqual([[false], [false]]);
      expect(
        on.map((page) =>
          page.items.map((item) => item.sessionEvidence?.relationshipKind)
        )
      ).toEqual([
        [AttributionRelationshipKind.Revision],
        [AttributionRelationshipKind.Revision],
      ]);
    });

    it("reads a slug-lane output mention with no evidence as mention-only while the flag is on", async () => {
      const fixture = await seed();
      await persistOutputMention(fixture);
      const related = () =>
        listRelatedSessions(fixture.organizationId, fixture.documentId, 5);

      flag.on = false;
      const off = await related();
      flag.on = true;
      const on = await related();

      expect(off.items.map((row) => row.kind)).toEqual([
        ProvenanceRelationshipKind.Contribution,
      ]);
      expect(on.items).toEqual([]);
    });

    it("answers every reader from its own organization's flag", async () => {
      const on = await seed();
      const off = await seed();
      flag.on = true;
      for (const fixture of [on, off]) {
        await syncRevision(fixture);
      }
      const mentionOn = await seed();
      const mentionOff = await seed();
      for (const fixture of [mentionOn, mentionOff]) {
        await persistOutputMention(fixture);
      }
      flag.on = false;
      flag.onOrganizationIds.add(on.organizationId);
      flag.onOrganizationIds.add(mentionOn.organizationId);
      const freshWindow = { skip: 0, take: ARTIFACT_LINK_PAGE_SIZE + 1 };

      const evidenceKinds = async (fixture: Fixture) => [
        (await resolvedLinks(fixture)).items.map(
          (item) => item.sessionEvidence?.relationshipKind
        ),
        (await resolvedTree(fixture, freshWindow)).items.map(
          (item) => item.sessionEvidence?.relationshipKind
        ),
      ];
      const relatedKinds = async (fixture: Fixture) => {
        const single = await listRelatedSessions(
          fixture.organizationId,
          fixture.documentId,
          5
        );
        const batch = await listRelatedSessionsForArtifacts(
          fixture.organizationId,
          [fixture.documentId],
          5
        );
        const tab = await documentSessionsService.readSessions(
          fixture.organizationId,
          fixture.documentId
        );
        return [
          single.items.map((row) => row.kind),
          (batch[fixture.documentId]?.items ?? []).map((row) => row.kind),
          (tab?.detail.sessions ?? []).length,
        ];
      };

      expect(await evidenceKinds(on)).toEqual([
        [AttributionRelationshipKind.Revision],
        [AttributionRelationshipKind.Revision],
      ]);
      expect(await evidenceKinds(off)).toEqual([[undefined], [undefined]]);
      expect(await relatedKinds(mentionOn)).toEqual([[], [], 0]);
      expect(await relatedKinds(mentionOff)).toEqual([
        [ProvenanceRelationshipKind.Contribution],
        [ProvenanceRelationshipKind.Contribution],
        1,
      ]);
    });

    it("writes no link and reads the legacy classification while the flag is off", async () => {
      const fixture = await seed();
      await syncRevision(fixture);

      expect(await links(fixture)).toEqual([]);
      const related = await listRelatedSessions(
        fixture.organizationId,
        fixture.documentId,
        5
      );
      expect(related.items).toEqual([]);
    });

    it("leaves the links digest stale while the flag is off, so the first sync with it on writes the links", async () => {
      const fixture = await seed();
      await recordRevisionReceipt(fixture);
      await ingestClaims(fixture, [revisionClaim(fixture)]);

      expect(await links(fixture)).toEqual([]);
      expect(await linksSyncedDigest(fixture)).toBeNull();

      flag.on = true;
      await ingestClaims(fixture, [revisionClaim(fixture)]);

      expect(await links(fixture)).toEqual([
        { metadata: { linkKind: SessionArtifactLinkKind.SessionEvidence } },
      ]);
      expect(await linksSyncedDigest(fixture)).toBe(EVIDENCE_DIGEST);
    });

    it("gives an evidence link the slug lane's legacy fields, so legacy classification matches the base", async () => {
      flag.on = true;
      const fixture = await seed();
      await syncRevision(fixture);

      await withDb.tx(
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
                relation: ArtifactRefRelation.Created,
              },
            ],
            new Map([[fixture.documentSlug, fixture.documentId]]),
            new Date()
          ),
        TRANSACTION_OPTIONS
      );

      const [link] = await withDb((db) =>
        db.artifactLink.findMany({
          where: { sourceId: fixture.sessionId },
          select: { linkType: true, branchParticipation: true, metadata: true },
        })
      );
      expect(link && classifySessionLinkKind(link)).toBe(
        ProvenanceRelationshipKind.Contribution
      );
      expect(link?.metadata).toMatchObject({
        linkKind: SessionArtifactLinkKind.SessionEvidence,
        relation: ArtifactRefRelation.Created,
      });
    });

    it("demotes a merged link to the slug lane's legacy link when its evidence goes away", async () => {
      flag.on = true;
      const fixture = await seed();
      await syncRevision(fixture);
      await withDb.tx(
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
                relation: ArtifactRefRelation.Created,
              },
            ],
            new Map([[fixture.documentSlug, fixture.documentId]]),
            new Date()
          ),
        TRANSACTION_OPTIONS
      );

      await withDb.tx(
        (tx) =>
          persistSessionOperationEvidence(tx, {
            organizationId: fixture.organizationId,
            agentSessionId: fixture.sessionId,
            fresh: true,
            evidence: {
              extractorVersion: OPERATION_EVIDENCE_EXTRACTOR_VERSION,
              digest: "e".repeat(64),
              coverage: {
                harness: "claude",
                evidencePathSupported: true,
                closedloopMcpCalls: 1,
                shellCallsWithOperationIds: 0,
                directApiShellCommands: 0,
                unsupportedToolNames: {},
                claimsDroppedByCap: 0,
              },
              claims: [
                {
                  claimKey: "claude:toolu_list",
                  providerCallId: "toolu_list",
                  source: OperationClaimSource.ClosedloopMcp,
                  toolName: "list-documents",
                  operationKind: OperationKind.List,
                  resultState: ToolResultState.Present,
                  invokedAt: "2026-10-16T12:01:00.000Z",
                  resultAt: "2026-10-16T12:01:05.000Z",
                },
              ],
            },
          }),
        TRANSACTION_OPTIONS
      );
      await syncSessionEvidenceLinks(fixture.organizationId, [
        fixture.sessionId,
      ]);

      const [link] = await withDb((db) =>
        db.artifactLink.findMany({
          where: { sourceId: fixture.sessionId, targetId: fixture.documentId },
          select: { linkType: true, branchParticipation: true, metadata: true },
        })
      );
      expect(link?.metadata).toMatchObject({
        relation: ArtifactRefRelation.Created,
      });
      expect(link?.metadata).not.toHaveProperty("linkKind");
      expect(link && classifySessionLinkKind(link)).toBe(
        ProvenanceRelationshipKind.Contribution
      );
    });

    it("links a create whose receipt bound after its claim synced, under the organization's flag", async () => {
      flag.on = true;
      const fixture = await seed();
      // The create timed out, so only its receipt names what it made.
      await syncClaims(fixture, [
        {
          claimKey: "claude:toolu_create_timeout",
          providerCallId: "toolu_create_timeout",
          source: OperationClaimSource.ClosedloopMcp,
          toolName: "create-document",
          operationKind: OperationKind.Create,
          resultState: ToolResultState.Error,
          invokedAt: "2026-10-16T12:00:00.000Z",
          resultAt: "2026-10-16T12:00:05.000Z",
        },
      ]);
      expect(await links(fixture)).toEqual([]);
      const receiptId = randomUUID();
      await withDb((db) =>
        db.artifactOperationReceipt.create({
          data: {
            id: receiptId,
            organizationId: fixture.organizationId,
            principalUserId: fixture.userId,
            source: OperationSource.Mcp,
            operationKind: OperationKind.Create,
            createdArtifactId: fixture.documentId,
            outcome: OperationReceiptOutcome.Committed,
            clientCallId: "toolu_create_timeout",
            requestedAt: new Date("2026-10-16T12:00:01.000Z"),
            committedAt: new Date("2026-10-16T12:00:01.000Z"),
          },
        })
      );
      vi.mocked(evaluateAttributionEvidenceForOrganization).mockClear();

      await bindAwaitingClaimForReceipt(receiptId, fixture.organizationId);

      expect(await links(fixture)).toEqual([
        { metadata: { linkKind: SessionArtifactLinkKind.SessionEvidence } },
      ]);
      expect(evaluateAttributionEvidenceForOrganization).toHaveBeenCalledWith(
        fixture.organizationId
      );
    });

    it("links a session that synced while the flag was off once the backfill runs with it on", async () => {
      const fixture = await seed();
      await syncRevision(fixture);
      expect(await links(fixture)).toEqual([]);
      flag.on = true;

      await runAttributionBackfill({ organizationId: fixture.organizationId });

      expect(await links(fixture)).toEqual([
        { metadata: { linkKind: SessionArtifactLinkKind.SessionEvidence } },
      ]);
    });
  }
);

type Fixture = {
  organizationId: string;
  userId: string;
  sessionId: string;
  documentId: string;
  documentSlug: string;
};

async function seed(): Promise<Fixture> {
  const organizationId = await tracker.create();
  organizationIds.push(organizationId);
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  const sessionId = await createTestSessionDetail({
    organizationId,
    userId: user.id,
    label: "evidence-links",
  });
  const documentSlug = generateSlug();
  const document = await withDb((db) =>
    db.artifact.create({
      data: {
        name: "Plan",
        slug: documentSlug,
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
    userId: user.id,
    sessionId,
    documentId: document.id,
    documentSlug,
  };
}

/** A UUID-only update the API recorded, and the claim that names it. */
async function syncRevision(
  fixture: Fixture,
  laterClaims: OperationClaim[] = []
): Promise<void> {
  await recordRevisionReceipt(fixture);
  await syncClaims(fixture, [revisionClaim(fixture), ...laterClaims]);
}

async function recordRevisionReceipt(fixture: Fixture): Promise<void> {
  await withDb((db) =>
    db.artifactOperationReceipt.create({
      data: {
        id: randomUUID(),
        organizationId: fixture.organizationId,
        principalUserId: fixture.userId,
        source: OperationSource.Mcp,
        operationKind: OperationKind.UpdateFields,
        targetArtifactId: fixture.documentId,
        outcome: OperationReceiptOutcome.Committed,
        changedFields: ["fileName"],
        clientCallId: "toolu_uuid_only",
        requestedAt: new Date("2026-10-16T12:00:01.000Z"),
        committedAt: new Date("2026-10-16T12:00:01.000Z"),
      },
    })
  );
}

function revisionClaim(fixture: Fixture): OperationClaim {
  return {
    claimKey: "claude:toolu_uuid_only",
    providerCallId: "toolu_uuid_only",
    source: OperationClaimSource.ClosedloopMcp,
    toolName: "update-document",
    operationKind: OperationKind.UpdateFields,
    resultState: ToolResultState.Present,
    inputTargets: [{ key: "documentId", uuid: fixture.documentId }],
    invokedAt: "2026-10-16T12:00:00.000Z",
    resultAt: "2026-10-16T12:00:05.000Z",
  };
}

async function syncClaims(
  fixture: Fixture,
  claims: OperationClaim[]
): Promise<void> {
  await persistClaims(fixture, claims);
  // Ingest syncs the links after the slice commits.
  await syncSessionEvidenceLinks(fixture.organizationId, [fixture.sessionId]);
}

/**
 * One ingest slice and its post-commit phase: the links are synced only for a
 * slice that wrote the session's snapshot, as `upsert-sessions-batch.ts` does.
 */
async function ingestClaims(
  fixture: Fixture,
  claims: OperationClaim[]
): Promise<void> {
  const persisted = await persistClaims(fixture, claims);
  await settleCommittedSessionEvidence(
    fixture.organizationId,
    persisted.snapshotWritten ? [fixture.sessionId] : [],
    persisted.bindingChangedSessionIds
  );
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
          digest: EVIDENCE_DIGEST,
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

async function linksSyncedDigest(fixture: Fixture): Promise<string | null> {
  const snapshot = await withDb((db) =>
    db.agentSessionOperationEvidenceSnapshot.findUniqueOrThrow({
      where: {
        agentSessionId: fixture.sessionId,
        organizationId: fixture.organizationId,
      },
      select: { linksSyncedDigest: true },
    })
  );
  return snapshot.linksSyncedDigest;
}

/** The document's resolved links, read as the fixture user. */
function resolvedLinks(fixture: Fixture) {
  return artifactLinksService.findResolvedLinksPage(
    fixture.organizationId,
    fixture.documentId,
    LinkDirection.Source,
    { skip: 0, take: 10 },
    undefined
  );
}

/** The document's tree-mode resolved links, read as the fixture user. */
function resolvedTree(fixture: Fixture, window: ResolvedLinkWindow) {
  return artifactLinksService.findResolvedLinkTreePage(
    fixture.organizationId,
    fixture.documentId,
    LinkDirection.Source,
    1,
    window,
    undefined
  );
}

/**
 * Stores the session link as the tree query's second page, so a read at that
 * offset is served from the page cache rather than a fresh traversal.
 */
async function cacheTreePage(fixture: Fixture): Promise<ResolvedLinkWindow> {
  const link = await withDb((db) =>
    db.artifactLink.findFirstOrThrow({
      where: { sourceId: fixture.sessionId, targetId: fixture.documentId },
      select: { id: true },
    })
  );
  await withDb((db) =>
    db.artifactLinkTreePage.create({
      data: {
        snapshotId: randomUUID(),
        offset: ARTIFACT_LINK_PAGE_SIZE,
        organizationId: fixture.organizationId,
        queryKey: JSON.stringify([
          fixture.documentId,
          LinkDirection.Source,
          1,
          null,
        ]),
        linkIds: [link.id],
        hasMore: false,
        expiresAt: new Date(Date.now() + 60_000),
      },
    })
  );
  return { skip: ARTIFACT_LINK_PAGE_SIZE, take: ARTIFACT_LINK_PAGE_SIZE + 1 };
}

function links(fixture: Fixture) {
  return withDb((db) =>
    db.artifactLink.findMany({
      where: {
        sourceId: fixture.sessionId,
        targetId: fixture.documentId,
        linkType: LinkType.RelatesTo,
      },
      select: { metadata: true },
    })
  );
}

/** A slug-lane output mention of the document, with no evidence behind it. */
async function persistOutputMention(fixture: Fixture): Promise<void> {
  await withDb.tx(
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
