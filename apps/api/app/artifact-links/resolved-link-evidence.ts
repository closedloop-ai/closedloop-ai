/**
 * ISS-12552: attach operation evidence to the SESSION-source
 * rows of a resolved-links page, in one batched read. A row with no evidence
 * stays as it is; absent evidence is never defaulted to a relationship.
 */

import {
  type ArtifactLinkWithEndpoints,
  ArtifactType,
} from "@repo/api/src/types/artifact";
import {
  ATTRIBUTION_CONTRACT_VERSION,
  formatOperationId,
  type SessionLinkAttributionEvidence,
  type SessionLinkAttributionOperation,
} from "@repo/api/src/types/attribution-evidence";
import { RELATIONSHIP_STRENGTH } from "@repo/api/src/types/attribution-provenance-kind";
import { withDb } from "@repo/database";
import {
  storedEvidenceOutcome,
  storedOperationKind,
} from "@repo/lib/attribution/receipt-outcome";

/** Operations listed per row; the strongest relationship is always kept. */
export const MAX_SESSION_LINK_OPERATIONS = 50;

type EvidenceRow = {
  agentSessionId: string;
  targetArtifactId: string | null;
  receiptId: string | null;
  relationshipKind: string;
  operationKind: string;
  outcome: string;
  versionNumber: number | null;
  changedFields: string[];
  extractorVersion: number;
  policyVersion: number;
};

export async function attachSessionLinkEvidence(
  organizationId: string,
  links: ArtifactLinkWithEndpoints[]
): Promise<ArtifactLinkWithEndpoints[]> {
  const sessionLinks = links.filter(
    (link) => link.source.type === ArtifactType.Session
  );
  if (sessionLinks.length === 0) {
    return links;
  }
  const rows = await withDb((db) =>
    db.agentSessionOperationEvidence.findMany({
      where: {
        organizationId,
        agentSessionId: {
          in: [...new Set(sessionLinks.map((link) => link.sourceId))],
        },
        targetArtifactId: {
          in: [...new Set(sessionLinks.map((link) => link.targetId))],
        },
      },
      orderBy: [{ invokedAt: "asc" }, { id: "asc" }],
      select: {
        agentSessionId: true,
        targetArtifactId: true,
        receiptId: true,
        relationshipKind: true,
        operationKind: true,
        outcome: true,
        versionNumber: true,
        changedFields: true,
        extractorVersion: true,
        policyVersion: true,
      },
    })
  );
  const byPair = new Map<string, EvidenceRow[]>();
  for (const row of rows) {
    const key = pairKey(row.agentSessionId, row.targetArtifactId ?? "");
    const pairRows = byPair.get(key);
    if (pairRows) {
      pairRows.push(row);
    } else {
      byPair.set(key, [row]);
    }
  }
  return links.map((link) => {
    const pairRows =
      link.source.type === ArtifactType.Session
        ? byPair.get(pairKey(link.sourceId, link.targetId))
        : undefined;
    const sessionEvidence = pairRows ? toSessionEvidence(pairRows) : undefined;
    return sessionEvidence ? { ...link, sessionEvidence } : link;
  });
}

function toSessionEvidence(
  rows: readonly EvidenceRow[]
): SessionLinkAttributionEvidence | undefined {
  const operations = rows.flatMap((row) => {
    const operation = toOperation(row);
    return operation ? [operation] : [];
  });
  const relationshipKind = RELATIONSHIP_STRENGTH.find((kind) =>
    operations.some((operation) => operation.relationshipKind === kind)
  );
  if (!relationshipKind) {
    return;
  }
  const strongest = operations.filter(
    (operation) => operation.relationshipKind === relationshipKind
  );
  const rest = operations.filter(
    (operation) => operation.relationshipKind !== relationshipKind
  );
  return {
    contractVersion: ATTRIBUTION_CONTRACT_VERSION,
    policyVersion: Math.max(...rows.map((row) => row.policyVersion)),
    extractorVersion: Math.max(...rows.map((row) => row.extractorVersion)),
    relationshipKind,
    operations: [...strongest, ...rest].slice(0, MAX_SESSION_LINK_OPERATIONS),
  };
}

function toOperation(
  row: EvidenceRow
): SessionLinkAttributionOperation | undefined {
  const relationshipKind = RELATIONSHIP_STRENGTH.find(
    (kind) => kind === row.relationshipKind
  );
  if (!relationshipKind) {
    return;
  }
  const durableResult = {
    ...(row.versionNumber === null ? {} : { versionNumber: row.versionNumber }),
    ...(row.changedFields.length > 0
      ? { changedFields: row.changedFields }
      : {}),
  };
  return {
    ...(row.receiptId ? { operationId: formatOperationId(row.receiptId) } : {}),
    relationshipKind,
    operationKind: storedOperationKind(row.operationKind),
    outcome: storedEvidenceOutcome(row.outcome),
    ...(Object.keys(durableResult).length > 0 ? { durableResult } : {}),
  };
}

function pairKey(sessionId: string, targetId: string): string {
  return `${sessionId}\u0000${targetId}`;
}
