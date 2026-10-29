import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import {
  BranchLifecycleBoundaryKind,
  BranchParticipationKind,
  normalizeBranchParticipationKind,
} from "@repo/api/src/types/branch";
import {
  ProvenanceRelationshipKind,
  RELATED_SESSION_ELIGIBLE_KINDS,
} from "@repo/api/src/types/provenance-relationship";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  deriveBranchParticipationFromMetadata,
  parseSessionPrLinkMetadata,
  persistedArtifactRefRelationSchema,
  roleFromMethod,
  SessionArtifactLinkKind,
  SessionArtifactLinkRole,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { hasSessionPrLinkKind } from "@repo/api/src/types/session-pr-link-metadata";
import { Prisma, withDb } from "@repo/database";
import { z } from "zod";

/**
 * ISS-7234 — the ONE definition of "how does this session relate to this
 * artifact". Related Sessions consumes it today; the artifact Sessions tab (S2)
 * is the second consumer it is shaped for, and widens the kind set rather than
 * deriving eligibility again.
 *
 * The precedent is `project-link-where.ts` in this same directory: two
 * hand-written copies of an eligibility shape is precisely how one surface ends
 * up disagreeing with another. Here the stakes are higher than a facet count —
 * a second derivation would let a session that merely MENTIONED a document be
 * presented as having written it.
 *
 * Provenance lives on `artifact_links` (plus the invocation stream below); the
 * edges are the provenance record.
 */

/**
 * Persisted `ArtifactRefRelation` → relationship kind. Exhaustive by
 * construction: a seventh relation with no entry here fails `tsc`, so a new
 * evidence shape cannot silently inherit whatever default a `??` would pick.
 */
const RELATION_TO_KIND: Record<
  ArtifactRefRelation,
  ProvenanceRelationshipKind
> = {
  [ArtifactRefRelation.Created]: ProvenanceRelationshipKind.Contribution,
  [ArtifactRefRelation.Output]: ProvenanceRelationshipKind.Contribution,
  [ArtifactRefRelation.Reviewed]: ProvenanceRelationshipKind.Comment,
  [ArtifactRefRelation.Input]: ProvenanceRelationshipKind.Usage,
  [ArtifactRefRelation.Workspace]: ProvenanceRelationshipKind.Usage,
  [ArtifactRefRelation.Referenced]: ProvenanceRelationshipKind.Reference,
};

/**
 * Persisted `SessionArtifactLinkRole` → relationship kind, for the links that
 * carry no `relation`. `slug-links.ts` writes `role`/`method` on EVERY row and
 * `relation` only "when present", so without this fallback an MCP-tool-call
 * input link would be reported as a prose mention. Exhaustive, like the map
 * above.
 */
const ROLE_TO_KIND: Record<
  SessionArtifactLinkRole,
  ProvenanceRelationshipKind
> = {
  [SessionArtifactLinkRole.Input]: ProvenanceRelationshipKind.Usage,
  [SessionArtifactLinkRole.Workspace]: ProvenanceRelationshipKind.Usage,
  [SessionArtifactLinkRole.Referenced]: ProvenanceRelationshipKind.Reference,
};

/** Lookup by a Map: the key is untrusted persisted JSON. */
const ROLE_LOOKUP = new Map<string, SessionArtifactLinkRole>(
  Object.keys(ROLE_TO_KIND).map((role) => [
    role,
    role as SessionArtifactLinkRole,
  ])
);

const linkClassificationMetadataSchema = z
  .object({
    relation: persistedArtifactRefRelationSchema,
    role: z.string().optional(),
    method: z.string().optional(),
    isPrimary: z.boolean().optional(),
  })
  .passthrough();

/**
 * The role this link states, or the one its always-present `method` implies.
 * `roleFromMethod` is the repo's canonical reconstruction for a relation-less
 * link; re-deriving it here is how the two surfaces would come to disagree.
 */
