/**
 * ISS-12552: `attribution-evidence-policy` is a
 * kill switch. Off equals main for an organization that was never on, and
 * turning it off must never wedge sync or delete evidence for an organization
 * that had it on. Every case drives the real Desktop sync route, its parse and
 * the ingest batch, with the organization's flag answer coming through the
 * real memoized gate.
 */
import { randomUUID } from "node:crypto";
import { Harness } from "@repo/api/src/types/agent-component";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { LinkType } from "@repo/api/src/types/artifact";
import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import {
  OPERATION_EVIDENCE_EXTRACTOR_VERSION,
  OperationClaimSource,
  ToolResultState,
} from "@repo/api/src/types/operation-claims";
import {
  ArtifactRefMethod,
  ArtifactRefTargetKind,
  roleFromMethod,
} from "@repo/api/src/types/session-artifact-link";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-pr-link-metadata";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { PARENT_AGENT_EXTERNAL_ID } from "@repo/api/src/types/token-event-agent-owner";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  desktopLaneRequest,
  seedOwnedComputeTarget,
} from "@/__tests__/support/desktop/desktop-sync-receipt.test-helpers";
import {
  createReceiptRouteHarness,
  receiptRouteParams,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";
import { receiptRouteState } from "@/__tests__/support/lib/operation-receipt-route.test-mocks";
import { createTestAuthContext } from "@/__tests__/utils/auth-helpers";
import type { AuthContext } from "@/lib/auth/with-auth";

const flag = vi.hoisted(() => ({ onClerkOrganizationIds: new Set<string>() }));
vi.mock(
  "@/lib/feature-flags/server-feature-flag-evaluation",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/feature-flags/server-feature-flag-evaluation")
    >()),
    evaluateServerFeatureFlagForOrganization: vi.fn(
      (_flag: unknown, clerkOrganizationId: string) =>
        Promise.resolve(flag.onClerkOrganizationIds.has(clerkOrganizationId))
    ),
  })
);
vi.mock("@/lib/auth/with-any-auth", async () =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteAuthMock()
);
vi.mock("@vercel/functions", async () =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteWaitUntilMock()
);

import { POST as syncSessions } from "@/app/desktop/agent-sessions/sync/route";
import { clearAttributionEvidenceGateMemo } from "@/lib/attribution-evidence-policy-feature";

const harness = createReceiptRouteHarness();
const SYNC_ROUTE = "/desktop/agent-sessions/sync";
const EXTERNAL_SESSION_ID = "iss12552-kill-switch";
const EXTERNAL_EVENT_ID = "iss12552-kill-switch-event";
const STARTED_AT = "2026-10-21T10:00:00.000Z";
const SLUG_METHOD = ArtifactRefMethod.SlugInBranch;

type World = Awaited<ReturnType<typeof seed>>;

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 attribution flag as a kill switch at Desktop sync",
  () => {
    afterEach(async () => {
      flag.onClerkOrganizationIds.clear();
      clearAttributionEvidenceGateMemo();
      await harness.cleanup();
    });

    it("never-on organization: stores main's rows from a flag-off Desktop and acks the batch", async () => {
      const world = await seed();

      const ack = await sync(world, session({ updatedAt: "11:00" }));

      expect(ack).toEqual({ status: 200, accepted: [EXTERNAL_SESSION_ID] });
      expect(await storedRows(world)).toEqual({
        owners: [null],
        evidenceRows: 0,
        snapshots: 0,
        links: [
          {
            targetId: world.documentId,
            linkType: LinkType.RelatesTo,
            metadata: {
              role: roleFromMethod(SLUG_METHOD, false),
              method: SLUG_METHOD,
              isPrimary: false,
            },
            lastContributedAt: new Date(at("11:00")),
          },
        ],
      });
    });

    it("on, then off: a resync with changed owners is acked, nothing wedges, and the evidence link stays", async () => {
      const world = await seed();
      turnOn(world);
      expect(
        (await sync(world, session({ owner: "agent-sub", updatedAt: "11:00" })))
          .accepted
      ).toEqual([EXTERNAL_SESSION_ID]);
      // What the evidence lane wrote while the flag was on.
      await seedEvidenceLink(world);
      turnOff();

      const changed = await sync(
        world,
        session({ owner: "agent-other", updatedAt: "12:00" })
      );
      const ownerless = await sync(world, session({ updatedAt: "13:00" }));

      expect([changed, ownerless]).toEqual([
        { status: 200, accepted: [EXTERNAL_SESSION_ID] },
        { status: 200, accepted: [EXTERNAL_SESSION_ID] },
      ]);
      const rows = await storedRows(world);
      expect(rows.owners).toEqual(["agent-sub"]);
      expect(rows.links).toContainEqual(
        expect.objectContaining({
          targetId: world.evidenceTargetId,
          metadata: { linkKind: SessionArtifactLinkKind.SessionEvidence },
        })
      );
    });

    it("lagging Desktop: owners and evidence sent while the server reads off are acked without a slice failure", async () => {
      const world = await seed();

      const acks = [
        await sync(
          world,
          session({ owner: "agent-sub", updatedAt: "11:00", evidence: true })
        ),
        await sync(
          world,
          session({ owner: "agent-other", updatedAt: "12:00", evidence: true })
        ),
        await sync(
          world,
          session({
            owner: PARENT_AGENT_EXTERNAL_ID,
            updatedAt: "13:00",
            evidence: true,
          })
        ),
      ];

      expect(acks).toEqual(
        Array.from({ length: 3 }, () => ({
          status: 200,
          accepted: [EXTERNAL_SESSION_ID],
        }))
      );
      const rows = await storedRows(world);
      expect(rows.owners).toEqual(["agent-sub"]);
      expect([rows.evidenceRows, rows.snapshots]).toEqual([0, 0]);
    });
  }
);

