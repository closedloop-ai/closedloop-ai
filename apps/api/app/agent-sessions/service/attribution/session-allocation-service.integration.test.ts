/**
 * ISS-12552: a session's allocation against a real Postgres,
 * from stored token events, evidence rows and activity segments.
 */
import { ACTIVITY_PHASE } from "@repo/api/src/types/activity-phase";
import {
  AttributionRelationshipKind,
  OperationEvidenceOutcome,
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
  UsageAssociationMethod,
} from "@repo/api/src/types/attribution-evidence";
import { BranchStatus } from "@repo/api/src/types/branch";
import { DocumentStatus } from "@repo/api/src/types/document";
import { GitHubPRState } from "@repo/api/src/types/github";
import { TokenSourceIdentityAvailability } from "@repo/api/src/types/token-cost-provenance";
import { ArtifactSubtype, ArtifactType, Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { ReconciliationFailureKind } from "@repo/lib/allocation/allocate-usage";
import { requestKeyFor } from "@repo/lib/harness/request-key";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { generateSlug } from "@/app/documents/document-utils";
import {
  ALLOCATION_RECONCILIATION_FAILED_METRIC,
  allocateSessionUsage,
} from "./session-allocation-service";

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: vi.fn(),
}));

const tracker = createCommittedTestOrganizationTracker();
const MODEL = "claude-sonnet-4-20250514";
const UNPRICEABLE_MODEL = "not-a-real-model";
const START = Date.parse("2026-10-16T12:00:00.000Z");
const SECOND = 1000;
const receiptOrganizations: string[] = [];