function roleForLink(
  role: string | undefined,
  method: string | undefined,
  isPrimary: boolean
): SessionArtifactLinkRole | undefined {
  const stated = role === undefined ? undefined : ROLE_LOOKUP.get(role);
  if (stated !== undefined) {
    return stated;
  }
  return method === undefined ? undefined : roleFromMethod(method, isPrimary);
}

/**
 * Which persisted `link_type` can carry each kind, so a caller asking only for
 * contributions never reads lineage rows it would discard. `null` marks a kind
 * that is not link-sourced at all — asking only for invocations issues no
 * `artifact_links` query. Exhaustive: a seventh kind fails `tsc` here too.
 */
const KIND_TO_LINK_TYPE: Record<ProvenanceRelationshipKind, LinkType | null> = {
  [ProvenanceRelationshipKind.Contribution]: LinkType.RelatesTo,
  [ProvenanceRelationshipKind.Comment]: LinkType.RelatesTo,
  [ProvenanceRelationshipKind.Usage]: LinkType.RelatesTo,
  [ProvenanceRelationshipKind.Reference]: LinkType.RelatesTo,
  [ProvenanceRelationshipKind.Production]: LinkType.Produces,
  [ProvenanceRelationshipKind.Invocation]: null,
};

export function linkTypesForKinds(
  kinds: readonly ProvenanceRelationshipKind[]
): LinkType[] {
  return [
    ...new Set(
      kinds
        .map((kind) => KIND_TO_LINK_TYPE[kind])
        .filter((linkType): linkType is LinkType => linkType !== null)
    ),
  ];
}

/**
 * Ceiling on the caller-supplied component ids that reach one `IN (...)`: an
 * unbounded list bloats the plan and can cross Postgres' bind-parameter limit.
 *
 * Over-cap input THROWS rather than slicing. A sibling bound may truncate when
 * it also REPORTS it (the detail's `sessionsTabTruncated`); this query
 * returns a bare id list with no truncation channel, so a silent slice would
 * hand a caller a short provenance answer that reads as complete. Callers are
 * server-side, so an over-cap list is a programming error, not user input.
 */
const MAX_PROVENANCE_COMPONENT_IN_IDS = 1000;

export type SessionProvenanceEvidence = {
  sessionArtifactId: string;
  kind: ProvenanceRelationshipKind;
};

/**
 * ISS-7235: one evidence row plus WHEN it happened.
 *
 * The timestamp is carried on the evidence stream rather than fetched by a
 * second query because the Related Sessions field orders by newest
 * CONTRIBUTION, and a contribution time is a property of the edge, not of the
 * session. Reading it separately would mean a second `artifact_links` predicate
 * — the exact duplication ISS-7234 exists to prevent — and ordering by the
 * session's own recency instead would let a session that touched the artifact
 * once, long ago, sort above one that revised it this morning.
 *
 * A widening of {@link SessionProvenanceEvidence}, not a replacement: callers
 * that only need eligibility keep the narrower shape.
 */
export type SessionProvenanceContribution = SessionProvenanceEvidence & {
  occurredAt: Date;
};

export type TargetedSessionProvenanceContribution =
  SessionProvenanceContribution & {
    targetId: string;
  };

export type TargetedSessionProvenancePage = {
  contributions: TargetedSessionProvenanceContribution[];
  totalByTarget: Map<string, number>;
};

/**
 * Branch participation → relationship kind. `wrote` and `reviewed` are the two
 * durable participation verdicts the repo already derives; they land on the two
 * kinds Related Sessions admits. Exhaustive, like the maps above.
 */
export const PARTICIPATION_TO_KIND: Record<
  BranchParticipationKind,
  ProvenanceRelationshipKind
> = {
  [BranchParticipationKind.Wrote]: ProvenanceRelationshipKind.Contribution,
  [BranchParticipationKind.Reviewed]: ProvenanceRelationshipKind.Comment,
};

