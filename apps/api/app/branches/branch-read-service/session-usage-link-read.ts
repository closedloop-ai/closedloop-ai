import { LinkType } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { ArtifactType, Prisma, type PrismaClient } from "@repo/database";
import {
  SessionPrLinkAudience,
  sessionPrLinkKindWhere,
} from "@/lib/session-pr-links";

export type SessionUsageLinkReadClient = Pick<
  PrismaClient,
  "$queryRaw" | "artifactLink"
>;

export type SessionUsageLink = {
  targetId: string;
  sourceId: string;
  branchParticipation: string | null;
  branchParticipationMethod: string | null;
  branchParticipationObservedAt: Date | null;
  metadata: Prisma.JsonValue | null;
  source: {
    name: string;
    slug: string | null;
    /**
     * ISS-8972: `artifacts.status` — the SESSION's stored lifecycle value, the
     * one status axis a session has. Read here rather than in a second
     * statement because this join already crosses the row; it is folded to a
     * display value at projection time and never written back.
     */
    status: string;
    session: {
      artifactId: string;
      externalSessionId: string;
      harness: string;
      sessionStartedAt: Date;
      sessionEndedAt: Date | null;
      /**
       * ISS-8972: genuine-activity instant (MAX event time floored at start).
       * Both the chip's date label and the staleness fold read it, so they
       * cannot disagree about when the Session last spoke.
       *
       * OPTIONAL even though `session_detail.last_activity_at` is NOT NULL
       * (ISS-6463, backfilled by PLN-1034), because the column being non-null is
       * a fact about the CLOUD TABLE, not about every value that reaches this
       * type: a producer that does not select it hands over `undefined` while
       * the annotation still says `Date`. That is the exported-type-vs-runtime
       * -shape defect, and it cost 94 suites — so the signature now admits what
       * the runtime can actually produce, and every reader must handle absence
       * rather than dereference it.
       */
      lastActivityAt?: Date;
      /**
       * ISS-8972 (whitlockk review): the Waiting projection's own inputs. The cloud
       * NEVER stores `waiting` — a blocked run stores `active` and carries
       * `awaiting_input_since` — so a chip derived from `status` alone reads
       * Active (or Stale) for a session that has been waiting on a human for
       * days. `projectDisplayedSessionStatus` needs all three to answer, and
       * `endsWithError` is what its ended-session reconciliation reads.
       */
      awaitingInputSince?: Date | null;
      endsWithError?: boolean | null;
      estimatedCost: { toString(): string } | number | null;
      inputTokens: bigint | number;
      outputTokens: bigint | number;
      cacheReadTokens: bigint | number;
      cacheWriteTokens: bigint | number;
      turns: number | null;
      toolUseCount: number;
      componentInvocationCount: number;
      billingMode: string | null;
      /**
       * The session's Owner, `artifacts.assignee_id` (ISS-12251 D-1). It feeds
       * the session-level owner surfaces: the linked-session chip ("Unknown
       * owner"), the "Session owner" timeline grouping and the per-owner usage
       * rollup (operator ruling, Kerensa Whitlock 2026-10-13: "The owner is the
       * assignee."). The Branch Owner's push rung is NOT this field: it names
       * the pushing session's creator (`readPushSessionCreators`).
       */
      ownerUserId: string | null;
    } | null;
  };
};

export type LinkedSession = NonNullable<SessionUsageLink["source"]["session"]>;

export const SESSION_USAGE_BRANCH_ID_CHUNK_SIZE = 1000;

const RAW_SESSION_USAGE_BRANCH_ID_THRESHOLD =
  SESSION_USAGE_BRANCH_ID_CHUNK_SIZE;

type RawSessionUsageLinkRow = {
  targetId: string;
  sourceId: string;
  branchParticipation: string | null;
  branchParticipationMethod: string | null;
  branchParticipationObservedAt: Date | null;
  metadata: Prisma.JsonValue | null;
  sourceName: string;
  sourceSlug: string | null;
  sourceStatus: string;
  sessionArtifactId: string;
  externalSessionId: string;
  harness: string;
  sessionStartedAt: Date;
  sessionEndedAt: Date | null;
  lastActivityAt: Date;
  awaitingInputSince: Date | null;
  endsWithError: boolean | null;
  estimatedCost: { toString(): string } | number | null;
  inputTokens: bigint | number;
  outputTokens: bigint | number;
  cacheReadTokens: bigint | number;
  cacheWriteTokens: bigint | number;
  turns: number | null;
  toolUseCount: number;
  componentInvocationCount: number;
  billingMode: string | null;
  /**
   * `source.assignee_id`, the session's Owner; `sessionUsageLinkFromRawRow`
   * maps it to `session.ownerUserId`.
   */
  userId: string | null;
};

