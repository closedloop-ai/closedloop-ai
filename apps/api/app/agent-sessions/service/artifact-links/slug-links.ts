import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import { LinkType } from "@repo/api/src/types/artifact";
import type { SyncedArtifactRef } from "@repo/api/src/types/session-artifact-link";
import {
  ArtifactRefTargetKind,
  isHigherPrecedenceArtifactRole,
  roleFromMethod,
  SessionArtifactLinkKind,
} from "@repo/api/src/types/session-artifact-link";
import { chunksOf } from "@/lib/chunks-of";
import { parseProtoSafeJsonObject } from "@/lib/json-schema";
import {
  SessionPrLinkAudience,
  sessionPrLinkKindWhere,
} from "@/lib/session-pr-links";
import { normalizeNullableString } from "../coercion";
import type { AgentSessionUpsertTx } from "../records";
import { bindParameterChunkSize } from "../write-chunking";

/**
 * Batch-resolve Closedloop artifact slugs across all sessions in a sync
 * payload. Returns a Map<slug, artifactUUID> for efficient per-session lookups.
 */
export async function resolveArtifactSlugMap(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  sessions: readonly SyncedAgentSession[]
): Promise<Map<string, string>> {
  const distinctSlugs = new Set<string>();
  for (const session of sessions) {
    if (!session.artifactRefs) {
      continue;
    }
    for (const ref of session.artifactRefs) {
      if (ref.kind !== ArtifactRefTargetKind.ClosedloopArtifact) {
        continue;
      }
      const slug = normalizeNullableString(ref.slug);
      if (slug) {
        distinctSlugs.add(slug);
      }
    }
  }

  if (distinctSlugs.size === 0) {
    return new Map();
  }

  const resolved = await tx.artifact.findMany({
    where: {
      organizationId,
      slug: { in: [...distinctSlugs] },
    },
    select: { id: true, slug: true },
  });

  const slugMap = new Map<string, string>();
  for (const artifact of resolved) {
    if (artifact.slug) {
      slugMap.set(artifact.slug, artifact.id);
    }
  }
  return slugMap;
}

/**
 * Merge multiple artifact refs that target the same slug within a single
 * session. The highest-precedence role wins (input > referenced > workspace),
 * and isPrimary is OR-aggregated.
 */
export function mergeArtifactRefsBySlug(
  refs: readonly SyncedArtifactRef[]
): Map<string, MergedSlugRef> {
  const merged = new Map<string, MergedSlugRef>();
  for (const ref of refs) {
    // Only closedloop-slug refs resolve through the slug map; branch/PR kinds
    // are handled by their own ingest lanes.
    if (ref.kind !== ArtifactRefTargetKind.ClosedloopArtifact) {
      continue;
    }
    const slug = normalizeNullableString(ref.slug);
    if (!slug) {
      continue;
    }

    const role = roleFromMethod(ref.method, ref.isPrimary);
    const existing = merged.get(slug);
    if (!existing) {
      merged.set(slug, {
        isPrimary: ref.isPrimary,
        method: ref.method,
        role,
        // FEA-2729: carry the extractor's honest relation when supplied.
        ...(ref.relation ? { relation: ref.relation } : {}),
        ...(ref.observedAt ? { observedAt: ref.observedAt } : {}),
      });
      continue;
    }
    // OR-aggregate isPrimary
    existing.isPrimary = existing.isPrimary || ref.isPrimary;
    // Higher precedence role wins
    if (isHigherPrecedenceArtifactRole(role, existing.role)) {
      existing.role = role;
      existing.method = ref.method;
    }
    if (ref.relation && !existing.relation) {
      existing.relation = ref.relation;
    }
    mergeRefObservedAt(existing, ref.observedAt);
  }
  return merged;
}