/**
 * The participation this link states, read the way every other consumer reads
 * it: the `branch_participation` COLUMN first, then
 * `deriveBranchParticipationFromMetadata` for pre-column rows. Same order as
 * `branchParticipationForLink` in the branch read service; the multi-field rule
 * itself (`branchParticipation` / `relationTypes` / `relation` / `method` /
 * `branchLifecycleEvents`) is NOT restated here — it stays owned by that one
 * `packages/api` helper, so this path cannot drift from it.
 */
function participationForLink(link: {
  branchParticipation?: string | null;
  metadata: unknown;
}): BranchParticipationKind | undefined {
  const stated = normalizeBranchParticipationKind(link.branchParticipation);
  if (stated !== undefined) {
    return stated;
  }
  return deriveBranchParticipationFromMetadata(
    parseSessionPrLinkMetadata(link.metadata)
  );
}

/**
 * ISS-12552: the kind a link's branch participation states, or undefined when
 * it states none. Under `attribution-evidence-policy` this is the only link
 * evidence that still classifies: repository write participation stays
 * evidence (PRD-800 "Durable result"), and every other link is mention-only.
 */
export function participationProvenanceKind(link: {
  branchParticipation?: string | null;
  metadata: unknown;
}): ProvenanceRelationshipKind | undefined {
  const participation = participationForLink(link);
  return participation === undefined
    ? undefined
    : PARTICIPATION_TO_KIND[participation];
}

const linkKindsSchema = z
  .object({
    linkKind: z.string().nullish(),
    linkKinds: z.array(z.string()).nullish(),
  })
  .loose();

/**
 * ISS-12552 (PRD-800 "Links without evidence"): participation as
 * flag-on evidence comes only from the branch and pull request lanes, which
 * record repository work. A slug-lane `relation` of created or output is a
 * mention, never participation.
 */
export function branchLaneParticipationKind(link: {
  branchParticipation?: string | null;
  metadata: unknown;
}): ProvenanceRelationshipKind | undefined {
  const kinds = linkKindsSchema.safeParse(link.metadata).data;
  const fromBranchLane =
    normalizeBranchParticipationKind(link.branchParticipation) !== undefined ||
    hasSessionPrLinkKind(link.metadata) ||
    kinds?.linkKind === SessionArtifactLinkKind.SessionBranch ||
    kinds?.linkKinds?.includes(SessionArtifactLinkKind.SessionBranch) === true;
  return fromBranchLane ? participationProvenanceKind(link) : undefined;
}

/**
 * Classify one persisted link, preferring the strongest evidence it carries:
 * the link type, then the branch participation the row states across any of its
 * five evidence fields, then the stated `relation`, then the `role`/`method`
 * every row has. Only a link that states none of those is reported as
 * `Reference`, and that floor is deliberate — unreadable metadata must never be
 * able to manufacture a contribution.
 *
 * Participation outranks `relation` because a branch/PR link routinely carries a
 * PASSIVE relation alongside ACTIVE evidence: a `gh pr review` write is
 * persisted as `relation: workspace` + `method: pr_review_feedback_command`, and
 * reading the relation alone classified that review as usage, failing
 * `RELATED_SESSION_ELIGIBLE_KINDS` and silently emptying Related Sessions of the
 * sessions that actually reviewed the artifact.
 */
export function classifySessionLinkKind(link: {
  linkType: string;
  branchParticipation?: string | null;
  metadata: unknown;
}): ProvenanceRelationshipKind {
  if (link.linkType === LinkType.Produces) {
    return ProvenanceRelationshipKind.Production;
  }
  const participation = participationForLink(link);
  if (participation !== undefined) {
    return PARTICIPATION_TO_KIND[participation];
  }
  const parsed = linkClassificationMetadataSchema.safeParse(link.metadata);
  if (!parsed.success) {
    return ProvenanceRelationshipKind.Reference;
  }
  const { relation, role, method, isPrimary } = parsed.data;
  if (relation !== undefined) {
    return RELATION_TO_KIND[relation];
  }
  const resolved = roleForLink(role, method, isPrimary ?? false);
  return resolved === undefined
    ? ProvenanceRelationshipKind.Reference
    : ROLE_TO_KIND[resolved];
}

