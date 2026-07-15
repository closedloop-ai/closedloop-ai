import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import { LinkType } from "@repo/api/src/types/artifact";
import type { SyncedArtifactRef } from "@repo/api/src/types/session-artifact-link";
import {
  ArtifactRefTargetKind,
  SessionArtifactLinkKind,
} from "@repo/api/src/types/session-artifact-link";
import { getPrismaErrorCode } from "@/lib/db-utils";
import { parseJsonObject } from "@/lib/json-schema";
import { normalizeNullableString } from "../coercion";
import type { AgentSessionUpsertTx } from "../records";

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

/** Role precedence for merging duplicate artifact refs: input > referenced > workspace. */
const ROLE_PRECEDENCE: Record<string, number> = {
  input: 0,
  referenced: 1,
  workspace: 2,
};

/**
 * Derive a semantic role from the extraction method. The sync contract does
 * not carry the extractor's `relation` field, so we reconstruct the best
 * role from the method string which is always present.
 */
export function roleFromMethod(method: string, isPrimary: boolean): string {
  if (isPrimary) {
    return "input";
  }
  switch (method) {
    case "mcp_tool_call":
    case "launch_metadata":
      return "input";
    case "slug_in_branch":
    case "slug_in_cwd":
    case "slug_in_session_slug":
      return "workspace";
    default:
      return "referenced";
  }
}

/**
 * Merge multiple artifact refs that target the same slug within a single
 * session. The highest-precedence role wins (input > referenced > workspace),
 * and isPrimary is OR-aggregated.
 */
export function mergeArtifactRefsBySlug(
  refs: readonly SyncedArtifactRef[]
): Map<
  string,
  { isPrimary: boolean; method: string; role: string; relation?: string }
> {
  const merged = new Map<
    string,
    { isPrimary: boolean; method: string; role: string; relation?: string }
  >();
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
      });
      continue;
    }
    // OR-aggregate isPrimary
    existing.isPrimary = existing.isPrimary || ref.isPrimary;
    // Higher precedence role wins
    if (
      (ROLE_PRECEDENCE[role] ?? 99) < (ROLE_PRECEDENCE[existing.role] ?? 99)
    ) {
      existing.role = role;
      existing.method = ref.method;
    }
    if (ref.relation && !existing.relation) {
      existing.relation = ref.relation;
    }
  }
  return merged;
}

/**
 * Create ArtifactLink edges from a session artifact to referenced Closedloop
 * artifacts. Unresolved slugs are accumulated into SessionDetail.metadata
 * under `_unresolvedArtifactRefs`.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: slug resolution + link upsert + metadata merge is inherently branchy
export async function persistArtifactLinks(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  sessionArtifactId: string,
  artifactRefs: SyncedArtifactRef[] | undefined,
  slugMap: Map<string, string>
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
        ],
      },
      ...(resolvedTargetIds.size > 0
        ? { targetId: { notIn: [...resolvedTargetIds] } }
        : {}),
    },
  });

  for (const [slug, ref] of merged) {
    const resolvedId = slugMap.get(slug);
    if (!resolvedId) {
      continue;
    }

    // Skip self-links (session referencing itself)
    if (resolvedId === sessionArtifactId) {
      continue;
    }

    const existing = await tx.artifactLink.findFirst({
      where: {
        sourceId: sessionArtifactId,
        targetId: resolvedId,
        linkType: LinkType.RelatesTo,
      },
      select: { id: true },
    });

    if (!existing) {
      try {
        await tx.artifactLink.create({
          data: {
            organizationId,
            sourceId: sessionArtifactId,
            targetId: resolvedId,
            linkType: LinkType.RelatesTo,
            metadata: {
              role: ref.role,
              method: ref.method,
              isPrimary: ref.isPrimary,
              // FEA-2729: carry the extractor's honest relation when present.
              ...(ref.relation ? { relation: ref.relation } : {}),
            },
          },
        });
      } catch (e: unknown) {
        // P2002: unique constraint violation from concurrent sync — swallow
        if (getPrismaErrorCode(e) === "P2002") {
          /* swallow */
        } else {
          throw e;
        }
      }
    }
  }

  // Persist unresolved slugs in session metadata for debugging/future resolution
  if (unresolvedRefs.length > 0) {
    const detail = await tx.sessionDetail.findUnique({
      where: { artifactId: sessionArtifactId },
      select: { metadata: true },
    });
    const currentMetadata = parseJsonObject(detail?.metadata) ?? {};
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
    });
  }
}
