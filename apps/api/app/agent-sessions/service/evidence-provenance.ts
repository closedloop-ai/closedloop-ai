/**
 * ISS-12552: session provenance read from operation evidence,
 * used by the Related Sessions reads and a document's Sessions tab while
 * `attribution-evidence-policy` is on. Each evidence row maps to its Related
 * Sessions kind through `evidenceProvenanceKind` (PRD-800 "Related
 * Sessions labels"). Participation from the branch and pull request lanes still
 * counts; any other link, whatever its slug-lane relation, is mention-only and
 * never qualifies (PRD-800 "Links without evidence").
 */

import { ArtifactType } from "@repo/api/src/types/artifact";
import type { AttributionRelationshipKind } from "@repo/api/src/types/attribution-evidence";
import {
  EVIDENCE_TO_PROVENANCE_KIND,
  evidenceProvenanceKind,
  provenanceKindStrength,
  RELATIONSHIP_STRENGTH,
} from "@repo/api/src/types/attribution-provenance-kind";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import type { ProvenanceRelationshipKind } from "@repo/api/src/types/provenance-relationship";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-pr-link-metadata";
import { Prisma, withDb } from "@repo/database";
import { branchLaneParticipationSql } from "./link-participation-sql";
import {
  branchLaneParticipationKind,
  linkTypesForKinds,
  PARTICIPATION_TO_KIND,
  relatedSessionSearchHaystack,
  sessionProvenanceLinkWhere,
  type TargetedSessionProvenanceContribution,
  type TargetedSessionProvenancePage,
  type TargetedSessionProvenancePageRow,
  targetedSessionProvenancePage,
} from "./provenance-eligibility";

/**
 * The evidence and participation naming one of the targets in an eligible
 * kind. Evidence is read as one row per target, session and relationship,
 * dated by its newest row, so a session's many tool calls on one artifact are
 * folded in the query rather than in memory.
 */
export async function readEvidenceProvenanceContributions(params: {
  organizationId: string;
  artifactIds: readonly string[];
  kinds: readonly ProvenanceRelationshipKind[];
}): Promise<TargetedSessionProvenanceContribution[]> {
  const targetIds = [...new Set(params.artifactIds)];
  if (targetIds.length === 0) {
    return [];
  }
  const relationshipKinds = evidenceKindsFor(params.kinds);
  const [evidence, links] = await Promise.all([
    relationshipKinds.length === 0
      ? []
      : withDb(
          (db) => db.$queryRaw<
            {
              targetArtifactId: string;
              agentSessionId: string;
              relationshipKind: string;
              occurredAt: Date;
            }[]
          >`
            SELECT target_artifact_id AS "targetArtifactId",
              agent_session_id AS "agentSessionId",
              relationship_kind AS "relationshipKind",
              max(coalesce(effective_at, invoked_at, created_at)) AS "occurredAt"
            FROM agent_session_operation_evidence
            WHERE organization_id = ${params.organizationId}::uuid
              AND target_artifact_id = ANY(${targetIds}::uuid[])
              AND relationship_kind = ANY(${relationshipKinds}::text[])
            GROUP BY target_artifact_id, agent_session_id, relationship_kind
          `
        ),
    withDb((db) =>
      db.artifactLink.findMany({
        where: {
          AND: [
            sessionProvenanceLinkWhere(
              params.organizationId,
              targetIds,
              params.kinds
            ),
            branchLaneLinkWhere(),
          ],
        },
        select: {
          sourceId: true,
          targetId: true,
          branchParticipation: true,
          metadata: true,
          lastContributedAt: true,
          createdAt: true,
        },
      })
    ),
  ]);
  return [
    ...evidence.flatMap((row) => {
      const kind = evidenceProvenanceKind(row.relationshipKind);
      return kind
        ? [
            {
              targetId: row.targetArtifactId,
              sessionArtifactId: row.agentSessionId,
              kind,
              occurredAt: row.occurredAt,
            },
          ]
        : [];
    }),
    ...links.flatMap((link) => {
      const kind = branchLaneParticipationKind(link);
      return kind
        ? [
            {
              targetId: link.targetId,
              sessionArtifactId: link.sourceId,
              kind,
              occurredAt: link.lastContributedAt ?? link.createdAt,
            },
          ]
        : [];
    }),
  ];
}

/**
 * Every link `branchLaneParticipationKind` can admit, and none of the slug-lane
 * mentions it always drops, so a widely mentioned target never loads them.
 */