/** Preserve existing metadata and advance contribution time only from session evidence. */
export async function persistArtifactLinks(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  sessionArtifactId: string,
  artifactRefs: SyncedArtifactRef[] | undefined,
  slugMap: Map<string, string>,
  sessionContributedAt: Date
): Promise<void> {
  // `undefined` means the client didn't send refs (older Desktop builds,
  // chunked/partial payloads) — leave existing links untouched. An explicit
  // empty array means "this session references nothing", so stale links must
  // be removed below.
  if (artifactRefs === undefined) {
    return;
  }

  const merged = mergeArtifactRefsBySlug(artifactRefs);
  const unresolvedRefs: string[] = [];
  const resolvedTargetIds = new Set<string>();

  for (const slug of merged.keys()) {
    const resolvedId = slugMap.get(slug);
    if (!resolvedId) {
      unresolvedRefs.push(slug);
      continue;
    }
    if (resolvedId === sessionArtifactId) {
      continue;
    }
    resolvedTargetIds.add(resolvedId);
  }

  // Replacement semantics: drop any existing session→artifact links whose
  // target is no longer referenced (covers the empty-array case, which deletes
  // them all). Scoped to RELATES_TO edges from this session. Excludes the
  // links managed by the other ingest lanes — session_pr
  // (persistSessionPrArtifactLinks) and session_branch
  // (persistSessionBranchArtifactLinks) — so this slug-path replacement never
  // clobbers a branch/PR link (FEA-2729).
  await tx.artifactLink.deleteMany({
    where: {
      organizationId,
      sourceId: sessionArtifactId,
      linkType: LinkType.RelatesTo,
      NOT: {
        OR: [
          // ISS-5823 Evidence: this NOT-guard must cover prose-derived rows too,
          // or the slug lane's replacement sweep would delete them.
          sessionPrLinkKindWhere(SessionPrLinkAudience.Evidence),
          {
            metadata: {
              path: ["linkKind"],
              equals: SessionArtifactLinkKind.SessionBranch,
            },
          },
          // ISS-12552: evidence links belong to the evidence lane. The match is
          // on a value those rows always carry, so a row with no linkKind is
          // treated exactly as before (ISS-10088 tracks that sweep).
          {
            metadata: {
              path: ["linkKind"],
              equals: SessionArtifactLinkKind.SessionEvidence,
            },
          },
        ],
      },
      ...(resolvedTargetIds.size > 0
        ? { targetId: { notIn: [...resolvedTargetIds] } }
        : {}),
    },
  });

  const rows = [...merged]
    .flatMap(([slug, ref]) => {
      const targetId = slugMap.get(slug);
      return !targetId || targetId === sessionArtifactId
        ? []
        : [
            {
              organizationId,
              sourceId: sessionArtifactId,
              targetId,
              linkType: LinkType.RelatesTo,
              lastContributedAt: toRefContributedAt(
                ref.observedAt,
                sessionContributedAt
              ),
              metadata: {
                role: ref.role,
                method: ref.method,
                isPrimary: ref.isPrimary,
                ...(ref.relation ? { relation: ref.relation } : {}),
              },
            },
          ];
    })
    .sort((left, right) => left.targetId.localeCompare(right.targetId));
  // Same set-write pattern as branch-materialization-retry: deterministic insert
  // order prevents overlapping batches taking unique-key locks in reverse order.
  for (const chunk of chunksOf(rows, bindParameterChunkSize(9, 0))) {
    await tx.artifactLink.createMany({ data: chunk, skipDuplicates: true });
    // ISS-12552: one statement also merges the slug lane's legacy role,
    // method and relation onto a pair the evidence lane linked first, so the
    // legacy classification of the pair matches a store without evidence links.
    await tx.$executeRaw`
      UPDATE artifact_links AS link
      SET last_contributed_at = CASE
            WHEN link.last_contributed_at IS NULL
              OR link.last_contributed_at < incoming.contributed_at
            THEN incoming.contributed_at
            ELSE link.last_contributed_at
          END,
          metadata = CASE
            WHEN link.metadata ->> 'linkKind' = ${SessionArtifactLinkKind.SessionEvidence}
            THEN link.metadata || incoming.metadata
            ELSE link.metadata
          END
      FROM unnest(${chunk.map((row) => row.targetId)}::uuid[],
                  ${chunk.map((row) => row.lastContributedAt.toISOString())}::timestamp[],
                  ${chunk.map((row) => JSON.stringify(row.metadata))}::jsonb[])
        AS incoming(target_id, contributed_at, metadata)
      WHERE link.organization_id = ${organizationId}::uuid
        AND link.source_id = ${sessionArtifactId}::uuid
        AND link.target_id = incoming.target_id
        AND link.link_type = ${LinkType.RelatesTo}::"LinkType"
        AND (link.last_contributed_at IS NULL
          OR link.last_contributed_at < incoming.contributed_at
          OR link.metadata ->> 'linkKind' = ${SessionArtifactLinkKind.SessionEvidence})
    `;
  }

  // Persist unresolved slugs in session metadata for debugging/future resolution
  if (unresolvedRefs.length > 0) {
    const detail = await tx.sessionDetail.findUnique({
      where: { artifactId: sessionArtifactId },
      select: { metadata: true },
    });
    // ISS-10177: proto-safe, because the update below rewrites this blob whole.
    // The lossy parser would drop an own `__proto__` key ingest preserved, on
    // the first session that also carries an unresolved slug.
    const currentMetadata = parseProtoSafeJsonObject(detail?.metadata) ?? {};
    const existingUnresolved = Array.isArray(
      currentMetadata._unresolvedArtifactRefs
    )
      ? (currentMetadata._unresolvedArtifactRefs as string[])
      : [];
    const mergedUnresolved = [
      ...new Set([...existingUnresolved, ...unresolvedRefs]),
    ];
    await tx.sessionDetail.update({
      where: { artifactId: sessionArtifactId },
      data: {
        metadata: {
          ...currentMetadata,
          _unresolvedArtifactRefs: mergedUnresolved,
        },
      },
      select: { artifactId: true },
    });
  }
}

