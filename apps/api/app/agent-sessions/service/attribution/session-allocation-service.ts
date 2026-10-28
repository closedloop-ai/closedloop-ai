/**
 * ISS-12552: one session's usage and cost allocated across
 * the artifacts it wrote and the branches it implemented, by the shared
 * kernel, before any listing filter (AC-020). Computed on read, never stored.
 *
 * Tokens are allocated for every event and cost only for events with a stored
 * cost; unpriced tokens and the gap between the allocated cost and the
 * session's own stored cost are reported as coverage, never folded into the
 * shares (PRD-800; Daveth Oakhurst, 2026-10-20). A reconciliation
 * failure (a duplicate source event, a source usage two of the owner's
 * sessions that started together both hold, proven usage above the measured
 * total, an impossible price) is logged naming the session and bucket and
 * returned as the failure, never as a number. Callers in this PR are the comparison report and
 * the golden Layer 3 and Layer 5 tests; card adoption is follow-up work.
 */
import { AttributionRelationshipKind } from "@repo/api/src/types/attribution-evidence";
import { Result } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";
import {
  type Allocation,
  allocateUsage,
  type ReconciliationFailure,
  ReconciliationFailureKind,
} from "@repo/lib/allocation/allocate-usage";
import {
  type PricedAllocation,
  priceAllocation,
} from "@repo/lib/allocation/price-allocation";
import {
  type AllocationEvidence,
  branchRecipientsByName,
  recipientsAndOperations,
  usageObservations,
  withoutUsageOwnedElsewhere,
} from "@repo/lib/attribution/allocation-inputs";
import {
  type AssociationSegment,
  associateUsage,
  type UsageProof,
} from "@repo/lib/attribution/associate-usage";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import {
  type AllocationTokenEvent,
  allocationPriceKey,
  categoryPricer,
  MICROS_PER_USD,
  sessionTotalMicros,
  uniformRateUsage,
  unpricedTokens,
} from "./session-allocation-inputs";
import { readUsageOwnedElsewhere } from "./session-allocation-owned-usage";
import {
  canonicalPullRequestRefs,
  pullRequestRefKey,
} from "./session-allocation-pull-requests";

export const ALLOCATION_RECONCILIATION_FAILED_METRIC =
  "agent_sessions.attribution.allocation_reconciliation_failed";

/** Rows per token-event page; the read follows pages to the end. */
const TOKEN_EVENT_PAGE_SIZE = 5000;
const PULL_REQUEST_REF_RE = /^(.+)#(\d+)$/;
const SLUG_REF_RE = /^[A-Z]+-\d+$/;

export type SessionUsageAllocation = {
  allocation: Allocation;
  /** Null, never zero, when no event has a stored cost. */
  priced: PricedAllocation | null;
  proofs: UsageProof[];
  coverage: SessionAllocationCoverage;
};

export type SessionAllocationCoverage = {
  /** Tokens allocated with no cost, from events with no stored cost. */
  unpricedTokens: number;
  /**
   * Events with a stored cost whose model the engine cannot price per
   * category, which the pricer prices at a per-model uniform rate.
   */
  uniformRate: { tokens: number; micros: number };
  /**
   * The allocated per-event cost in micro-dollars, the contract's
   * `allocatedCostMicros`; null, never zero, when no event is priced.
   */
  allocatedCostMicros: number | null;
  /**
   * `session_detail.estimated_cost` minus the allocated per-event cost, in
   * micro-dollars; null when either is unknown.
   */
  sessionCostGapMicros: number | null;
};