export function branchLaneLinkWhere(): Prisma.ArtifactLinkWhereInput {
  return {
    OR: [
      { branchParticipation: { not: null } },
      { metadata: { path: ["prRefs"], not: Prisma.AnyNull } },
      {
        metadata: {
          path: ["linkKind"],
          equals: SessionArtifactLinkKind.SessionPr,
        },
      },
      {
        metadata: {
          path: ["linkKind"],
          equals: SessionArtifactLinkKind.SessionBranch,
        },
      },
      {
        metadata: {
          path: ["linkKinds"],
          array_contains: [SessionArtifactLinkKind.SessionBranch],
        },
      },
    ],
  };
}

/** The evidence relationships whose Related Sessions kind is one of `kinds`. */
function evidenceKindsFor(
  kinds: readonly ProvenanceRelationshipKind[]
): AttributionRelationshipKind[] {
  return RELATIONSHIP_STRENGTH.filter((relationship) =>
    kinds.includes(EVIDENCE_TO_PROVENANCE_KIND[relationship])
  );
}

/**
 * One row per target and session: the strongest eligible kind the session
 * holds on the target (PLN-2191 UI plan, "labeled by strongest class"), dated
 * by its newest eligible row so ordering still follows recency.
 */
export function strongestContributionsBySession(
  rows: readonly TargetedSessionProvenanceContribution[],
  eligibleKinds: readonly ProvenanceRelationshipKind[]
): TargetedSessionProvenanceContribution[] {
  const eligible = new Set<ProvenanceRelationshipKind>(eligibleKinds);
  const held = new Map<string, TargetedSessionProvenanceContribution>();
  for (const row of rows) {
    if (!eligible.has(row.kind)) {
      continue;
    }
    const key = `${row.targetId}\u0000${row.sessionArtifactId}`;
    const current = held.get(key);
    if (current === undefined) {
      held.set(key, row);
      continue;
    }
    held.set(key, {
      ...current,
      kind:
        provenanceKindStrength(row.kind) < provenanceKindStrength(current.kind)
          ? row.kind
          : current.kind,
      occurredAt:
        row.occurredAt > current.occurredAt
          ? row.occurredAt
          : current.occurredAt,
    });
  }
  return [...held.values()];
}

/**
 * The flag-on Related Sessions page for several targets: each session's
 * strongest eligible kind per target, dated by its newest eligible row, newest
 * first with ties broken by session id, at most `limit` per target, with each
 * target's total. Filtered, folded, ranked and counted in one statement so a
 * widely touched target never loads its whole population (apps/api/AGENTS.md,
 * "Do not materialize a platform-wide workload to emit a bounded top-N").
 */
export async function readLatestEvidenceProvenanceContributionsForTargets(params: {
  organizationId: string;
  artifactIds: readonly string[];
  kinds: readonly ProvenanceRelationshipKind[];
  limit: number;
  /** Only these sessions, as the legacy Related Sessions read narrows. */
  sessionArtifactIds?: readonly string[];
  /** Only sessions whose name, slug or id contains this, as the legacy read. */
  sessionSearch?: string;
}): Promise<TargetedSessionProvenancePage> {
  const { organizationId } = params;
  const targetIds = [...new Set(params.artifactIds)];
  if (targetIds.length === 0) {
    return { contributions: [], totalByTarget: new Map() };
  }
  const kindsByStrength = [...new Set(params.kinds)].sort(
    (a, b) => provenanceKindStrength(a) - provenanceKindStrength(b)
  );

  const rows = await withDb(
    (db) => db.$queryRaw<TargetedSessionProvenancePageRow[]>`
      WITH eligible AS (
        SELECT contribution."targetId",
          contribution."sessionArtifactId",
          array_position(${kindsByStrength}::text[], contribution.kind) AS strength,
          contribution."occurredAt"
        FROM (${eligibleEvidenceContributionsSql({
          organizationId,
          kinds: kindsByStrength,
          targetSql: (column) =>
            Prisma.sql`${column} = ANY(${targetIds}::uuid[])`,
          ...(params.sessionArtifactIds === undefined
            ? {}
            : { sessionArtifactIds: params.sessionArtifactIds }),
        })}) contribution
        WHERE (
            ${params.sessionSearch === undefined}
            OR EXISTS (
              SELECT 1
              FROM artifacts source
              INNER JOIN session_detail session ON session.artifact_id = source.id
              WHERE source.id = contribution."sessionArtifactId"
                AND source.organization_id = ${organizationId}::uuid
                AND strpos(${relatedSessionSearchHaystack()}, lower(${params.sessionSearch ?? ""})) > 0
            )
          )
      ),
      folded AS (
        SELECT "targetId",
          "sessionArtifactId",
          min(strength) AS strength,
          max("occurredAt") AS "occurredAt"
        FROM eligible
        GROUP BY "targetId", "sessionArtifactId"
      ),
      ranked AS (
        SELECT "targetId",
          "sessionArtifactId",
          strength,
          "occurredAt",
          COUNT(*) OVER (PARTITION BY "targetId") AS total,
          ROW_NUMBER() OVER (
            PARTITION BY "targetId"
            ORDER BY "occurredAt" DESC, "sessionArtifactId" ASC
          ) AS target_rank
        FROM folded
      )
      SELECT "targetId",
        "sessionArtifactId",
        (${kindsByStrength}::text[])[strength] AS kind,
        "occurredAt",
        total
      FROM ranked
      WHERE target_rank <= ${Math.max(1, params.limit)}
      ORDER BY "targetId" ASC, target_rank ASC
    `
  );
  return targetedSessionProvenancePage(rows);
}

