/**
 * ISS-12552: the pure inputs to a session's usage
 * allocation, shared by the API's allocation service and the golden Layer 3
 * suite. Builds the kernel's usage units from stored token events, and its
 * recipients and qualifying operations from evidence rows. Pricing stays with
 * the API, which owns the pricing engine.
 */
import {
  AttributionRelationshipKind,
  UsageTokenCategory,
} from "@repo/api/src/types/attribution-evidence";
import {
  TokenSourceIdentityAvailability,
  tokenSourceIdentitySchema,
} from "@repo/api/src/types/token-cost-provenance";
import { z } from "zod";
import { requestKeyFor } from "../harness/request-key";
import { claudeTranscriptEntryUuidScheme } from "../harness/usage-dedup";
import {
  type QualifyingOperation,
  type UsageObservation,
  UsageOperationClass,
} from "./associate-usage";
import { qualifiesForWritingCost } from "./classify-operation";

/** A stored token event as allocation reads it. */
export type AllocationUsageEvent = {
  externalEventId: string;
  agentExternalId: string | null;
  model: string;
  inputTokens: bigint;
  outputTokens: bigint;
  cacheReadTokens: bigint;
  cacheWriteTokens: bigint;
  sourceIdentity: unknown;
  eventCreatedAt: Date;
};

export type AllocationEvidence = {
  targetArtifactId: string | null;
  relationshipKind: string;
  agentId: string | null;
  invokedAt: Date | null;
  effectiveAt: Date | null;
  /** The server receipt that committed the write, when one is bound. */
  receiptId: string | null;
  anchors: unknown;
};

export const ALLOCATION_CATEGORY_COUNTS = [
  [UsageTokenCategory.Input, "inputTokens"],
  [UsageTokenCategory.Output, "outputTokens"],
  [UsageTokenCategory.CacheRead, "cacheReadTokens"],
  [UsageTokenCategory.CacheWrite, "cacheWriteTokens"],
] as const;

/**
 * One unit per token category of each event. The unit key is the event's
 * usage source identity, so two stored rows for one source usage (ISS-8035,
 * ISS-12487) reach the kernel as a duplicate source instead of twice. The
 * price key is the event's model unless the caller prices by another key.
 */
export function usageObservations<T extends AllocationUsageEvent>(
  events: readonly T[],
  priceKeyOf: (event: T) => string = (event) => event.model
): UsageObservation[] {
  return events.flatMap((event) => {
    const source = sourceKeyFor(event);
    const requestKeys = requestKeysFor(event.sourceIdentity);
    return ALLOCATION_CATEGORY_COUNTS.flatMap(([category, field]) =>
      event[field] > 0n
        ? [
            {
              sourceKey: `${source}#${category}`,
              agentId: event.agentExternalId,
              priceKey: priceKeyOf(event),
              category,
              tokens: Number(event[field]),
              atMs: event.eventCreatedAt.getTime(),
              requestKeys,
            },
          ]
        : []
    );
  });
}

function sourceKeyFor(event: AllocationUsageEvent): string {
  return (
    availableSourceKey(event.sourceIdentity) ?? `event:${event.externalEventId}`
  );
}

/** Each source record of the request, as a request key. */
function requestKeysFor(sourceIdentity: unknown): string[] {
  const identity = tokenSourceIdentitySchema.safeParse(sourceIdentity).data;
  if (identity?.availability !== TokenSourceIdentityAvailability.Available) {
    return [];
  }
  return identity.sourceRecordIds.map((id) =>
    requestKeyFor(identity.scheme, id)
  );
}

function availableSourceKey(sourceIdentity: unknown): string | null {
  const identity = tokenSourceIdentitySchema.safeParse(sourceIdentity);
  return identity.success &&
    identity.data.availability === TokenSourceIdentityAvailability.Available
    ? `${identity.data.scheme}:${identity.data.sourceRecordIds.join("\u0001")}`
    : null;
}

