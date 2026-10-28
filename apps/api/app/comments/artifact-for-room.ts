import { parseDocumentRoomId } from "@repo/collaboration/shared/room-utils";
import { withDb } from "@repo/database";

/**
 * Parse roomId to find the associated artifact entity and the document's
 * current `latestVersion` (used as a fallback when stamping
 * `CommentThread.createdAtVersion`). Returns null for non-artifact rooms
 * or when the artifact is not found. `latestVersion` is null when the
 * artifact exists but has no `Document` row (e.g. branch artifacts) so
 * callers can distinguish "no document" from "document at v1".
 */
export async function findArtifactForRoom(
  organizationId: string,
  roomId: string
): Promise<{ artifactId: string; latestVersion: number | null } | null> {
  const slug = parseArtifactRoomSlug(roomId);
  if (slug === null) {
    return null;
  }

  // A failed lookup propagates, so a webhook fails and is retried instead of
  // being recorded as a room with no artifact.
  const artifact = await withDb((db) =>
    db.artifact.findUnique({
      where: { organizationId_slug: { organizationId, slug } },
      select: { id: true, document: { select: { latestVersion: true } } },
    })
  );

  if (!artifact) {
    return null;
  }

  return {
    artifactId: artifact.id,
    latestVersion: artifact.document?.latestVersion ?? null,
  };
}

function parseArtifactRoomSlug(roomId: string): string | null {
  try {
    return parseDocumentRoomId(roomId).slug;
  } catch {
    // Non-artifact room format — expected, not an error
    return null;
  }
}