/**
 * ISS-12552: the flag-on Related Sessions population as one SELECT of
 * `"targetId"`, `"sessionArtifactId"`, `kind` and `"occurredAt"`: evidence
 * rows in an eligible relationship plus branch and pull request lane
 * participation, each already one of `kinds`. Shared by the Related Sessions
 * page read and the project board's related sessions filter, so the board
 * keeps a card by the same evidence the cell counts (ISS-12929).
 */
export function eligibleEvidenceContributionsSql(input: {
  organizationId: string;
  kinds: readonly ProvenanceRelationshipKind[];
  /** A predicate over a target id column naming the targets. */
  targetSql: (column: Prisma.Sql) => Prisma.Sql;
  /** Only these sessions; every session when absent. */
  sessionArtifactIds?: readonly string[];
}): Prisma.Sql {
  const { organizationId } = input;
  const kinds = [...new Set(input.kinds)];
  const relationshipKinds = evidenceKindsFor(kinds);
  const participations = Object.values(BranchParticipationKind);
  const sessionFilter = (column: Prisma.Sql) =>
    Prisma.sql`(${input.sessionArtifactIds === undefined} OR ${column} = ANY(${input.sessionArtifactIds ?? []}::uuid[]))`;
  return Prisma.sql`SELECT contribution.*
    FROM (
      SELECT target_artifact_id AS "targetId",
        agent_session_id AS "sessionArtifactId",
        (${relationshipKinds.map((relationship) => EVIDENCE_TO_PROVENANCE_KIND[relationship])}::text[])[
          array_position(${relationshipKinds}::text[], relationship_kind)
        ] AS kind,
        coalesce(effective_at, invoked_at, created_at) AS "occurredAt"
      FROM agent_session_operation_evidence
      WHERE organization_id = ${organizationId}::uuid
        AND ${input.targetSql(Prisma.sql`target_artifact_id`)}
        AND relationship_kind = ANY(${relationshipKinds}::text[])
        AND ${sessionFilter(Prisma.sql`agent_session_id`)}
      UNION ALL
      SELECT al.target_id AS "targetId",
        al.source_id AS "sessionArtifactId",
        (${participations.map((participation) => PARTICIPATION_TO_KIND[participation])}::text[])[
          array_position(${participations}::text[], ${branchLaneParticipationSql()})
        ] AS kind,
        COALESCE(al.last_contributed_at, al.created_at) AS "occurredAt"
      FROM artifact_links al
      INNER JOIN artifacts source
        ON source.id = al.source_id
        AND source.organization_id = ${organizationId}::uuid
        AND source.type = ${ArtifactType.Session}::"ArtifactType"
      INNER JOIN session_detail session
        ON session.artifact_id = source.id
      INNER JOIN artifacts target
        ON target.id = al.target_id
        AND target.organization_id = ${organizationId}::uuid
      WHERE al.organization_id = ${organizationId}::uuid
        AND ${input.targetSql(Prisma.sql`al.target_id`)}
        AND al.link_type = ANY(${linkTypesForKinds(kinds)}::"LinkType"[])
        AND ${sessionFilter(Prisma.sql`al.source_id`)}
    ) contribution
    WHERE contribution.kind = ANY(${kinds}::text[])`;
}
