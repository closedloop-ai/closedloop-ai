import { monitoredActivityTargetKey } from "@repo/api/src/types/monitored-activity-target";
import { chunksOf } from "@/lib/chunks-of";
import { isWithinTrustedFutureBoundary } from "@/lib/trusted-timestamp";
import {
  type MonitoredActivityCandidate,
  monitoredActivityDigest,
} from "./monitored-session-activity-shared";
import type { AgentSessionUpsertTx } from "./records";
import { bindParameterChunkSize } from "./write-chunking";

/**
 * Partition monitored candidates against durable first-receive quarantine
 * anchors. A stored future identity remains retry-owned forever; new identities
 * carry hashes rather than raw refs. Nothing bounds how many a Session may
 * accumulate (ISS-9860) — every statement here is chunked by bind budget
 * instead, so a wide page costs more statements, never a refusal.
 */
export async function partitionMonitoredCandidatesByTrust(
  tx: AgentSessionUpsertTx,
  input: {
    organizationId: string;
    sessionArtifactId: string;
    receivedAt: Date;
  },
  candidates: readonly MonitoredActivityCandidate[]
): Promise<{
  trustedCandidates: MonitoredActivityCandidate[];
  futureCandidates: MonitoredActivityCandidate[];
}> {
  const existingByIdentity = await loadQuarantineRows(tx, input, candidates);
  const newFutureCandidates = candidates.filter((candidate) => {
    const identityHash = quarantineEventIdentityHash(candidate);
    return !(
      existingByIdentity.has(identityHash) ||
      isWithinTrustedFutureBoundary(
        new Date(candidate.event.occurredAt),
        input.receivedAt
      )
    );
  });
  await persistMonitoredActivityQuarantineRows(
    tx,
    input,
    newFutureCandidates.map((candidate) => ({
      candidate,
      receivedAt: input.receivedAt,
    }))
  );
  const quarantinedByIdentity =
    newFutureCandidates.length > 0
      ? await loadQuarantineRows(tx, input, candidates)
      : existingByIdentity;
  const trustedCandidates: MonitoredActivityCandidate[] = [];
  const futureCandidates: MonitoredActivityCandidate[] = [];
  for (const candidate of candidates) {
    const row = quarantinedByIdentity.get(
      quarantineEventIdentityHash(candidate)
    );
    if (!row) {
      trustedCandidates.push(candidate);
      continue;
    }
    assertQuarantineMatches(candidate, row);
    futureCandidates.push(candidate);
  }
  return { trustedCandidates, futureCandidates };
}

/** Persist hash-only quarantine anchors for one Session, chunked by bind budget. */
export async function persistMonitoredActivityQuarantineRows(
  tx: AgentSessionUpsertTx,
  input: { organizationId: string; sessionArtifactId: string },
  entries: readonly {
    candidate: MonitoredActivityCandidate;
    receivedAt: Date;
  }[]
): Promise<void> {
  if (entries.length === 0) {
    return;
  }
  const rows = entries.map(({ candidate, receivedAt }) => ({
    organizationId: input.organizationId,
    sessionArtifactId: input.sessionArtifactId,
    eventIdentityHash: quarantineEventIdentityHash(candidate),
    eventFingerprint: quarantineEventFingerprint(candidate),
    occurredAt: new Date(candidate.event.occurredAt),
    receivedAt,
  }));
  for (const chunk of chunksOf(rows, QUARANTINE_INSERT_CHUNK_SIZE)) {
    await tx.monitoredSessionActivityQuarantine.createMany({
      data: chunk,
      skipDuplicates: true,
    });
  }
}

async function loadQuarantineRows(
  tx: AgentSessionUpsertTx,
  input: { organizationId: string; sessionArtifactId: string },
  candidates: readonly MonitoredActivityCandidate[]
): Promise<Map<string, MonitoredActivityQuarantineRow>> {
  if (candidates.length === 0) {
    return new Map();
  }
  const identityHashes = [
    ...new Set(candidates.map(quarantineEventIdentityHash)),
  ];
  const byIdentity = new Map<string, MonitoredActivityQuarantineRow>();
  for (const chunk of chunksOf(identityHashes, QUARANTINE_READ_CHUNK_SIZE)) {
    const rows = await tx.monitoredSessionActivityQuarantine.findMany({
      where: {
        organizationId: input.organizationId,
        sessionArtifactId: input.sessionArtifactId,
        eventIdentityHash: { in: chunk },
      },
      select: {
        eventIdentityHash: true,
        eventFingerprint: true,
        occurredAt: true,
        receivedAt: true,
      },
    });
    for (const row of rows) {
      byIdentity.set(row.eventIdentityHash.trim(), row);
    }
  }
  return byIdentity;
}

function assertQuarantineMatches(
  candidate: MonitoredActivityCandidate,
  row: MonitoredActivityQuarantineRow
): void {
  if (
    row.eventFingerprint.trim() !== quarantineEventFingerprint(candidate) ||
    row.occurredAt.getTime() !== Date.parse(candidate.event.occurredAt) ||
    isWithinTrustedFutureBoundary(row.occurredAt, row.receivedAt)
  ) {
    throw new Error(
      `conflicting monitored activity quarantine identity ${monitoredActivityTargetKey(candidate.target)}`
    );
  }
}

function quarantineEventIdentityHash(
  candidate: MonitoredActivityCandidate
): string {
  return monitoredActivityDigest(
    monitoredActivityTargetKey(candidate.target),
    candidate.event.sourceEventId
  );
}

function quarantineEventFingerprint(
  candidate: MonitoredActivityCandidate
): string {
  return monitoredActivityDigest(
    monitoredActivityTargetKey(candidate.target),
    candidate.event.sourceEventId,
    candidate.event.kind,
    candidate.event.occurredAt
  );
}

/** One persisted quarantine anchor, as `loadQuarantineRows` selects it. */
export type MonitoredActivityQuarantineRow = {
  eventIdentityHash: string;
  eventFingerprint: string;
  occurredAt: Date;
  receivedAt: Date;
};

/** `in` list width: one bind per hash beside the fixed org and session binds. */
const QUARANTINE_READ_CHUNK_SIZE = bindParameterChunkSize(1, 2);
/**
 * Bind parameters one `MonitoredSessionActivityQuarantine` row costs in a
 * `createMany`: every column in the model, the client-generated `id` and
 * `createdAt` defaults included — sized against the schema like
 * `BRANCH_ACTIVITY_ATOM_COLUMN_COUNT`.
 */
const MONITORED_ACTIVITY_QUARANTINE_COLUMN_COUNT = 8;
const QUARANTINE_INSERT_CHUNK_SIZE = bindParameterChunkSize(
  MONITORED_ACTIVITY_QUARANTINE_COLUMN_COUNT,
  0
);