export function sessionLinkWhere(
  organizationId: string,
  branchIds: string[],
  options: {
    includeReviewedIdentityEvidence?: boolean;
  } = {}
): Prisma.ArtifactLinkWhereInput {
  return {
    organizationId,
    targetId: { in: branchIds },
    linkType: LinkType.RelatesTo,
    AND: [
      { OR: sessionBranchUsageLinkKindWhere() },
      { OR: sessionBranchParticipationWhere(options) },
    ],
    source: {
      organizationId,
      type: ArtifactType.SESSION,
      session: { isNot: null },
    },
    target: {
      organizationId,
      type: ArtifactType.BRANCH,
    },
  };
}

export function sessionBranchUsageLinkKindWhere(): Prisma.ArtifactLinkWhereInput[] {
  return [
    // ISS-5823 Metric: this predicate feeds the Branches corpus AND the 1/N
    // even-split cost divisor, so a prose-derived link would dilute every
    // other branch's attributed spend.
    sessionPrLinkKindWhere(SessionPrLinkAudience.Metric),
    {
      metadata: {
        path: ["linkKind"],
        equals: SessionArtifactLinkKind.SessionBranch,
      },
    },
  ];
}

export function sessionBranchParticipationWhere(
  options: { includeReviewedIdentityEvidence?: boolean } = {}
): Prisma.ArtifactLinkWhereInput[] {
  const legacyOrWritten: Prisma.ArtifactLinkWhereInput[] = [
    { branchParticipation: BranchParticipationKind.Wrote },
    { branchParticipation: null },
  ];
  if (!options.includeReviewedIdentityEvidence) {
    return legacyOrWritten;
  }
  return [
    ...legacyOrWritten,
    { branchParticipation: BranchParticipationKind.Reviewed },
  ];
}

export async function readSessionUsageLinks(
  db: SessionUsageLinkReadClient,
  organizationId: string,
  branchIds: string[],
  options: {
    includeReviewedIdentityEvidence: boolean;
  }
): Promise<SessionUsageLink[]> {
  if (branchIds.length < RAW_SESSION_USAGE_BRANCH_ID_THRESHOLD) {
    return readSessionUsageLinksWithPrisma(db, organizationId, branchIds, {
      includeReviewedIdentityEvidence: options.includeReviewedIdentityEvidence,
    });
  }
  const rows = await db.$queryRaw<RawSessionUsageLinkRow[]>(Prisma.sql`
    SELECT
      al.target_id AS "targetId",
      al.source_id AS "sourceId",
      al.branch_participation AS "branchParticipation",
      al.branch_participation_method AS "branchParticipationMethod",
      al.branch_participation_observed_at AS "branchParticipationObservedAt",
      al.metadata AS metadata,
      source.name AS "sourceName",
      source.slug AS "sourceSlug",
      source.status AS "sourceStatus",
      session.artifact_id AS "sessionArtifactId",
      session.external_session_id AS "externalSessionId",
      session.harness AS harness,
      session.session_started_at AS "sessionStartedAt",
      session.session_ended_at AS "sessionEndedAt",
      session.last_activity_at AS "lastActivityAt",
      session.awaiting_input_since AS "awaitingInputSince",
      session.ends_with_error AS "endsWithError",
      session.estimated_cost AS "estimatedCost",
      session.input_tokens AS "inputTokens",
      session.output_tokens AS "outputTokens",
      session.cache_read_tokens AS "cacheReadTokens",
      session.cache_write_tokens AS "cacheWriteTokens",
      session.turns AS turns,
      session.tool_use_count AS "toolUseCount",
      session.component_invocation_count AS "componentInvocationCount",
      session.billing_mode AS "billingMode",
      source.assignee_id AS "userId"
    FROM artifact_links al
    INNER JOIN artifacts source
      ON source.id = al.source_id
      AND source.organization_id = ${organizationId}::uuid
      AND source.type = ${ArtifactType.SESSION}::"ArtifactType"
    INNER JOIN session_detail session
      ON session.artifact_id = source.id
    INNER JOIN artifacts target
      ON target.id = al.target_id
      AND target.organization_id = ${organizationId}::uuid
      AND target.type = ${ArtifactType.BRANCH}::"ArtifactType"
    WHERE al.organization_id = ${organizationId}::uuid
      AND al.target_id IN (${Prisma.join(branchIds)})
      AND al.link_type = ${LinkType.RelatesTo}::"LinkType"
      AND (
        al.metadata->>'linkKind' = ${SessionArtifactLinkKind.SessionPr}
        OR al.metadata->>'linkKind' = ${SessionArtifactLinkKind.SessionBranch}
        OR al.metadata->'linkKinds' ? ${SessionArtifactLinkKind.SessionPrSet}
      )
      AND ${branchParticipationSql(options.includeReviewedIdentityEvidence)}
    ORDER BY al.target_id ASC, al.source_id ASC, al.id ASC
  `);
  return rows.map(sessionUsageLinkFromRawRow);
}

