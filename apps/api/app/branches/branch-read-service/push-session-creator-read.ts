import { ArtifactType, type PrismaClient } from "@repo/database";
import { chunksOf } from "@/lib/chunks-of";
import { SESSION_USAGE_BRANCH_ID_CHUNK_SIZE } from "./session-usage-link-read";

export type PushSessionCreatorClient = Pick<PrismaClient, "artifact">;

/**
 * The person behind each captured push: the pushing session's creator,
 * `artifacts.created_by_id`, keyed by session artifact id.
 *
 * ISS-12251 (operator ruling, Kerensa Whitlock 2026-10-13): the Branch Owner's push
 * rung names the person who pushed, and reassigning the pushing session must
 * not change it. The session's assignee is its Owner for the session-level
 * surfaces only, so this reads `created_by_id` (D-2 retired
 * `session_detail.user_id` as the person) and mirrors
 * `observedPushOwnerSql` in `branch-session-identity-sql.ts`.
 *
 * A separate statement from the session-usage link read, so the ISS-10826
 * pinned statement keeps its approved text. No statement for an empty list.
 */
export async function readPushSessionCreators(
  db: PushSessionCreatorClient,
  organizationId: string,
  sessionIds: readonly string[]
): Promise<Map<string, string | null>> {
  const chunks = await Promise.all(
    chunksOf([...new Set(sessionIds)], SESSION_USAGE_BRANCH_ID_CHUNK_SIZE).map(
      (ids) =>
        db.artifact.findMany({
          where: {
            organizationId,
            type: ArtifactType.SESSION,
            id: { in: ids },
          },
          select: { id: true, createdById: true },
        })
    )
  );
  return new Map(chunks.flat().map((row) => [row.id, row.createdById]));
}