describe.skipIf(!keys().DATABASE_URL)("ISS-12552 session allocation", () => {
  afterEach(async () => {
    const ids = receiptOrganizations.splice(0);
    await withDb((db) =>
      db.artifactOperationReceipt.deleteMany({
        where: { organizationId: { in: ids } },
      })
    );
    await tracker.cleanup();
  });

  it("proves usage by phase run and work item ref, splits the rest, and keeps the stored cost", async () => {
    const fixture = await seed();
    await tokenEvents(fixture, [
      { id: "in-plan", atSeconds: 10, input: 1000n, cost: "0.003000" },
      { id: "in-implement", atSeconds: 150, input: 3000n, cost: "0.009000" },
      { id: "unsegmented", atSeconds: 250, input: 1000n, cost: "0.003000" },
    ]);

    const result = await allocateSessionUsage(fixture);
    if (!result.ok) {
      throw new Error(`allocation failed: ${result.error.kind}`);
    }

    expect(
      result.value.proofs.map((proof) => [
        proof.sourceKey,
        proof.recipientKey,
        proof.method,
      ])
    ).toEqual([
      [
        "test:in-plan#input",
        fixture.documentId,
        UsageAssociationMethod.AgentPhaseRun,
      ],
      [
        "test:in-implement#input",
        fixture.branchId,
        UsageAssociationMethod.WorkItemRef,
      ],
    ]);
    expect(result.value.allocation.recipients).toEqual(
      [
        {
          recipientKey: fixture.branchId,
          provenTokens: 3000,
          estimatedTokens: 750,
        },
        {
          recipientKey: fixture.documentId,
          provenTokens: 1000,
          estimatedTokens: 250,
        },
      ].sort((left, right) => (left.recipientKey < right.recipientKey ? -1 : 1))
    );
    const { priced } = result.value;
    expect(
      priced?.recipients.reduce(
        (sum, share) => sum + share.provenMicros + share.estimatedMicros,
        priced.unattributedMicros
      )
    ).toBe(15_000);
  });

  it("proves a receipted write's own request, and lets no phase run reach past it (PRD-800)", async () => {
    const fixture = await seed();
    await tokenEvents(fixture, [
      { id: "in-plan", atSeconds: 10, input: 1000n, cost: "0.003000" },
      { id: "in-implement", atSeconds: 150, input: 3000n, cost: "0.009000" },
      { id: "unsegmented", atSeconds: 250, input: 1000n, cost: "0.003000" },
    ]);
    await receiptTheCreate(fixture, requestKeyFor("test", "unsegmented"));

    const result = await allocateSessionUsage(fixture);
    if (!result.ok) {
      throw new Error(`allocation failed: ${result.error.kind}`);
    }

    expect(
      result.value.proofs.map((proof) => [
        proof.sourceKey,
        proof.recipientKey,
        proof.method,
      ])
    ).toEqual([
      [
        "test:in-implement#input",
        fixture.branchId,
        UsageAssociationMethod.WorkItemRef,
      ],
      [
        "test:unsegmented#input",
        fixture.documentId,
        UsageAssociationMethod.RequestReceipt,
      ],
    ]);
  });

  it("allocates an unpriced event's tokens, prices only the priced ones, and reports the allocated per-event cost and its gap to the session's cost (PRD-800)", async () => {
    const fixture = await seed();
    await tokenEvents(fixture, [
      { id: "in-plan", atSeconds: 10, input: 1000n, cost: "0.003000" },
      { id: "in-implement", atSeconds: 150, input: 3000n, cost: null },
      { id: "unsegmented", atSeconds: 250, input: 1000n, cost: "0.003000" },
    ]);
    await withDb((db) =>
      db.sessionDetail.update({
        where: { artifactId: fixture.agentSessionId },
        data: { estimatedCost: new Prisma.Decimal("0.010000") },
        select: { artifactId: true },
      })
    );

    const result = await allocateSessionUsage(fixture);
    if (!result.ok) {
      throw new Error(`allocation failed: ${result.error.kind}`);
    }

    expect(result.value.allocation.totalTokens).toBe(5000);
    expect(result.value.coverage).toEqual({
      unpricedTokens: 3000,
      allocatedCostMicros: 6000,
      sessionCostGapMicros: 4000,
      uniformRate: { tokens: 0, micros: 0 },
    });
    const { priced } = result.value;
    expect(priced?.totalMicros).toBe(6000);
    expect(
      priced?.recipients.reduce(
        (sum, share) => sum + share.provenMicros + share.estimatedMicros,
        priced.unattributedMicros
      )
    ).toBe(6000);
  });

  it.each([
    ["the engine prices", MODEL],
    ["the engine cannot price", UNPRICEABLE_MODEL],
  ])(
    "gives no dollars to usage proven only on unpriced tokens, on a model %s (PRD-800 'Unpriced usage')",
    async (_label, model) => {
      const fixture = await seed();
      await tokenEvents(fixture, [
        { id: "in-plan", atSeconds: 10, input: 1000n, cost: "0.003000", model },
        { id: "in-implement", atSeconds: 150, input: 3000n, cost: null, model },
      ]);

      const result = await allocateSessionUsage(fixture);
      if (!result.ok) {
        throw new Error(`allocation failed: ${result.error.kind}`);
      }

      const { allocation, priced } = result.value;
      const share = (recipientKey: string) =>
        priced?.recipients.find((entry) => entry.recipientKey === recipientKey);
      expect(
        allocation.recipients.find(
          (entry) => entry.recipientKey === fixture.branchId
        )?.provenTokens
      ).toBe(3000);
      expect(share(fixture.branchId)).toEqual({
        recipientKey: fixture.branchId,
        provenMicros: 0,
        estimatedMicros: 0,
      });
      expect(share(fixture.documentId)).toEqual({
        recipientKey: fixture.documentId,
        provenMicros: 3000,
        estimatedMicros: 0,
      });
      expect(priced?.unattributedMicros).toBe(0);
    }
  );

  it("allocates tokens with no cost, never a zero cost, when no event is priced", async () => {
    const fixture = await seed();
    await tokenEvents(fixture, [
      { id: "in-plan", atSeconds: 10, input: 1000n, cost: null },
      { id: "unsegmented", atSeconds: 250, input: 500n, cost: null },
    ]);

    const result = await allocateSessionUsage(fixture);
    if (!result.ok) {
      throw new Error(`allocation failed: ${result.error.kind}`);
    }

    expect(result.value.allocation.totalTokens).toBe(1500);
    expect(result.value.priced).toBeNull();
    expect(result.value.coverage).toEqual({
      unpricedTokens: 1500,
      allocatedCostMicros: null,
      sessionCostGapMicros: null,
      uniformRate: { tokens: 0, micros: 0 },
    });
  });

  it("returns a duplicated source event as a reconciliation failure and logs it", async () => {
    const fixture = await seed();
    await tokenEvents(fixture, [
      {
        id: "copy-a",
        atSeconds: 10,
        input: 10n,
        cost: "0.000030",
        source: "shared",
      },
      {
        id: "copy-b",
        atSeconds: 11,
        input: 10n,
        cost: "0.000030",
        source: "shared",
      },
    ]);

    const result = await allocateSessionUsage(fixture);

    expect(!result.ok && result.error.kind).toBe(
      ReconciliationFailureKind.DuplicateSource
    );
    expect(emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: ALLOCATION_RECONCILIATION_FAILED_METRIC,
        level: "warn",
        status: "warn",
        organizationId: fixture.organizationId,
        agentSessionId: fixture.agentSessionId,
        failureKind: ReconciliationFailureKind.DuplicateSource,
        sourceKey: "test:shared#input",
        priceKey: MODEL,
      })
    );
  });

  it.each([
    ["negative", "-0.001000"],
    ["not a number", "NaN"],
  ])(
    "fails as an invalid price on a %s per-event cost its bucket would otherwise net away (PRD-800)",
    async (_label, badCost) => {
      const fixture = await seed();
      await tokenEvents(fixture, [
        { id: "priced", atSeconds: 10, input: 1000n, cost: "0.005000" },
        { id: "impossible", atSeconds: 11, input: 10n, cost: "0.000001" },
      ]);
      await withDb(
        (db) => db.$executeRaw`
        UPDATE agent_session_token_events SET estimated_cost = ${badCost}::numeric
        WHERE agent_session_id = ${fixture.agentSessionId}::uuid
          AND external_event_id = 'impossible'`
      );

      const result = await allocateSessionUsage(fixture);

      expect(!result.ok && result.error).toEqual({
        kind: ReconciliationFailureKind.InvalidPrice,
        sourceKey: "event:impossible",
        priceKey: MODEL,
      });
      expect(emitTelemetryMetric).toHaveBeenCalledWith(
        expect.objectContaining({
          metric: ALLOCATION_RECONCILIATION_FAILED_METRIC,
          failureKind: ReconciliationFailureKind.InvalidPrice,
          agentSessionId: fixture.agentSessionId,
        })
      );
    }
  );

  it("resolves a pull request ref only through an implemented branch's canonical pull request", async () => {
    const fixture = await seed();
    const strangerBranchId = await branchWithPullRequest(
      fixture,
      "acme/app",
      8
    );
    await branchWithPullRequest(fixture, "acme/app", 7, fixture.branchId);
    await withDb((db) =>
      db.agentSessionActivitySegment.createMany({
        data: [
          segmentRow(
            fixture.agentSessionId,
            ACTIVITY_PHASE.Implement,
            300,
            400,
            "Acme/App#7"
          ),
          segmentRow(
            fixture.agentSessionId,
            ACTIVITY_PHASE.Idle,
            400,
            500,
            null
          ),
          segmentRow(
            fixture.agentSessionId,
            ACTIVITY_PHASE.Implement,
            500,
            600,
            "acme/app#8"
          ),
        ],
      })
    );
    await tokenEvents(fixture, [
      { id: "own-pr", atSeconds: 350, input: 10n, cost: "0.000030" },
      { id: "stranger-pr", atSeconds: 550, input: 10n, cost: "0.000030" },
    ]);

    const result = await allocateSessionUsage(fixture);

    expect(strangerBranchId).not.toBe(fixture.branchId);
    expect(
      result.ok &&
        result.value.proofs.map((proof) => [
          proof.sourceKey,
          proof.recipientKey,
        ])
    ).toEqual([["test:own-pr#input", fixture.branchId]]);
  });

  it("reads only the session's own organization", async () => {
    const fixture = await seed();
    await tokenEvents(fixture, [
      { id: "own", atSeconds: 10, input: 10n, cost: "0.000030" },
    ]);
    const otherOrganizationId = await tracker.create();

    const result = await allocateSessionUsage({
      organizationId: otherOrganizationId,
      agentSessionId: fixture.agentSessionId,
    });

    expect(result.ok && result.value.allocation.totalTokens).toBe(0);
  });
});

