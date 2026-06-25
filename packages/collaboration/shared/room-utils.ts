export function generateDocumentRoomId(
  organizationId: string,
  slug: string
): string {
  // Keep "artifact" segment in room IDs — Liveblocks room IDs are immutable
  // and constructed on every access, so changing this would break all existing rooms.
  return `${organizationId}:artifact:${slug}`;
}

export function parseDocumentRoomId(roomId: string): {
  organizationId: string;
  slug: string;
} {
  const parts = roomId.split(":");

  if (
    parts.length !== 3 ||
    (parts[1] !== "document" && parts[1] !== "artifact")
  ) {
    throw new Error("Invalid room ID format");
  }

  return {
    organizationId: parts[0],
    slug: parts[2],
  };
}

/**
 * @deprecated Use `parseDocumentRoomId` instead.
 */
export const parseArtifactRoomId = parseDocumentRoomId;
