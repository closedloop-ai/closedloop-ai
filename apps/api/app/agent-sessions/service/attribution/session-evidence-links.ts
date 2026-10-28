/**
 * ISS-12552: only while `attribution-evidence-policy` is on
 * for the session's organization, link each evidence target the session has no
 * link to, and drop evidence links whose target no longer has evidence. With
 * the flag off, links are exactly what the slug lane wrote, and links written
 * while it was on stay. Targets are read from the session's stored evidence,
 * so sync, the late receipt binder and the backfill all converge on the same
 * links.
 *
 * Runs after the write that changed the evidence has committed, never inside
 * it: the flag is a remote PostHog call, and waiting on it inside the sync
 * slice would hold the slice's pinned connection against its timeout. Each
 * session's links then change in their own short transaction, which records
 * the snapshot digest they were synced for. While PostHog cannot answer, the
 * digest stays stale, so the session's next sync rebuilds its evidence and
 * tries the links again.
 *
 * The flag is a company group flag (PRD-800 "Rollout"), so the answer is
 * the organization's: a writer and every reader in the organization get the
 * same one.
 */
import { LinkType } from "@repo/api/src/types/artifact";
import { OperationSource } from "@repo/api/src/types/attribution-evidence";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-pr-link-metadata";
import { withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import {
  ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY,
  ATTRIBUTION_EVIDENCE_POLICY_FLAG_UNAVAILABLE_LOG_KEY,
  evaluateAttributionEvidenceForOrganization,
} from "@/lib/attribution-evidence-policy-feature";
import type { AgentSessionUpsertTx } from "../records";

/**
 * Sync each session's evidence links after the write that changed its
 * evidence committed. Never throws: a session whose sync fails keeps a stale
 * digest and is retried by its next sync.
 */
export async function syncSessionEvidenceLinks(
  organizationId: string,
  agentSessionIds: readonly string[]
): Promise<void> {
  const sessionIds = [...new Set(agentSessionIds)];
  if (sessionIds.length === 0) {
    return;
  }
  const enabled =
    await evaluateAttributionEvidenceForOrganization(organizationId);
  if (enabled === false) {
    return;
  }
  const deferred: string[] = [];
  for (const agentSessionId of sessionIds) {
    const session = { organizationId, agentSessionId };
    try {
      if (enabled === null) {
        deferred.push(agentSessionId);
        await withDb((db) => markLinksStale(db, session));
        continue;
      }
      await withDb.tx((tx) => applySessionEvidenceLinks(tx, session));
    } catch (error) {
      log.warn("session evidence link sync failed; next sync retries", {
        level: "warn",
        status: "warn",
        organizationId,
        agentSessionId,
        error: parseError(error),
      });
    }
  }
  if (deferred.length > 0) {
    log.warn(ATTRIBUTION_EVIDENCE_POLICY_FLAG_UNAVAILABLE_LOG_KEY, {
      level: "warn",
      status: "warn",
      featureFlagKey: ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY,
      organizationId,
      deferredSessionCount: deferred.length,
      agentSessionIds: deferred.slice(0, DEFERRED_SESSION_SAMPLE),
    });
  }
}

/** Adds a committed slice's session to one of the batch's post-commit steps. */
export function collectPostCommitSession(
  sessionIds: string[],
  agentSessionId: string | undefined
): void {
  if (agentSessionId) {
    sessionIds.push(agentSessionId);
  }
}

/** Adds the other sessions a committed slice changed to a post-commit step. */
export function collectPostCommitSessions(
  sessionIds: string[],
  agentSessionIds: readonly string[] | undefined
): void {
  sessionIds.push(...(agentSessionIds ?? []));
}

/** How many deferred session ids one log line names. */
const DEFERRED_SESSION_SAMPLE = 20;

/**
 * Brings the links in line with the stored evidence, then records the digest
 * they now reflect, only if the snapshot still holds it.
 */
async function applySessionEvidenceLinks(
  tx: AgentSessionUpsertTx,
  session: { organizationId: string; agentSessionId: string }
): Promise<void> {
  const snapshot = await tx.agentSessionOperationEvidenceSnapshot.findFirst({
    where: {
      agentSessionId: session.agentSessionId,
      organizationId: session.organizationId,
    },
    select: { digest: true },
  });
  await writeEvidenceLinks(tx, session);
  if (snapshot) {
    await tx.agentSessionOperationEvidenceSnapshot.updateMany({
      where: {
        agentSessionId: session.agentSessionId,
        organizationId: session.organizationId,
        digest: snapshot.digest,
      },
      data: { linksSyncedDigest: snapshot.digest },
    });
  }
}

function markLinksStale(
  db: Pick<AgentSessionUpsertTx, "agentSessionOperationEvidenceSnapshot">,
  session: { organizationId: string; agentSessionId: string }
) {
  return db.agentSessionOperationEvidenceSnapshot.updateMany({
    where: {
      agentSessionId: session.agentSessionId,
      organizationId: session.organizationId,
    },
    data: { linksSyncedDigest: null },
  });
}

async function writeEvidenceLinks(
  tx: AgentSessionUpsertTx,
  input: { organizationId: string; agentSessionId: string }
): Promise<void> {
  const { organizationId, agentSessionId } = input;
  // Implementation rows come from repository evidence and link nothing here.
  const evidence = await tx.agentSessionOperationEvidence.findMany({
    where: {
      organizationId,
      agentSessionId,
      source: { not: OperationSource.Repository },
      targetArtifactId: { not: null },
      NOT: { targetArtifactId: agentSessionId },
    },
    distinct: ["targetArtifactId"],
    select: { targetArtifactId: true },
  });
  const evidenceTargetIds = evidence.flatMap(
    (row) => row.targetArtifactId ?? []
  );
  const artifacts =
    evidenceTargetIds.length === 0
      ? []
      : await tx.artifact.findMany({
          where: { organizationId, id: { in: evidenceTargetIds } },
          select: { id: true },
        });
  const targetIds = artifacts.map((artifact) => artifact.id);
  // A link the slug lane also wrote carries its legacy role and relation
  // merged in (slug-links.ts). Losing its evidence demotes it back to that
  // legacy link, so turning the flag off still finds today's classification.
  await tx.$executeRaw`
    UPDATE artifact_links
    SET metadata = metadata - 'linkKind'
    WHERE organization_id = ${organizationId}::uuid
      AND source_id = ${agentSessionId}::uuid
      AND link_type = ${LinkType.RelatesTo}::"LinkType"
      AND metadata ->> 'linkKind' = ${SessionArtifactLinkKind.SessionEvidence}
      AND (metadata - 'linkKind') <> '{}'::jsonb
      AND NOT (target_id = ANY(${targetIds}::uuid[]))
  `;
  await tx.artifactLink.deleteMany({
    where: {
      organizationId,
      sourceId: agentSessionId,
      linkType: LinkType.RelatesTo,
      metadata: {
        path: ["linkKind"],
        equals: SessionArtifactLinkKind.SessionEvidence,
      },
      ...(targetIds.length > 0 ? { targetId: { notIn: targetIds } } : {}),
    },
  });
  if (targetIds.length === 0) {
    return;
  }
  await tx.artifactLink.createMany({
    data: targetIds.map((targetId) => ({
      organizationId,
      sourceId: agentSessionId,
      targetId,
      linkType: LinkType.RelatesTo,
      metadata: { linkKind: SessionArtifactLinkKind.SessionEvidence },
    })),
    skipDuplicates: true,
  });
}