/**
 * Session→artifact provenance edges for one artifact, org-scoped on BOTH
 * endpoints: the link row, the source session artifact, and the target. A
 * provenance answer names which sessions touched which artifact, so a single
 * unscoped endpoint here is a cross-tenant disclosure, not a wrong count.
 */
export function sessionProvenanceLinkWhere(
  organizationId: string,
  artifactId: string | readonly string[],
  kinds: readonly ProvenanceRelationshipKind[]
): Prisma.ArtifactLinkWhereInput {
  const targetId =
    typeof artifactId === "string"
      ? artifactId
      : { in: [...new Set(artifactId)] };
  return {
    organizationId,
    targetId,
    linkType: { in: linkTypesForKinds(kinds) },
    source: {
      is: {
        organizationId,
        type: ArtifactType.Session,
        session: { isNot: null },
      },
    },
    target: { is: { organizationId } },
  };
}

export async function readLatestRelatedSessionContributionsForTargets(params: {
  organizationId: string;
  artifactIds: readonly string[];
  limit: number;
  /** Filter the evidence cohort before ranking; never filter the eight pills. */
  sessionArtifactIds?: readonly string[];
  sessionSearch?: string;
}): Promise<TargetedSessionProvenancePage> {
  const { organizationId, artifactIds } = params;
  const targetIds = [...new Set(artifactIds)];
  const rowLimit = Math.max(1, params.limit);
  if (targetIds.length === 0) {
    return { contributions: [], totalByTarget: new Map() };
  }

  const rows = await withDb(
    (db) =>
      db.$queryRaw<TargetedSessionProvenancePageRow[]>`
      WITH ${classifiedSessionLinkCtes({
        organizationId,
        sessionArtifactIds: params.sessionArtifactIds,
        sessionSearch: params.sessionSearch,
        targetSql: Prisma.sql`al.target_id = ANY(${targetIds}::uuid[])`,
      })},
      latest_eligible_by_session AS (
        SELECT
          "targetId",
          "sessionArtifactId",
          kind,
          "occurredAt",
          ROW_NUMBER() OVER (
            PARTITION BY "targetId", "sessionArtifactId"
            ORDER BY "occurredAt" DESC, "createdAt" ASC, kind ASC
          ) AS session_rank
        FROM classified_links
        WHERE kind IS NOT NULL
      ),
      ranked_targets AS (
        SELECT
          "targetId",
          "sessionArtifactId",
          kind,
          "occurredAt",
          COUNT(*) OVER (PARTITION BY "targetId") AS total,
          ROW_NUMBER() OVER (
            PARTITION BY "targetId"
            ORDER BY "occurredAt" DESC, "sessionArtifactId" ASC
          ) AS target_rank
        FROM latest_eligible_by_session
        WHERE session_rank = 1
      )
      SELECT
        "targetId",
        "sessionArtifactId",
        kind,
        "occurredAt",
        total
      FROM ranked_targets
      WHERE target_rank <= ${rowLimit}
      ORDER BY "targetId" ASC, target_rank ASC
    `
  );

  return targetedSessionProvenancePage(rows);
}

/**
 * Sessions whose evidence includes at least one eligible kind, deduped and in
 * first-seen order. Pure, so both call sites can be proven to agree on the same
 * evidence without a database.
 */
export function selectEligibleSessionIds(
  evidence: readonly SessionProvenanceEvidence[],
  eligibleKinds: readonly ProvenanceRelationshipKind[]
): string[] {
  const eligible = new Set<ProvenanceRelationshipKind>(eligibleKinds);
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const row of evidence) {
    if (!eligible.has(row.kind) || seen.has(row.sessionArtifactId)) {
      continue;
    }
    seen.add(row.sessionArtifactId);
    selected.push(row.sessionArtifactId);
  }
  return selected;
}