type Fixture = {
  organizationId: string;
  agentSessionId: string;
  documentId: string;
  branchId: string;
};

async function seed(): Promise<Fixture> {
  const organizationId = await tracker.create();
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  const agentSessionId = await createTestSessionDetail({
    organizationId,
    userId: user.id,
    label: "allocation",
  });
  const { documentId, branchId } = await withDb(async (db) => {
    const document = await db.artifact.create({
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
    });
    const branch = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: "branch-feat-x",
        status: BranchStatus.Open,
        createdById: user.id,
      },
      select: { id: true },
    });
    return { documentId: document.id, branchId: branch.id };
  });
  await withDb((db) =>
    db.agentSessionOperationEvidence.createMany({
      data: [
        {
          organizationId,
          agentSessionId,
          claimKey: "claude:toolu_create",
          targetArtifactId: documentId,
          relationshipKind: AttributionRelationshipKind.Creation,
          outcome: OperationEvidenceOutcome.Committed,
          operationKind: OperationKind.Create,
          source: OperationSource.Mcp,
          invokedAt: new Date(START + 50 * SECOND),
          extractorVersion: 1,
          policyVersion: 1,
        },
        {
          organizationId,
          agentSessionId,
          claimKey: "implementation:acme/app:feat/x",
          targetArtifactId: branchId,
          relationshipKind: AttributionRelationshipKind.Implementation,
          outcome: OperationEvidenceOutcome.Committed,
          operationKind: OperationKind.Unsupported,
          source: OperationSource.Repository,
          anchors: {
            repositoryOutput: { repository: "acme/app", headRef: "feat/x" },
          },
          extractorVersion: 0,
          policyVersion: 1,
        },
      ],
    })
  );
  await withDb((db) =>
    db.agentSessionActivitySegment.createMany({
      data: [
        segmentRow(agentSessionId, ACTIVITY_PHASE.Plan, 0, 100, null),
        segmentRow(
          agentSessionId,
          ACTIVITY_PHASE.Implement,
          100,
          200,
          "feat/x"
        ),
      ],
    })
  );
  return { organizationId, agentSessionId, documentId, branchId };
}