/**
 * Recipients are the artifacts a session wrote (creation or revision) and the
 * branches it implemented; a branch and its pull request are one artifact.
 * Comments never qualify for writing cost (AC-006).
 *
 * An implementation row that names the requests whose writes its branch's
 * commits captured (the write-to-commit join, Daveth Oakhurst 2026-10-20) gives one operation per
 * request and none on the fallback; one that names none gives a single
 * fallback operation, as an older Desktop's rows do.
 */
export function recipientsAndOperations(
  evidence: readonly AllocationEvidence[]
): {
  recipients: string[];
  operations: QualifyingOperation[];
} {
  const recipients = new Set<string>();
  const operations: QualifyingOperation[] = [];
  for (const row of evidence) {
    const operationClass = operationClassFor(row.relationshipKind);
    if (!(row.targetArtifactId && operationClass)) {
      continue;
    }
    recipients.add(row.targetArtifactId);
    const operation = {
      recipientKey: row.targetArtifactId,
      operationClass,
      agentId: row.agentId,
      atMs: (row.effectiveAt ?? row.invokedAt)?.getTime() ?? null,
    };
    const joined =
      operationClass === UsageOperationClass.Implementation
        ? implementationRequestKeys(row.anchors)
        : undefined;
    if (joined) {
      operations.push(
        ...joined.map((requestKey) => ({ ...operation, requestKey }))
      );
    } else {
      operations.push({ ...operation, ...receiptedRequest(row) });
    }
  }
  return { recipients: [...recipients], operations };
}

function operationClassFor(kind: string): UsageOperationClass | null {
  if (kind === AttributionRelationshipKind.Implementation) {
    return UsageOperationClass.Implementation;
  }
  return isRelationshipKind(kind) && qualifiesForWritingCost(kind)
    ? UsageOperationClass.Plan
    : null;
}

const relationshipKinds = new Set<string>(
  Object.values(AttributionRelationshipKind)
);

function isRelationshipKind(kind: string): kind is AttributionRelationshipKind {
  return relationshipKinds.has(kind);
}

const requestAnchorSchema = z.object({ requestKey: z.string().min(1) }).loose();

/** The request key a synced claim recorded, kept in the evidence anchors. */
function requestKeyOf(anchors: unknown): string | null {
  return requestAnchorSchema.safeParse(anchors).data?.requestKey ?? null;
}

/**
 * A write's request, or its candidate requests when the request is ambiguous,
 * or that its request is unresolved; null for a write with no receipt, which
 * only the fallback can place.
 */
function receiptedRequest(row: AllocationEvidence): {
  requestKey: string | null;
  candidateRequestKeys?: string[];
  requestUnresolved?: boolean;
} {
  const requestKey = row.receiptId ? requestKeyOf(row.anchors) : null;
  if (
    row.receiptId &&
    requestKey === null &&
    isRequestUnresolved(row.anchors)
  ) {
    return { requestKey, requestUnresolved: true };
  }
  const candidates =
    row.receiptId && requestKey === null
      ? candidateRequestKeysOf(row.anchors)
      : [];
  return candidates.length > 0
    ? { requestKey, candidateRequestKeys: candidates }
    : { requestKey };
}

const unresolvedAnchorSchema = z
  .object({ requestUnresolved: z.literal(true) })
  .loose();

function isRequestUnresolved(anchors: unknown): boolean {
  return unresolvedAnchorSchema.safeParse(anchors).success;
}

const candidateAnchorSchema = z
  .object({ candidateRequestKeys: z.array(z.string().min(1)) })
  .loose();

/** The candidate requests of a receipted write whose request is ambiguous. */
function candidateRequestKeysOf(anchors: unknown): string[] {
  return (
    candidateAnchorSchema.safeParse(anchors).data?.candidateRequestKeys ?? []
  );
}