/**
 * Read every provenance edge for one subject from both evidence streams.
 *
 * `agentComponentIds` names the components whose invocations count as runtime
 * evidence for this subject. Invocation rows live on
 * `agent_component_session_usage`, not `artifact_links` — an agent component is
 * not an `Artifact` row — which is exactly why an invocation-only session is
 * representable without ever being mistaken for a contribution.
 */
export async function readSessionProvenanceEvidence(params: {
  organizationId: string;
  artifactId: string;
  kinds: readonly ProvenanceRelationshipKind[];
  agentComponentIds?: readonly string[];
}): Promise<SessionProvenanceContribution[]> {
  const { organizationId, artifactId, kinds, agentComponentIds = [] } = params;
  const evidence: SessionProvenanceContribution[] = [];

  if (linkTypesForKinds(kinds).length > 0) {
    const links = await withDb((db) =>
      db.artifactLink.findMany({
        where: sessionProvenanceLinkWhere(organizationId, artifactId, kinds),
        select: {
          sourceId: true,
          linkType: true,
          branchParticipation: true,
          metadata: true,
          lastContributedAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      })
    );
    for (const link of links) {
      evidence.push({
        sessionArtifactId: link.sourceId,
        kind: classifySessionLinkKind(link),
        // ISS-7669: `lastContributedAt` is the edge's most recent restatement
        // and is the honest answer to "newest contribution"; `createdAt` is
        // pinned at the sync that first created the row and cannot move, so
        // reading it reported a session's FIRST reference as its latest — a
        // session that created a doc at 09:00 and revised it at 17:00 read
        // 09:00. Nullable for rows written before the column existed, and
        // those fall back to the row's own creation rather than to `now()`,
        // which would re-date every legacy edge to whenever the page loaded.
        // Exactly the shape the invocation stream below already uses for
        // `lastInvokedAt`.
        occurredAt: link.lastContributedAt ?? link.createdAt,
      });
    }
  }

  const wantsInvocation = kinds.includes(ProvenanceRelationshipKind.Invocation);
  if (!wantsInvocation || agentComponentIds.length === 0) {
    return evidence;
  }

  const componentIds = [...new Set(agentComponentIds)];
  if (componentIds.length > MAX_PROVENANCE_COMPONENT_IN_IDS) {
    throw new Error(
      `readSessionProvenanceEvidence: ${componentIds.length} agentComponentIds exceeds ${MAX_PROVENANCE_COMPONENT_IN_IDS}; chunk the call rather than reading a truncated provenance answer.`
    );
  }

  const invocations = await withDb((db) =>
    db.agentComponentSessionUsage.findMany({
      where: {
        agentComponentId: { in: componentIds },
        agentComponent: { is: { organizationId } },
        session: { is: { artifact: { is: { organizationId } } } },
      },
      select: {
        agentSessionId: true,
        lastInvokedAt: true,
        createdAt: true,
      },
    })
  );

  for (const usage of invocations) {
    evidence.push({
      sessionArtifactId: usage.agentSessionId,
      kind: ProvenanceRelationshipKind.Invocation,
      // `lastInvokedAt` is the bucket's most recent run and is the honest
      // answer; it is nullable for rows written before the column existed, and
      // those fall back to the row's own creation rather than to `now()`, which
      // would date every legacy invocation to whenever the page was loaded.
      occurredAt: usage.lastInvokedAt ?? usage.createdAt,
    });
  }
  return evidence;
}

/**
 * THE eligibility query. Callers differ only in the `kinds` they ask for; none
 * re-derives what counts as evidence. Defaults to the Related Sessions set, so
 * the narrow contribution-based answer is what a caller gets by omission.
 */
export async function listEligibleSessionArtifactIds(params: {
  organizationId: string;
  artifactId: string;
  kinds?: readonly ProvenanceRelationshipKind[];
  agentComponentIds?: readonly string[];
}): Promise<string[]> {
  const kinds = params.kinds ?? RELATED_SESSION_ELIGIBLE_KINDS;
  const evidence = await readSessionProvenanceEvidence({ ...params, kinds });
  return selectEligibleSessionIds(evidence, kinds);
}

/**
 * ISS-7235: one row per eligible session, carrying that session's MOST RECENT
 * contributing interaction, newest first.
 *
 * The eligibility decision is not made here — it is the same `eligibleKinds`
 * membership test {@link selectEligibleSessionIds} applies to the same evidence
 * stream, both fed by {@link readSessionProvenanceEvidence}. What this adds is
 * the reduction a timeline needs and an id list cannot express: of the several
 * edges a session may have to one artifact, keep the latest.
 *
 * Ties break on `sessionArtifactId` so a page reload cannot reshuffle two
 * contributions recorded in the same millisecond. Sorting on the timestamp
 * alone is not a total order, and an unstable one shows the reader a different
 * list for the same data.
 */
export function selectLatestEligibleContributions(
  evidence: readonly SessionProvenanceContribution[],
  eligibleKinds: readonly ProvenanceRelationshipKind[]
): SessionProvenanceContribution[] {
  const eligible = new Set<ProvenanceRelationshipKind>(eligibleKinds);
  const latest = new Map<string, SessionProvenanceContribution>();
  for (const row of evidence) {
    if (!eligible.has(row.kind)) {
      continue;
    }
    const held = latest.get(row.sessionArtifactId);
    if (held === undefined || row.occurredAt > held.occurredAt) {
      latest.set(row.sessionArtifactId, row);
    }
  }
  return sortContributions([...latest.values()]);
}

/**
 * The timestamped sibling of {@link listEligibleSessionArtifactIds}: the same
 * query, the same kinds, the same classification, reduced to one dated row per
 * session instead of a bare id. A surface that needs both the membership and
 * the ordering calls this one rather than pairing the id list with a second
 * read of the same edges.
 */
export async function listEligibleSessionContributions(params: {
  organizationId: string;
  artifactId: string;
  kinds?: readonly ProvenanceRelationshipKind[];
  agentComponentIds?: readonly string[];
}): Promise<SessionProvenanceContribution[]> {
  const kinds = params.kinds ?? RELATED_SESSION_ELIGIBLE_KINDS;
  const evidence = await readSessionProvenanceEvidence({ ...params, kinds });
  return selectLatestEligibleContributions(evidence, kinds);
}

function sortContributions<T extends SessionProvenanceContribution>(
  contributions: T[]
): T[] {
  return contributions.sort((a, b) => {
    const byTime = b.occurredAt.getTime() - a.occurredAt.getTime();
    return byTime === 0
      ? a.sessionArtifactId.localeCompare(b.sessionArtifactId)
      : byTime;
  });
}

export type TargetedSessionProvenancePageRow = {
  targetId: string;
  sessionArtifactId: string;
  kind: ProvenanceRelationshipKind;
  occurredAt: Date;
  total: bigint | number;
};

function dbCountToNumber(count: bigint | number): number {
  return typeof count === "bigint" ? Number(count) : count;
}

/**
 * What a Related Sessions search matches, over `session` (session_detail) and
 * `source` (the session artifact): its name, slug and id, lowercased. One
 * expression, so the legacy and evidence reads filter alike.
 */
export function relatedSessionSearchHaystack(): Prisma.Sql {
  return Prisma.sql`lower(COALESCE(session.name_override, source.name, '') || ' ' || COALESCE(source.slug, '') || ' ' || source.id::text)`;
}

/** A ranked per-target page statement's rows as the page they encode. */
export function targetedSessionProvenancePage(
  rows: readonly TargetedSessionProvenancePageRow[]
): TargetedSessionProvenancePage {
  return {
    contributions: rows.map((row) => ({
      targetId: row.targetId,
      sessionArtifactId: row.sessionArtifactId,
      kind: row.kind,
      occurredAt: row.occurredAt,
    })),
    totalByTarget: new Map(
      rows.map((row) => [row.targetId, dbCountToNumber(row.total)])
    ),
  };
}

/**
 * The `candidate_links` and `classified_links` CTEs: every RELATES_TO link
 * from a session to a target that `targetSql` admits, with the relationship
 * kind its metadata states, NULL when the link is not eligible evidence. A
 * target has related sessions exactly when one of its links classifies.
 *
 * Shared by the related-sessions read above and the project board's related
 * sessions filter (ISS-12929), so a board card is kept by the same evidence
 * the list's Related Sessions cell counts.
 */
export function classifiedSessionLinkCtes(input: {
  organizationId: string;
  sessionArtifactIds?: readonly string[];
  sessionSearch?: string;
  /** A predicate over `al`, the link row, naming the targets. */
  targetSql: Prisma.Sql;
}): Prisma.Sql {
  return Prisma.sql`candidate_links AS (
        SELECT
          al.target_id AS "targetId",
          al.source_id AS "sessionArtifactId",
          COALESCE(al.last_contributed_at, al.created_at) AS "occurredAt",
          al.created_at AS "createdAt",
          al.metadata,
          CASE
            WHEN al.branch_participation IN (
              ${BranchParticipationKind.Wrote},
              ${BranchParticipationKind.Reviewed}
            ) THEN al.branch_participation
            ELSE NULL
          END AS "statedBranchParticipation",
          (
            jsonb_typeof(al.metadata) = 'object'
            AND (
              NOT (al.metadata ? 'confidence')
              OR (
                jsonb_typeof(al.metadata->'confidence') = 'number'
                AND (al.metadata->>'confidence')::numeric >= 0
                AND (al.metadata->>'confidence')::numeric <= 1
              )
            )
            AND (
              NOT (al.metadata ? 'method')
              OR (
                jsonb_typeof(al.metadata->'method') = 'string'
                AND al.metadata->>'method' <> ''
              )
            )
            AND (
              NOT (al.metadata ? 'linkKind')
              OR al.metadata->>'linkKind' IN (
                ${SessionArtifactLinkKind.SessionPr},
                ${SessionArtifactLinkKind.SessionPrProse},
                ${SessionArtifactLinkKind.SessionBranch}
              )
            )
            AND (
              NOT (al.metadata ? 'linkKinds')
              OR jsonb_typeof(al.metadata->'linkKinds') = 'array'
            )
            AND (
              NOT (al.metadata ? 'repositoryFullName')
              OR (
                jsonb_typeof(al.metadata->'repositoryFullName') = 'string'
                AND al.metadata->>'repositoryFullName' <> ''
              )
            )
            AND (
              NOT (al.metadata ? 'prNumber')
              OR (
                jsonb_typeof(al.metadata->'prNumber') = 'number'
                AND al.metadata->>'prNumber' ~ '^[0-9]+$'
                AND (al.metadata->>'prNumber')::numeric > 0
              )
            )
            AND (
              NOT (al.metadata ? 'prRefs')
              OR jsonb_typeof(al.metadata->'prRefs') = 'array'
            )
            AND (
              NOT (al.metadata ? 'relationTypes')
              OR jsonb_typeof(al.metadata->'relationTypes') = 'array'
            )
            AND (
              NOT (al.metadata ? 'branchLifecycleEvents')
              OR jsonb_typeof(al.metadata->'branchLifecycleEvents') = 'array'
            )
          ) AS "sessionPrMetadataValid",
          (
            jsonb_typeof(al.metadata) = 'object'
            AND (
              NOT (al.metadata ? 'role')
              OR jsonb_typeof(al.metadata->'role') = 'string'
            )
            AND (
              NOT (al.metadata ? 'method')
              OR jsonb_typeof(al.metadata->'method') = 'string'
            )
            AND (
              NOT (al.metadata ? 'isPrimary')
              OR jsonb_typeof(al.metadata->'isPrimary') = 'boolean'
            )
          ) AS "classificationMetadataValid"
        FROM artifact_links al
        INNER JOIN artifacts source
          ON source.id = al.source_id
          AND source.organization_id = ${input.organizationId}::uuid
          AND source.type = ${ArtifactType.Session}::"ArtifactType"
        INNER JOIN session_detail session
          ON session.artifact_id = source.id
        INNER JOIN artifacts target
          ON target.id = al.target_id
          AND target.organization_id = ${input.organizationId}::uuid
        WHERE al.organization_id = ${input.organizationId}::uuid
          AND ${input.targetSql}
          AND (${input.sessionArtifactIds === undefined} OR al.source_id = ANY(${input.sessionArtifactIds ?? []}::uuid[]))
          AND (${input.sessionSearch === undefined} OR strpos(${relatedSessionSearchHaystack()}, lower(${input.sessionSearch ?? ""})) > 0)
          AND al.link_type = ${LinkType.RelatesTo}::"LinkType"
      ),
      classified_links AS (
        SELECT
          "targetId",
          "sessionArtifactId",
          "occurredAt",
          "createdAt",
          CASE
            WHEN "statedBranchParticipation" = ${BranchParticipationKind.Wrote}
              THEN ${ProvenanceRelationshipKind.Contribution}
            WHEN "statedBranchParticipation" = ${BranchParticipationKind.Reviewed}
              THEN ${ProvenanceRelationshipKind.Comment}
            WHEN "sessionPrMetadataValid"
              AND metadata->>'branchParticipation' = ${BranchParticipationKind.Wrote}
              THEN ${ProvenanceRelationshipKind.Contribution}
            WHEN "sessionPrMetadataValid"
              AND metadata->>'branchParticipation' = ${BranchParticipationKind.Reviewed}
              THEN ${ProvenanceRelationshipKind.Comment}
            WHEN "sessionPrMetadataValid"
              AND jsonb_typeof(metadata->'relationTypes') = 'array'
              AND (metadata->'relationTypes') ? ${SessionPrRelationType.Created}
              THEN ${ProvenanceRelationshipKind.Contribution}
            WHEN "sessionPrMetadataValid"
              AND jsonb_typeof(metadata->'relationTypes') = 'array'
              AND (metadata->'relationTypes') ? ${SessionPrRelationType.Reviewed}
              THEN ${ProvenanceRelationshipKind.Comment}
            WHEN "classificationMetadataValid"
              AND metadata->>'relation' IN (
              ${ArtifactRefRelation.Created},
              ${ArtifactRefRelation.Output}
            )
              THEN ${ProvenanceRelationshipKind.Contribution}
            WHEN "classificationMetadataValid"
              AND metadata->>'relation' = ${ArtifactRefRelation.Reviewed}
              THEN ${ProvenanceRelationshipKind.Comment}
            WHEN "sessionPrMetadataValid"
              AND (
                metadata->>'method' = ${ArtifactRefMethod.PrReviewFeedbackCommand}
              OR EXISTS (
                SELECT 1
                FROM jsonb_array_elements(
                  CASE
                    WHEN jsonb_typeof(metadata->'branchLifecycleEvents') = 'array'
                      THEN metadata->'branchLifecycleEvents'
                    ELSE '[]'::jsonb
                  END
                ) AS lifecycle_event
                WHERE lifecycle_event->>'kind' = ${BranchLifecycleBoundaryKind.ReviewFeedback}
              )
              )
              THEN ${ProvenanceRelationshipKind.Comment}
            ELSE NULL
          END AS kind
        FROM candidate_links
      )`;
}