async function seed() {
  const world = await harness.seedWorld();
  const apiKeyContext = receiptRouteState.context as AuthContext;
  receiptRouteState.context = createTestAuthContext({
    user: apiKeyContext.user,
    authMethod: "session",
  });
  const computeTargetId = await seedOwnedComputeTarget(world);
  const documentId = await harness.seedDocument(world, "Kill switch target");
  const evidenceTargetId = await harness.seedDocument(
    world,
    "Kill switch evidence target"
  );
  const document = await withDb((db) =>
    db.artifact.findUniqueOrThrow({
      where: { id: documentId },
      select: { slug: true, organization: { select: { clerkId: true } } },
    })
  );
  if (!document.slug) {
    throw new Error("ISS-12552 kill-switch document has no slug");
  }
  return {
    ...world,
    computeTargetId,
    documentId,
    documentSlug: document.slug,
    evidenceTargetId,
    clerkOrganizationId: document.organization.clerkId,
  };
}

function turnOn(world: World): void {
  flag.onClerkOrganizationIds.add(world.clerkOrganizationId);
  clearAttributionEvidenceGateMemo();
}

function turnOff(): void {
  flag.onClerkOrganizationIds.clear();
  clearAttributionEvidenceGateMemo();
}

function at(time: string): string {
  return `2026-10-21T${time}:00.000Z`;
}

/** One session as a Desktop sends it; owner and evidence only when asked. */
function session(input: {
  updatedAt: string;
  owner?: string;
  evidence?: boolean;
}): (world: World) => SyncedAgentSession {
  return (world) => ({
    externalSessionId: EXTERNAL_SESSION_ID,
    name: "ISS-12552 kill switch",
    status: SESSION_STATUS.ACTIVE,
    harness: Harness.Claude,
    startedAt: STARTED_AT,
    updatedAt: at(input.updatedAt),
    agents: [],
    events: [],
    tokenUsageByModel: [],
    artifactRefs: [
      {
        kind: ArtifactRefTargetKind.ClosedloopArtifact,
        slug: world.documentSlug,
        isPrimary: false,
        method: SLUG_METHOD,
        observedAt: at(input.updatedAt),
      },
    ],
    tokenEvents: [
      {
        externalEventId: EXTERNAL_EVENT_ID,
        model: "claude-opus-4",
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 40,
        createdAt: STARTED_AT,
        ...(input.owner === undefined ? {} : { agentExternalId: input.owner }),
      },
    ],
    ...(input.evidence ? { operationEvidence: operationEvidence() } : {}),
  });
}

function operationEvidence(): SyncedAgentSession["operationEvidence"] {
  return {
    extractorVersion: OPERATION_EVIDENCE_EXTRACTOR_VERSION,
    digest: "d".repeat(64),
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
        claimKey: "claude:toolu_kill_switch",
        providerCallId: "toolu_kill_switch",
        source: OperationClaimSource.ClosedloopMcp,
        toolName: "get-document",
        operationKind: OperationKind.Read,
        resultState: ToolResultState.Present,
        invokedAt: STARTED_AT,
        resultAt: STARTED_AT,
      },
    ],
  };
}

async function sync(
  world: World,
  build: (world: World) => SyncedAgentSession
): Promise<{ status: number; accepted: string[] | undefined }> {
  const response = await syncSessions(
    desktopLaneRequest(SYNC_ROUTE, world.computeTargetId, {
      schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
      batchId: randomUUID(),
      syncMode: AgentSessionSyncMode.Incremental,
      sessionCount: 1,
      wantsAcceptedSessionIds: true,
      sessions: [build(world)],
    }),
    receiptRouteParams({})
  );
  const body = await response.json();
  return { status: response.status, accepted: body.data?.acceptedSessionIds };
}

/** The evidence-kind link the evidence lane writes (`writeEvidenceLinks`). */
async function seedEvidenceLink(world: World): Promise<void> {
  const sessionArtifactId = await sessionArtifact(world);
  await withDb((db) =>
    db.artifactLink.create({
      data: {
        organizationId: world.organizationId,
        sourceId: sessionArtifactId,
        targetId: world.evidenceTargetId,
        linkType: LinkType.RelatesTo,
        metadata: { linkKind: SessionArtifactLinkKind.SessionEvidence },
      },
      select: { id: true },
    })
  );
}

async function sessionArtifact(world: World): Promise<string> {
  const detail = await withDb((db) =>
    db.sessionDetail.findUniqueOrThrow({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId: world.computeTargetId,
          externalSessionId: EXTERNAL_SESSION_ID,
        },
      },
      select: { artifactId: true },
    })
  );
  return detail.artifactId;
}

async function storedRows(world: World) {
  const sessionArtifactId = await sessionArtifact(world);
  const [events, evidenceRows, snapshots, links] = await withDb((db) =>
    Promise.all([
      db.agentSessionTokenEvent.findMany({
        where: { agentSessionId: sessionArtifactId },
        select: { agentExternalId: true },
      }),
      db.agentSessionOperationEvidence.count({
        where: { agentSessionId: sessionArtifactId },
      }),
      db.agentSessionOperationEvidenceSnapshot.count({
        where: { agentSessionId: sessionArtifactId },
      }),
      db.artifactLink.findMany({
        where: {
          organizationId: world.organizationId,
          sourceId: sessionArtifactId,
        },
        orderBy: { targetId: "asc" },
        select: {
          targetId: true,
          linkType: true,
          metadata: true,
          lastContributedAt: true,
        },
      }),
    ])
  );
  return {
    owners: events.map((event) => event.agentExternalId),
    evidenceRows,
    snapshots,
    links,
  };
}