/**
 * The request facts a claim leaves on its evidence row's anchors: its request
 * key, or, when that is ambiguous, its candidate requests (PRD-800,
 * Daveth Oakhurst 2026-10-20). The cloud writer and the golden chain both use it.
 */
export function claimRequestAnchors(claim: {
  requestKey?: string;
  candidateRequestKeys?: readonly string[];
  requestUnresolved?: true;
}): {
  requestKey?: string;
  candidateRequestKeys?: string[];
  requestUnresolved?: true;
} {
  if (claim.requestKey) {
    return { requestKey: claim.requestKey };
  }
  if (claim.requestUnresolved) {
    return { requestUnresolved: true };
  }
  return claim.candidateRequestKeys?.length
    ? { candidateRequestKeys: [...claim.candidateRequestKeys] }
    : {};
}

const implementationRequestsSchema = z
  .object({ requestKeys: z.array(z.string().min(1)) })
  .loose();

/**
 * The requests an implementation row's write-to-commit join placed, possibly
 * none; undefined when the row carries no join.
 */
function implementationRequestKeys(anchors: unknown): string[] | undefined {
  return implementationRequestsSchema.safeParse(anchors).data?.requestKeys;
}

const repositoryOutputSchema = z
  .object({ repositoryOutput: z.object({ headRef: z.string() }) })
  .loose();

/** Branch name to implementation recipient, for names that name one branch. */
export function branchRecipientsByName(
  evidence: readonly AllocationEvidence[]
): Map<string, string> {
  const byName = new Map<string, Set<string>>();
  for (const row of evidence) {
    const headRef = repositoryOutputSchema.safeParse(row.anchors).data
      ?.repositoryOutput.headRef;
    if (
      row.relationshipKind === AttributionRelationshipKind.Implementation &&
      row.targetArtifactId &&
      headRef
    ) {
      byName.set(
        headRef,
        (byName.get(headRef) ?? new Set()).add(row.targetArtifactId)
      );
    }
  }
  return new Map(
    [...byName].flatMap(([name, ids]) =>
      ids.size === 1 ? [[name, [...ids][0] ?? ""]] : []
    )
  );
}

/**
 * The key one source usage carries in every session that recorded it, or null
 * when its identity names a record within one transcript only. A Claude
 * transcript entry uuid is the one scheme that names a record across files, so
 * a forked session's copied history carries its parent's ids (AC-020). An
 * identity under any other scheme is not assumed to be unique across sessions.
 */
export function crossSessionSourceKey(sourceIdentity: unknown): string | null {
  const identity = tokenSourceIdentitySchema.safeParse(sourceIdentity);
  return identity.success &&
    identity.data.availability === TokenSourceIdentityAvailability.Available &&
    identity.data.scheme === claudeTranscriptEntryUuidScheme
    ? availableSourceKey(identity.data)
    : null;
}

/**
 * The key one token event carries in every copy of a session (PRD-800): its
 * external id. The Desktop derives that id from the transcript's own
 * session id and the event's content (`generatedTransportId`), so it is the
 * same from every machine and unique within a session, whatever identity the
 * event carries or lacks.
 */
export function sessionCopySourceKey(
  event: Pick<AllocationUsageEvent, "externalEventId">
): string {
  return `event:${event.externalEventId}`;
}

/**
 * Drops the events whose source usage another session owns: a fork's copied
 * history, sent by a Desktop that predates replay marking (AC-020), and the
 * usage a copy of this session synced from a canonical compute target holds
 * (PRD-800). Each is allocated once, to the session that owns it.
 */
export function withoutUsageOwnedElsewhere<T extends AllocationUsageEvent>(
  events: readonly T[],
  ownedElsewhere: ReadonlySet<string>
): T[] {
  return events.filter((event) => {
    const forkKey = crossSessionSourceKey(event.sourceIdentity);
    return !(
      ownedElsewhere.has(sessionCopySourceKey(event)) ||
      (forkKey !== null && ownedElsewhere.has(forkKey))
    );
  });
}