export async function allocateSessionUsage(input: {
  organizationId: string;
  agentSessionId: string;
}): Promise<Result<SessionUsageAllocation, ReconciliationFailure>> {
  const [storedEvents, evidence, segments] = await Promise.all([
    readTokenEvents(input),
    readEvidence(input),
    readSegments(input),
  ]);
  const elsewhere = await readUsageOwnedElsewhere(input, storedEvents);
  const [ambiguousSource] = [...elsewhere.ambiguous].sort();
  if (ambiguousSource !== undefined) {
    return reportFailure(input, {
      kind: ReconciliationFailureKind.AmbiguousSource,
      sourceKey: ambiguousSource,
    });
  }
  const events = withoutUsageOwnedElsewhere(storedEvents, elsewhere.owned);
  const invalidPrice = invalidEventPrice(events);
  if (invalidPrice) {
    return reportFailure(input, invalidPrice);
  }
  const { recipients, operations } = recipientsAndOperations(evidence);
  const recipientSet = new Set(recipients);
  const workItemRecipients = await resolveWorkItemRefs(
    input.organizationId,
    segments,
    evidence,
    recipientSet
  );
  const units = usageObservations(events, allocationPriceKey);
  const proofs = associateUsage({
    units,
    segments,
    operations,
    workItemRecipients,
  });
  const allocation = allocateUsage({ units, recipients, provenBy: proofs });
  if (!allocation.ok) {
    return reportFailure(input, allocation.error);
  }
  const totalMicros = sessionTotalMicros(events);
  const priced =
    totalMicros === null
      ? null
      : priceAllocation(allocation.value, categoryPricer(events), totalMicros);
  if (priced && !priced.ok) {
    return reportFailure(input, priced.error);
  }
  const storedMicros = await readSessionCostMicros(input);
  return Result.ok({
    allocation: allocation.value,
    priced: priced?.value ?? null,
    proofs,
    coverage: {
      unpricedTokens: unpricedTokens(events),
      uniformRate: uniformRateUsage(events),
      allocatedCostMicros: totalMicros,
      sessionCostGapMicros:
        storedMicros === null || totalMicros === null
          ? null
          : storedMicros - totalMicros,
    },
  });
}

function reportFailure(
  session: { organizationId: string; agentSessionId: string },
  failure: ReconciliationFailure
): Result<never, ReconciliationFailure> {
  emitTelemetryMetric({
    metric: ALLOCATION_RECONCILIATION_FAILED_METRIC,
    level: "warn",
    status: "warn",
    organizationId: session.organizationId,
    agentSessionId: session.agentSessionId,
    failureKind: failure.kind,
    ...(failure.sourceKey ? { sourceKey: failure.sourceKey } : {}),
    ...(failure.recipientKey ? { recipientKey: failure.recipientKey } : {}),
    ...(failure.priceKey ? { priceKey: failure.priceKey } : {}),
    ...(failure.category ? { category: failure.category } : {}),
    count: 1,
  });
  return Result.err(failure);
}

/** The session's own stored cost in micro-dollars, or null. */
async function readSessionCostMicros(session: {
  organizationId: string;
  agentSessionId: string;
}): Promise<number | null> {
  const detail = await withDb((db) =>
    db.sessionDetail.findFirst({
      where: {
        artifactId: session.agentSessionId,
        artifact: { organizationId: session.organizationId },
      },
      select: { estimatedCost: true },
    })
  );
  return detail?.estimatedCost
    ? Number(detail.estimatedCost.mul(MICROS_PER_USD).toFixed(0))
    : null;
}

async function readTokenEvents(session: {
  organizationId: string;
  agentSessionId: string;
}): Promise<AllocationTokenEvent[]> {
  const events: AllocationTokenEvent[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await withDb((db) =>
      db.agentSessionTokenEvent.findMany({
        where: {
          agentSessionId: session.agentSessionId,
          session: { artifact: { organizationId: session.organizationId } },
        },
        orderBy: { id: "asc" },
        take: TOKEN_EVENT_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          externalEventId: true,
          agentExternalId: true,
          model: true,
          inputTokens: true,
          outputTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
          estimatedCost: true,
          sourceIdentity: true,
          eventCreatedAt: true,
        },
      })
    );
    events.push(...page);
    cursor = page.at(-1)?.id;
    if (page.length < TOKEN_EVENT_PAGE_SIZE) {
      return events;
    }
  }
}

/**
 * The evidence of the logical session: this record and every copy of it (the
 * same owner, harness and external session id, synced from another compute
 * target). The request-to-receipt join reads it whole, so a receipt
 * one copy holds proves the usage the other copy holds; each usage is still
 * allocated once, to the copy that owns it. Only one copy's row holds a
 * receipt, so a write is never counted twice.
 */
async function readEvidence(session: {
  organizationId: string;
  agentSessionId: string;
}): Promise<AllocationEvidence[]> {
  const sessionIds = await logicalSessionRecords(session);
  return await withDb((db) =>
    db.agentSessionOperationEvidence.findMany({
      where: {
        organizationId: session.organizationId,
        agentSessionId: { in: sessionIds },
        targetArtifactId: { not: null },
        relationshipKind: {
          in: [
            AttributionRelationshipKind.Creation,
            AttributionRelationshipKind.Revision,
            AttributionRelationshipKind.Implementation,
          ],
        },
      },
      select: {
        targetArtifactId: true,
        relationshipKind: true,
        agentId: true,
        invokedAt: true,
        effectiveAt: true,
        receiptId: true,
        anchors: true,
      },
    })
  );
}

