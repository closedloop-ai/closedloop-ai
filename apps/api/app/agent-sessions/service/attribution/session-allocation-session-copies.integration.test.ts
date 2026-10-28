/**
 * ISS-12552 (PRD-800 "Proving usage"): records with the same owner,
 * harness and external session id are copies of one session synced from
 * several compute targets. A usage both copies hold is allocated once, to the
 * copy whose compute target id sorts first, matched by the external event id
 * every copy carries, whatever identity the event has. A usage only one copy
 * holds stays with that copy. Copies never tie, so they never fail as a
 * duplicate source.
 */
import {
  AttributionRelationshipKind,
  OperationEvidenceOutcome,
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
  UsageAssociationMethod,
} from "@repo/api/src/types/attribution-evidence";
import { DocumentStatus } from "@repo/api/src/types/document";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { requestKeyFor } from "@repo/lib/harness/request-key";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  asCopiesOfOneSession,
  type OwnedUsageOrg,
  type OwnedUsageSession,
  type OwnedUsageUnit,
  ownedUsageOrganization,
  sessionWithUsage,
} from "@/__tests__/support/agent-sessions/attribution/owned-usage.test-fixtures";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { generateSlug } from "@/app/documents/document-utils";
import {
  allocateSessionUsage,
  type SessionUsageAllocation,
} from "./session-allocation-service";

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: vi.fn(),
}));

const tracker = createCommittedTestOrganizationTracker();
const organizationIds: string[] = [];
/** Copies of one transcript start at the same instant. */
const STARTED = new Date("2026-10-19T10:00:00.000Z");
const CODEX_SCHEME = "codex.response";
const REQUEST_SCHEME = "test.request";

describe.skipIf(!keys().DATABASE_URL)("ISS-12552 copies of one session", () => {
  afterEach(async () => {
    await withDb((db) =>
      db.artifactOperationReceipt.deleteMany({
        where: { organizationId: { in: organizationIds.splice(0) } },
      })
    );
    await tracker.cleanup();
  });

  it("allocates a Claude usage both copies hold once, to the canonical copy, and keeps each copy's own entries", async () => {
    const org = await organization();
    const [canonical, other] = await copies(org, [
      [
        unit("shared-1", 100n),
        unit("shared-2", 200n),
        unit("only-canonical", 7n),
      ],
      [unit("shared-1", 100n), unit("shared-2", 200n), unit("only-other", 30n)],
    ]);

    expect(await allocatedTokens(canonical)).toBe(307);
    expect(await allocatedTokens(other)).toBe(30);
  });

  it("allocates a Codex usage both copies hold once, by the event id both carry", async () => {
    const org = await organization();
    const units: OwnedUsageUnit[] = [
      unit("resp_1", 400n, { scheme: CODEX_SCHEME }),
      unit("resp_2", 50n, { scheme: CODEX_SCHEME }),
    ];
    const [canonical, other] = await copies(org, [units, units], "codex");

    expect(await allocatedTokens(canonical)).toBe(450);
    expect(await allocatedTokens(other)).toBe(0);
  });

  it("allocates a legacy usage with no identity once, by the event id both carry", async () => {
    const org = await organization();
    const units: OwnedUsageUnit[] = [
      unit("l1", 60n, { unavailable: true }),
      unit("l2", 40n, { unavailable: true }),
    ];
    const [canonical, other] = await copies(org, [units, units]);

    expect(await allocatedTokens(canonical)).toBe(100);
    expect(await allocatedTokens(other)).toBe(0);
  });

  it("allocates a usage once when one copy carries identities and the other none", async () => {
    const org = await organization();
    const [canonical, other] = await copies(org, [
      [unit("m1", 80n), unit("m2", 20n)],
      [
        unit("m1", 80n, { unavailable: true }),
        unit("m2", 20n, { unavailable: true }),
      ],
    ]);

    expect(await allocatedTokens(canonical)).toBe(100);
    expect(await allocatedTokens(other)).toBe(0);
  });

  it("proves a request's usage the canonical copy holds by the receipt the other copy holds, once, and conserves", async () => {
    const org = await organization();
    const request = unit("req-1", 100n, { scheme: REQUEST_SCHEME });
    const [canonical, other] = await copies(org, [[request], [request]]);
    const documentId = await receiptedWrite(org, other, "req-1");

    const results: SessionUsageAllocation[] = [];
    for (const session of [canonical, other]) {
      const result = await allocateSessionUsage(session);
      if (!result.ok) {
        throw new Error(`allocation failed: ${result.error.kind}`);
      }
      results.push(result.value);
    }

    const proven = results.flatMap((result) =>
      result.proofs.map((proof) => [proof.recipientKey, proof.method])
    );
    expect(proven).toEqual([
      [documentId, UsageAssociationMethod.RequestReceipt],
    ]);
    for (const { allocation } of results) {
      const shared = allocation.recipients.reduce(
        (sum, share) => sum + share.provenTokens + share.estimatedTokens,
        0
      );
      expect(shared + allocation.unattributedTokens).toBe(
        allocation.totalTokens
      );
    }
    expect(results.map((result) => result.allocation.totalTokens)).toEqual([
      100, 0,
    ]);
  });

  it("gives the canonical copy the usage whichever copy synced first", async () => {
    const org = await organization();
    const shared: OwnedUsageUnit[] = [unit("shared-1", 90n)];
    const first = await sessionWithUsage(org, "first", STARTED, shared);
    const alone = await allocatedTokens(first);
    const second = await sessionWithUsage(org, "second", STARTED, shared);
    // The copy that synced second is the canonical one.
    await asCopiesOfOneSession([second, first]);

    expect(alone).toBe(90);
    expect(await allocatedTokens(second)).toBe(90);
    expect(await allocatedTokens(first)).toBe(0);
  });
});