/**
 * One session's merged view of the refs naming a single slug: the winning role
 * and the evidence behind it, plus the LATEST instant any of them was observed.
 *
 * `observedAt` is the wire string verbatim rather than a `Date`, so the merge
 * compares what the desktop actually sent and a ref carrying no instant stays
 * distinguishable from one carrying an unparseable one.
 */
type MergedSlugRef = {
  isPrimary: boolean;
  method: string;
  role: string;
  relation?: string;
  observedAt?: string;
};

/**
 * The instant to record for one edge: the ref's own `observedAt` when the
 * desktop stated a usable one, else the session-grain fallback.
 *
 * An unparseable string falls back rather than persisting `Invalid Date` — a
 * timestamp column is valid-or-absent, and the fallback is a real session
 * instant, so nothing here can write a value that is not a time.
 */
function toRefContributedAt(
  observedAt: string | undefined,
  sessionContributedAt: Date
): Date {
  if (observedAt === undefined) {
    return sessionContributedAt;
  }
  const parsed = new Date(observedAt);
  return Number.isNaN(parsed.getTime()) ? sessionContributedAt : parsed;
}

/**
 * Fold one ref's `observedAt` into the slug's merged view, LATEST-wins.
 *
 * The opposite rule to the role/relation fields beside it, which are
 * precedence- and first-wins: several refs can name the same slug within one
 * session, and the contribution time is the newest of them, not the first seen.
 * The sibling branch lane (`branch-links.ts`) merges its own `observedAt` by
 * exactly this rule, so the two recency facts cannot drift.
 */
function mergeRefObservedAt(
  existing: MergedSlugRef,
  observedAt: string | undefined
): void {
  if (!observedAt) {
    return;
  }
  if (
    !existing.observedAt ||
    Date.parse(observedAt) > Date.parse(existing.observedAt)
  ) {
    existing.observedAt = observedAt;
  }
}