async function readSessionUsageLinksWithPrisma(
  db: SessionUsageLinkReadClient,
  organizationId: string,
  branchIds: string[],
  options: {
    includeReviewedIdentityEvidence: boolean;
  }
): Promise<SessionUsageLink[]> {
  const links = await db.artifactLink.findMany({
    where: sessionLinkWhere(organizationId, branchIds, {
      includeReviewedIdentityEvidence: options.includeReviewedIdentityEvidence,
    }),
    select: {
      targetId: true,
      sourceId: true,
      branchParticipation: true,
      branchParticipationMethod: true,
      branchParticipationObservedAt: true,
      metadata: true,
      source: {
        select: {
          name: true,
          slug: true,
          status: true,
          assigneeId: true,
          session: {
            select: {
              artifactId: true,
              externalSessionId: true,
              harness: true,
              sessionStartedAt: true,
              sessionEndedAt: true,
              lastActivityAt: true,
              awaitingInputSince: true,
              endsWithError: true,
              estimatedCost: true,
              inputTokens: true,
              outputTokens: true,
              cacheReadTokens: true,
              cacheWriteTokens: true,
              turns: true,
              toolUseCount: true,
              componentInvocationCount: true,
              billingMode: true,
            },
          },
        },
      },
    },
  });
  return links.map(
    ({ source: { assigneeId, session, ...source }, ...link }) => ({
      ...link,
      source: {
        ...source,
        session: session ? { ...session, ownerUserId: assigneeId } : null,
      },
    })
  );
}

function sessionUsageLinkFromRawRow(
  row: RawSessionUsageLinkRow
): SessionUsageLink {
  return {
    targetId: row.targetId,
    sourceId: row.sourceId,
    branchParticipation: row.branchParticipation,
    branchParticipationMethod: row.branchParticipationMethod,
    branchParticipationObservedAt: row.branchParticipationObservedAt,
    metadata: row.metadata,
    source: {
      name: row.sourceName,
      slug: row.sourceSlug,
      status: row.sourceStatus,
      session: {
        artifactId: row.sessionArtifactId,
        externalSessionId: row.externalSessionId,
        harness: row.harness,
        sessionStartedAt: row.sessionStartedAt,
        sessionEndedAt: row.sessionEndedAt,
        lastActivityAt: row.lastActivityAt,
        awaitingInputSince: row.awaitingInputSince,
        endsWithError: row.endsWithError,
        estimatedCost: row.estimatedCost,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        turns: row.turns,
        toolUseCount: row.toolUseCount,
        componentInvocationCount: row.componentInvocationCount,
        billingMode: row.billingMode,
        ownerUserId: row.userId,
      },
    },
  };
}

function branchParticipationSql(
  includeReviewedIdentityEvidence: boolean
): Prisma.Sql {
  const values = includeReviewedIdentityEvidence
    ? [BranchParticipationKind.Wrote, BranchParticipationKind.Reviewed]
    : [BranchParticipationKind.Wrote];
  return Prisma.sql`(
    al.branch_participation IS NULL
    OR al.branch_participation IN (${Prisma.join(values)})
  )`;
}