/** A branch (created unless given) whose canonical pull request is `repository#number`. */
async function branchWithPullRequest(
  fixture: Fixture,
  repositoryFullName: string,
  number: number,
  existingBranchId?: string
): Promise<string> {
  return await withDb(async (db) => {
    const branchId =
      existingBranchId ??
      (
        await db.artifact.create({
          data: {
            organizationId: fixture.organizationId,
            type: ArtifactType.BRANCH,
            name: `branch-${number}`,
            status: BranchStatus.Open,
          },
          select: { id: true },
        })
      ).id;
    await db.branchDetail.create({
      data: {
        artifactId: branchId,
        organizationId: fixture.organizationId,
        repositoryFullName,
        branchName: `feat/pr-${number}`,
      },
      select: { artifactId: true },
    });
    const pullRequest = await db.pullRequestDetail.create({
      data: {
        organizationId: fixture.organizationId,
        branchArtifactId: branchId,
        number,
        repositoryFullName,
        prState: GitHubPRState.Open,
        isDraft: false,
        lastVerifiedAt: new Date(START),
      },
      select: { id: true },
    });
    await db.branchDetail.update({
      where: { artifactId: branchId },
      data: { currentPullRequestDetailId: pullRequest.id },
      select: { artifactId: true },
    });
    return branchId;
  });
}

function segmentRow(
  agentSessionId: string,
  phase: string,
  startSeconds: number,
  endSeconds: number,
  workItemRef: string | null
) {
  return {
    agentSessionId,
    phase,
    startMs: BigInt(START + startSeconds * SECOND),
    endMs: BigInt(START + endSeconds * SECOND),
    confidence: 1,
    evidenceLayers: [],
    classifierVersion: 1,
    workItemRef,
  };
}

async function tokenEvents(
  fixture: Fixture,
  events: {
    id: string;
    atSeconds: number;
    input: bigint;
    cost: string | null;
    source?: string;
    model?: string;
  }[]
): Promise<void> {
  await withDb((db) =>
    db.agentSessionTokenEvent.createMany({
      data: events.map((event) => ({
        agentSessionId: fixture.agentSessionId,
        externalEventId: event.id,
        model: event.model ?? MODEL,
        inputTokens: event.input,
        estimatedCost:
          event.cost === null ? null : new Prisma.Decimal(event.cost),
        sourceIdentity: {
          availability: TokenSourceIdentityAvailability.Available,
          scheme: "test",
          sourceRecordIds: [event.source ?? event.id],
        },
        eventCreatedAt: new Date(START + event.atSeconds * SECOND),
      })),
    })
  );
}

/** Binds the seeded create to a receipt, naming the request that issued it. */
async function receiptTheCreate(
  fixture: Fixture,
  requestKey: string
): Promise<void> {
  receiptOrganizations.push(fixture.organizationId);
  await withDb(async (db) => {
    const session = await db.artifact.findUniqueOrThrow({
      where: { id: fixture.agentSessionId },
      select: { createdById: true },
    });
    const receipt = await db.artifactOperationReceipt.create({
      data: {
        organizationId: fixture.organizationId,
        principalUserId: session.createdById ?? "",
        source: OperationSource.Mcp,
        operationKind: OperationKind.Create,
        createdArtifactId: fixture.documentId,
        outcome: OperationReceiptOutcome.Committed,
        clientCallId: "toolu_create",
        requestedAt: new Date(START + 50 * SECOND),
        committedAt: new Date(START + 50 * SECOND),
      },
      select: { id: true },
    });
    await db.agentSessionOperationEvidence.updateMany({
      where: {
        organizationId: fixture.organizationId,
        agentSessionId: fixture.agentSessionId,
        claimKey: "claude:toolu_create",
      },
      data: { receiptId: receipt.id, anchors: { requestKey } },
    });
  });
}