async function organization(): Promise<OwnedUsageOrg> {
  const org = await ownedUsageOrganization(tracker);
  organizationIds.push(org.id);
  return org;
}

/** Two copies of one session, the first canonical, each holding its units. */
async function copies(
  org: OwnedUsageOrg,
  [a, b]: [OwnedUsageUnit[], OwnedUsageUnit[]],
  harness = "claude"
): Promise<[OwnedUsageSession, OwnedUsageSession]> {
  const canonical = await sessionWithUsage(org, "copy-a", STARTED, a);
  const other = await sessionWithUsage(org, "copy-b", STARTED, b);
  await asCopiesOfOneSession([canonical, other], harness);
  return [canonical, other];
}

async function allocatedTokens(session: OwnedUsageSession): Promise<number> {
  const result = await allocateSessionUsage(session);
  if (!result.ok) {
    throw new Error(`allocation failed: ${result.error.kind}`);
  }
  return result.value.allocation.totalTokens;
}

/**
 * One token event as a Desktop syncs it: its external id derives from the
 * transcript's session id and the event's content, so every copy carries it.
 */
function unit(
  uuid: string,
  input: bigint,
  extra: Pick<OwnedUsageUnit, "scheme" | "unavailable"> = {}
): OwnedUsageUnit {
  return { uuid, input, eventId: `token-event-${uuid}`, ...extra };
}

/**
 * A committed revision of a new document whose receipt the session holds,
 * joined to the request its call came from, as sync binds it.
 */
async function receiptedWrite(
  org: OwnedUsageOrg,
  session: OwnedUsageSession,
  requestId: string
): Promise<string> {
  return await withDb(async (db) => {
    const document = await db.artifact.create({
      data: {
        name: "Plan",
        slug: generateSlug(),
        type: ArtifactType.DOCUMENT,
        subtype: ArtifactSubtype.PRD,
        status: DocumentStatus.Draft,
        organizationId: org.id,
        createdById: org.userId,
      },
      select: { id: true },
    });
    const receipt = await db.artifactOperationReceipt.create({
      data: {
        organizationId: org.id,
        principalUserId: org.userId,
        source: OperationSource.Mcp,
        operationKind: OperationKind.UpdateFields,
        targetArtifactId: document.id,
        outcome: OperationReceiptOutcome.Committed,
        changedFields: ["title"],
        requestedAt: STARTED,
        committedAt: STARTED,
      },
      select: { id: true },
    });
    await db.agentSessionOperationEvidence.create({
      data: {
        organizationId: org.id,
        agentSessionId: session.agentSessionId,
        claimKey: "claude:toolu_write",
        receiptId: receipt.id,
        targetArtifactId: document.id,
        relationshipKind: AttributionRelationshipKind.Revision,
        outcome: OperationEvidenceOutcome.Committed,
        operationKind: OperationKind.UpdateFields,
        source: OperationSource.Mcp,
        invokedAt: STARTED,
        anchors: { requestKey: requestKeyFor(REQUEST_SCHEME, requestId) },
        extractorVersion: 1,
        policyVersion: 1,
      },
      select: { id: true },
    });
    return document.id;
  });
}
