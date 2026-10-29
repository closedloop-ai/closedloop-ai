/**
 * @file trace-comment-target-lookup.ts
 * @description ISS-8200: resolving a trace comment's legacy target, extracted
 * from the trace-comment service.
 *
 * A real seam rather than a line-count slice: deciding WHICH artifact a comment
 * is about is a separate responsibility from writing, listing and mutating the
 * comments once that artifact is known — and `service.ts` is over the 1,000-line
 * ceiling, so the lane this ticket changes moves out rather than adding to it.
 *
 * The identity rule is the shared one. `target.id` for a session arrives as an
 * `externalSessionId` off the wire, and the session ingest stores that column
 * PROJECTED (ISS-8069) or, for a pre-existing row, under the raw value it
 * deliberately preserves. Matching the wire value by equality resolved neither,
 * so a comment on exactly the sessions ISS-8069 re-keyed reported its target as
 * not found.
 */
import type { BranchTraceCommentCollectionQuery } from "@repo/api/src/types/comment";
import {
  CommentSurface,
  CommentTargetType,
  type TraceCommentTarget,
} from "@repo/api/src/types/comment";
import { ArtifactType, withDb } from "@repo/database";
import { computeTargetsService } from "@/app/compute-targets/service";
import { resolveByAnyIndexKey } from "@/lib/index-key-lookup";
import { isUuid } from "@/lib/is-uuid";
import { resolveProductBranchArtifactId } from "./trace-comment-product-read";

export type TraceCommentTargetRecord = {
  artifactId: string;
  target: TraceCommentTarget;
  surface: CommentSurface;
};

export type TraceCommentTargetInput = {
  organizationId: string;
  userId: string;
  clerkUserId?: string | null;
  target: TraceCommentTarget;
  surface?: BranchTraceCommentCollectionQuery["surface"];
  computeTargetId?: string | null;
};

/** A legacy target, resolved to its org-scoped artifact and surface. */
export function resolveTraceCommentTarget(
  input: TraceCommentTargetInput
): Promise<TraceCommentTargetRecord | null> {
  if (input.target.type === CommentTargetType.Session) {
    return resolveSessionTraceCommentTarget(input);
  }
  return resolveBranchTraceCommentTarget(input);
}

async function resolveBranchTraceCommentTarget(input: {
  organizationId: string;
  target: TraceCommentTarget;
  surface?: BranchTraceCommentCollectionQuery["surface"];
}): Promise<TraceCommentTargetRecord | null> {
  const surface = input.surface ?? CommentSurface.BranchDetail;
  const artifactId = await withDb((db) =>
    resolveProductBranchArtifactId(db, {
      organizationId: input.organizationId,
      targetId: input.target.id,
    })
  );
  return artifactId
    ? {
        artifactId,
        target: input.target,
        surface,
      }
    : null;
}

export async function resolveSessionTraceCommentTarget(input: {
  organizationId: string;
  userId: string;
  clerkUserId?: string | null;
  target: TraceCommentTarget;
  computeTargetId?: string | null;
}): Promise<TraceCommentTargetRecord | null> {
  // ISS-11190: `artifact_id` is `@db.Uuid` and Postgres raises on a non-UUID,
  // so an external id (`opencode-…`) must skip this probe to reach its fallback.
  const byArtifactId = isUuid(input.target.id)
    ? await withDb((db) =>
        db.sessionDetail.findFirst({
          where: {
            artifactId: input.target.id,
            artifact: {
              is: {
                organizationId: input.organizationId,
                type: ArtifactType.SESSION,
              },
            },
          },
          select: { artifactId: true },
        })
      )
    : null;
  if (byArtifactId) {
    return {
      artifactId: byArtifactId.artifactId,
      target: input.target,
      surface: CommentSurface.SessionDetail,
    };
  }

  const computeTargetId = input.computeTargetId ?? null;
  if (computeTargetId) {
    const ownedTarget = await computeTargetsService.findOwnedById(
      computeTargetId,
      input.organizationId,
      input.userId,
      input.clerkUserId ?? null
    );
    if (!ownedTarget) {
      return null;
    }

    const byComputeTargetExternalId = await resolveByAnyIndexKey(
      input.target.id,
      (candidate) =>
        withDb((db) =>
          db.sessionDetail.findFirst({
            where: {
              computeTargetId,
              externalSessionId: candidate,
              artifact: {
                is: {
                  organizationId: input.organizationId,
                  type: ArtifactType.SESSION,
                },
              },
            },
            select: { artifactId: true },
          })
        )
    );
    if (byComputeTargetExternalId) {
      return {
        artifactId: byComputeTargetExternalId.record.artifactId,
        target: input.target,
        surface: CommentSurface.SessionDetail,
      };
    }
  }

  const scoped = await resolveByAnyIndexKey(input.target.id, (candidate) =>
    withDb((db) =>
      db.sessionDetail.findFirst({
        where: {
          externalSessionId: candidate,
          // ISS-12251 (PLN-2176 D-4): the caller's own uploads, by Created by.
          artifact: {
            is: {
              organizationId: input.organizationId,
              type: ArtifactType.SESSION,
              createdById: input.userId,
            },
          },
        },
        orderBy: [{ lastSyncedAt: "desc" }, { artifactId: "desc" }],
        select: { artifactId: true },
      })
    )
  );
  if (scoped) {
    return {
      artifactId: scoped.record.artifactId,
      target: input.target,
      surface: CommentSurface.SessionDetail,
    };
  }

  return null;
}
