import { BranchPushSource, LinkType } from "@repo/api/src/types/artifact";
import { Prisma } from "@repo/database";
import { v7 as uuidv7 } from "uuid";
import { acquireSessionArtifactLinksAdvisoryLock } from "../advisory-locks";
import type { AgentSessionUpsertTx } from "../records";
import {
  type BranchRefAggregate,
  hasPullRequestHeadPushEvidence,
} from "./branch-ref-aggregate";
import {
  buildSessionBranchLinkWriteData,
  SessionBranchLinkEvidenceSource,
} from "./session-branch-link-writer";

export async function persistSessionBranchLinkBatch(
  tx: AgentSessionUpsertTx,
  input: {
    organizationId: string;
    sessionArtifactId: string;
    byArtifact: ReadonlyMap<string, BranchRefAggregate>;
  }
): Promise<void> {
  const entries = [...input.byArtifact].sort(([left], [right]) =>
    left.localeCompare(right)
  );
  if (entries.length === 0) {
    return;
  }
  const pushes = entries.flatMap(([id, aggregate]) => {
    const at =
      aggregate.pushedAt ??
      (hasPullRequestHeadPushEvidence(aggregate)
        ? aggregate.observedAt
        : undefined);
    let pushedAt = aggregate.pushObserved ? new Date() : null;
    if (at) {
      pushedAt = new Date(at);
    }
    return pushedAt && Number.isFinite(pushedAt.getTime())
      ? [{ id, pushedAt }]
      : [];
  });
  if (pushes.length > 0) {
    await tx.$executeRaw`
      UPDATE branch_detail AS branch
      SET first_pushed_at = incoming.pushed_at, push_source = ${BranchPushSource.Session}, updated_at = ${new Date()}
      FROM unnest(${pushes.map((row) => row.id)}::uuid[], ${pushes.map((row) => row.pushedAt.toISOString())}::timestamp[]) AS incoming(id, pushed_at)
      WHERE branch.organization_id = ${input.organizationId}::uuid AND branch.artifact_id = incoming.id
        AND (branch.first_pushed_at IS NULL OR branch.first_pushed_at > incoming.pushed_at)
    `;
  }
  await acquireSessionArtifactLinksAdvisoryLock(tx, {
    organizationId: input.organizationId,
    sessionArtifactId: input.sessionArtifactId,
  });
  const existing = await tx.artifactLink.findMany({
    where: {
      organizationId: input.organizationId,
      sourceId: input.sessionArtifactId,
      targetId: { in: entries.map(([id]) => id) },
      linkType: LinkType.RelatesTo,
    },
    select: {
      targetId: true,
      metadata: true,
      branchParticipation: true,
      branchParticipationMethod: true,
      branchParticipationObservedAt: true,
    },
  });
  const existingByTarget = new Map(existing.map((row) => [row.targetId, row]));
  const values = entries.map(([targetId, aggregate]) => {
    const data = buildSessionBranchLinkWriteData({
      aggregate,
      existing: existingByTarget.get(targetId),
      evidenceSource:
        aggregate.branchRefObserved === false
          ? SessionBranchLinkEvidenceSource.PullRequestHead
          : SessionBranchLinkEvidenceSource.IndependentBranch,
    });
    return Prisma.sql`(${uuidv7()}::uuid, ${input.organizationId}::uuid, ${input.sessionArtifactId}::uuid, ${targetId}::uuid, ${LinkType.RelatesTo}::"LinkType", ${JSON.stringify(data.metadata)}::jsonb, ${data.branchParticipation}::text, ${data.branchParticipationMethod}::text, ${data.branchParticipationObservedAt}::timestamp)`;
  });
  // Same multi-row ON CONFLICT precedent as branch-materialization-retry.
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO artifact_links (id, organization_id, source_id, target_id, link_type, metadata,
      branch_participation, branch_participation_method, branch_participation_observed_at)
    VALUES ${Prisma.join(values)}
    ON CONFLICT (source_id, target_id, link_type) DO UPDATE SET
      metadata = EXCLUDED.metadata,
      branch_participation = EXCLUDED.branch_participation,
      branch_participation_method = EXCLUDED.branch_participation_method,
      branch_participation_observed_at = EXCLUDED.branch_participation_observed_at
    WHERE artifact_links.organization_id = EXCLUDED.organization_id
  `);
}
