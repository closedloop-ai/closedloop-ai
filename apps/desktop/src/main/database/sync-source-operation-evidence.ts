/**
 * ISS-12552: attach each session's stored operation evidence
 * to its sync payload. Kept out of `sync-source.ts` (grandfathered,
 * shrink-only). A stored row that does not parse is left off the payload, so
 * the cloud keeps the evidence it already has rather than receiving a guess.
 */

import type { SessionOperationEvidence } from "@repo/api/src/types/operation-claims";
import { sessionOperationEvidenceSchema } from "@repo/api/src/types/operation-claims-schema";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import type { DesktopPrismaReadClient } from "./prisma-client.js";
import { selectRowsByIds } from "./session-detail-mappers.js";

type OperationEvidenceRow = {
  session_id: string;
  extractor_version: number | bigint;
  digest: string;
  coverage: string;
  claims: string;
};

export async function attachOperationEvidence(
  reader: DesktopPrismaReadClient,
  sessions: SyncedAgentSession[]
): Promise<SyncedAgentSession[]> {
  if (sessions.length === 0) {
    return sessions;
  }
  const rows = await selectRowsByIds<OperationEvidenceRow>(
    reader,
    `
      SELECT session_id, extractor_version, digest, coverage, claims
      FROM session_operation_claims
      WHERE session_id IN (__IDS__)
    `,
    sessions.map((session) => session.externalSessionId)
  );
  const evidenceById = new Map<string, SessionOperationEvidence>();
  for (const row of rows) {
    const evidence = parseStoredEvidence(row);
    if (evidence) {
      evidenceById.set(row.session_id, evidence);
    }
  }
  return sessions.map((session) => {
    const operationEvidence = evidenceById.get(session.externalSessionId);
    return operationEvidence ? { ...session, operationEvidence } : session;
  });
}

function parseStoredEvidence(
  row: OperationEvidenceRow
): SessionOperationEvidence | null {
  let stored: unknown;
  try {
    stored = {
      extractorVersion: Number(row.extractor_version),
      digest: row.digest,
      coverage: JSON.parse(row.coverage),
      claims: JSON.parse(row.claims),
    };
  } catch {
    return null;
  }
  const parsed = sessionOperationEvidenceSchema.safeParse(stored);
  if (!parsed.success) {
    return null;
  }
  const { unparsedClaims: _unparsed, ...evidence } = parsed.data;
  return evidence;
}