async function readSegments(session: {
  organizationId: string;
  agentSessionId: string;
}): Promise<AssociationSegment[]> {
  const rows = await withDb((db) =>
    db.agentSessionActivitySegment.findMany({
      where: {
        agentSessionId: session.agentSessionId,
        session: { artifact: { organizationId: session.organizationId } },
      },
      select: {
        phase: true,
        startMs: true,
        endMs: true,
        workItemRef: true,
        subagentId: true,
      },
    })
  );
  return rows.map((row) => ({
    agentId: row.subagentId,
    phase: row.phase,
    startMs: Number(row.startMs),
    endMs: Number(row.endMs),
    workItemRef: row.workItemRef,
  }));
}

/**
 * A segment's work item ref is a ClosedLoop slug, `owner/repo#number` for a
 * pull request (through its branch's canonical pull request), or a branch
 * name. Each resolves only to a recipient.
 */
async function resolveWorkItemRefs(
  organizationId: string,
  segments: readonly AssociationSegment[],
  evidence: readonly AllocationEvidence[],
  recipients: ReadonlySet<string>
): Promise<Map<string, string>> {
  const refs = [
    ...new Set(segments.flatMap((segment) => segment.workItemRef ?? [])),
  ];
  const slugs = refs.filter((ref) => SLUG_REF_RE.test(ref));
  const [artifacts, pullRequestRefs] = await Promise.all([
    slugs.length === 0
      ? []
      : withDb((db) =>
          db.artifact.findMany({
            where: { organizationId, slug: { in: slugs } },
            select: { id: true, slug: true },
          })
        ),
    refs.some((ref) => PULL_REQUEST_REF_RE.test(ref))
      ? canonicalPullRequestRefs(organizationId, [...recipients])
      : new Map<string, string>(),
  ]);
  const resolved = new Map<string, string>();
  for (const [name, branchId] of branchRecipientsByName(evidence)) {
    resolved.set(name, branchId);
  }
  for (const artifact of artifacts) {
    if (artifact.slug && recipients.has(artifact.id)) {
      resolved.set(artifact.slug, artifact.id);
    }
  }
  for (const ref of refs) {
    const match = PULL_REQUEST_REF_RE.exec(ref);
    const branchId =
      match?.[1] && match[2]
        ? pullRequestRefs.get(pullRequestRefKey(match[1], Number(match[2])))
        : undefined;
    if (branchId && recipients.has(branchId)) {
      resolved.set(ref, branchId);
    }
  }
  return resolved;
}

/**
 * A stored per-event cost that is negative or not finite is an impossible
 * price (PRD-800 'Allocation fails only for impossible values').
 * Checked per event, so it fails the allocation instead of netting against
 * the other events of its bucket.
 */
function invalidEventPrice(
  events: readonly AllocationTokenEvent[]
): ReconciliationFailure | undefined {
  const event = events.find(
    ({ estimatedCost }) =>
      estimatedCost !== null &&
      !(estimatedCost.isFinite() && estimatedCost.greaterThanOrEqualTo(0))
  );
  return event
    ? {
        kind: ReconciliationFailureKind.InvalidPrice,
        sourceKey: `event:${event.externalEventId}`,
        priceKey: event.model,
      }
    : undefined;
}

/** This record and its copies; just this record when it has no owner. */
async function logicalSessionRecords(session: {
  organizationId: string;
  agentSessionId: string;
}): Promise<string[]> {
  const own = await withDb((db) =>
    db.sessionDetail.findFirst({
      where: {
        artifactId: session.agentSessionId,
        artifact: { organizationId: session.organizationId },
      },
      select: {
        harness: true,
        externalSessionId: true,
        artifact: { select: { createdById: true } },
      },
    })
  );
  const owner = own?.artifact.createdById;
  if (!(own && owner)) {
    return [session.agentSessionId];
  }
  const copies = await withDb((db) =>
    db.sessionDetail.findMany({
      where: {
        harness: own.harness,
        externalSessionId: own.externalSessionId,
        artifact: {
          organizationId: session.organizationId,
          createdById: owner,
        },
      },
      select: { artifactId: true },
    })
  );
  return [
    ...new Set([
      session.agentSessionId,
      ...copies.map((copy) => copy.artifactId),
    ]),
  ];
}
